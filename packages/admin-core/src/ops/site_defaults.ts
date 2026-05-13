// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 — site_defaults singleton (one row, id = 1). Stores the
 * default layout + template that pages.create / templates.create
 * resolve when the caller doesn't specify. Per CLAUDE.md §2 the
 * renderer never substitutes — site_defaults is a *create-time*
 * resolver, not a render-time fallback.
 *
 * Writes are open to AI per CLAUDE.md §11.A: the only side-effect of
 * a defaults change is "future creates that omit the explicit ids
 * resolve to the new defaults" — existing pages and templates retain
 * their pinned `template_id`/`layout_id` columns, so changing
 * site_defaults can't break already-published content. The write is
 * also fully snapshot-revertable (audit row + the prior values are
 * recoverable from `audit_events`). The propose/execute gate (§11.A)
 * is overkill for first-run config where there's no published surface
 * to protect; AI proceeds directly + the operator sees the change in
 * the chat transcript and can revert if wrong.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { checkAndAcquireEntityLock, lockedError } from "../locks.js";

const siteDefaultsRow = z.object({
  defaultLayoutId: z.string(),
  defaultLayoutSlug: z.string(),
  defaultTemplateId: z.string(),
  defaultTemplateSlug: z.string(),
  updatedAt: z.string(),
});

export const getSiteDefaultsOp = defineOperation({
  name: "site_defaults.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ defaults: siteDefaultsRow.nullable() }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        sd.default_layout_id::text   AS default_layout_id,
        l.slug                        AS default_layout_slug,
        sd.default_template_id::text AS default_template_id,
        t.slug                        AS default_template_slug,
        sd.updated_at                 AS updated_at
      FROM site_defaults sd
      JOIN layouts l   ON l.id   = sd.default_layout_id
      JOIN templates t ON t.id   = sd.default_template_id
      WHERE sd.id = 1
      LIMIT 1
    `)) as unknown as {
      default_layout_id: string;
      default_layout_slug: string;
      default_template_id: string;
      default_template_slug: string;
      updated_at: string | Date;
    }[];
    const r = rows[0];
    if (!r) return ok({ defaults: null });
    return ok({
      defaults: {
        defaultLayoutId: r.default_layout_id,
        defaultLayoutSlug: r.default_layout_slug,
        defaultTemplateId: r.default_template_id,
        defaultTemplateSlug: r.default_template_slug,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      },
    });
  },
});

export const setSiteDefaultsOp = defineOperation({
  name: "site_defaults.set",
  // AI-writable per §11.A reasoning above (existing content unaffected;
  // change is snapshot-revertable; first-run UX requires it).
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      defaultLayoutId: z.string().uuid(),
      defaultTemplateId: z.string().uuid(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    // v0.5.3 — singleton lock. site_defaults is one row; two chats
    // setting different defaults would silently clobber.
    // SiteDefaults' primary key is the int '1', but locks key on uuid;
    // use a stable namespace UUID derived from the constant 'global'.
    const SITE_DEFAULTS_LOCK_ID = "00000000-0000-0000-0000-000000c5d4f7";
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "siteDefaults",
      entityId: SITE_DEFAULTS_LOCK_ID,
      chatBranchId: ctx.chatBranchId,
    });
    if (!lock.permitted && lock.holder) {
      return err(
        lockedError("site_defaults.set", "siteDefaults", SITE_DEFAULTS_LOCK_ID, lock.holder),
      );
    }
    const layoutOk = (await tx.execute(sql`
      SELECT 1 FROM layouts
      WHERE id = ${input.defaultLayoutId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (layoutOk.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "site_defaults.set",
        message: "default layout not found or deleted",
      });
    }
    const tplOk = (await tx.execute(sql`
      SELECT 1 FROM templates
      WHERE id = ${input.defaultTemplateId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (tplOk.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "site_defaults.set",
        message: "default template not found or deleted",
      });
    }
    // v0.5.16 — site_defaults.id is `int GENERATED ALWAYS AS IDENTITY`
    // with a singleton CHECK (id = 1). Postgres rejects explicit values
    // on GENERATED ALWAYS columns unless OVERRIDING SYSTEM VALUE is
    // present. The seed migration (0023) uses it; this runtime INSERT
    // was missing it. Symptom: site_defaults.set failed on every fresh
    // install that hadn't received the seed row (any layout slug !=
    // 'site-default'). Matching the seed shape closes the gap.
    await tx.execute(sql`
      INSERT INTO site_defaults (id, default_layout_id, default_template_id, updated_by)
      OVERRIDING SYSTEM VALUE
      VALUES (1, ${input.defaultLayoutId}::uuid, ${input.defaultTemplateId}::uuid, ${ctx.actorId}::uuid)
      ON CONFLICT (id) DO UPDATE SET
        default_layout_id   = EXCLUDED.default_layout_id,
        default_template_id = EXCLUDED.default_template_id,
        updated_at          = now(),
        updated_by          = EXCLUDED.updated_by
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "site_defaults.set",
      input,
      succeeded: true,
      resultSummary: `layout=${input.defaultLayoutId},template=${input.defaultTemplateId}`,
    });
    return ok({});
  },
});

/**
 * Internal helper for create-time fallback (pages.create / templates.create).
 * Returns null if the singleton row hasn't been seeded yet — callers must
 * surface a structured error per the no-fallbacks invariant; never silently
 * substitute at read time.
 */
export async function readSiteDefaults(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
): Promise<{ defaultLayoutId: string; defaultTemplateId: string } | null> {
  const rows = (await tx.execute(sql`
    SELECT default_layout_id::text AS default_layout_id,
           default_template_id::text AS default_template_id
    FROM site_defaults WHERE id = 1 LIMIT 1
  `)) as unknown as { default_layout_id: string; default_template_id: string }[];
  const r = rows[0];
  if (!r) return null;
  return { defaultLayoutId: r.default_layout_id, defaultTemplateId: r.default_template_id };
}
