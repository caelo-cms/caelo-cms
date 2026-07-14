// SPDX-License-Identifier: MPL-2.0

/**
 * Module Layer ops (CMS_REQUIREMENTS §3.1, §3.2). Modules are the only place
 * raw HTML lives; pages reference them by id. AI is intentionally out of
 * scope here — `actorScope: ["human", "system"]` until P5 widens it.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  deriveModuleType,
  err,
  extractMediaRefs,
  type ModuleField,
  moduleCreateSchema,
  moduleFieldSchema,
  moduleUpdateSchema,
  ok,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { branchVisibilityFilter } from "../../branch.js";
import { checkAndAcquireEntityLock, entityWriteBlockedError } from "../../locks.js";
import {
  emitSnapshot,
  loadModuleState,
  loadModuleStateWithBranchOverlay,
} from "../../snapshots/index.js";
import { buildPatchSet, jsonbParam } from "../../sql-helpers.js";
import { extractModuleStructure, validateTemplatizedModule } from "./extract-module-structure.js";

/**
 * Diff media references between two HTML strings and apply usage-count
 * deltas. Called from create / update / delete handlers so the AI's
 * `## Media` system-prompt block surfaces frequently-used assets.
 */
async function applyMediaUsageDelta(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  prevHtml: string,
  nextHtml: string,
): Promise<void> {
  const prev = new Set(extractMediaRefs(prevHtml).map((r) => r.assetId));
  const next = new Set(extractMediaRefs(nextHtml).map((r) => r.assetId));
  const deltas = new Map<string, number>();
  for (const id of next) if (!prev.has(id)) deltas.set(id, (deltas.get(id) ?? 0) + 1);
  for (const id of prev) if (!next.has(id)) deltas.set(id, (deltas.get(id) ?? 0) - 1);
  if (deltas.size === 0) return;
  for (const [assetId, delta] of deltas) {
    await tx.execute(sql`
      UPDATE media_assets
      SET usage_count = GREATEST(0, usage_count + ${delta}),
          last_used_at = CASE WHEN ${delta} > 0 THEN now() ELSE last_used_at END
      WHERE id = ${assetId}::uuid AND deleted_at IS NULL
    `);
  }
}

const moduleRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  /** v0.12.0 — operator/AI rationale; what this module is for. */
  description: z.string(),
  /** v0.12.0 — coarse role tag for the AI's `## Modules` catalog. */
  kind: z.enum(["chrome", "hero", "content", "cta", "utility"]),
  /** v0.12.3 (issue #106) — stable semantic class; what a parent's
   *  `allowedModuleTypes` whitelist matches against (not the unique slug). */
  type: z.string(),
  html: z.string(),
  css: z.string(),
  js: z.string(),
  /** v0.4.0 — declared field schema for placement content. */
  fields: z.array(moduleFieldSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

function rowToModule(r: {
  id: string;
  slug: string;
  display_name: string;
  description?: string | null;
  kind?: string | null;
  type?: string | null;
  html: string;
  css: string;
  js: string;
  fields: unknown;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at: string | Date | null;
}): z.infer<typeof moduleRowSchema> {
  const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v));
  // `fields` arrives as jsonb. Postgres returns it as a parsed array; coerce
  // defensively for the (unlikely) string case.
  const rawFields = typeof r.fields === "string" ? JSON.parse(r.fields) : r.fields;
  const fields = Array.isArray(rawFields) ? (rawFields as ModuleField[]) : [];
  // v0.12.0 — description / kind default for legacy rows that pre-date
  // migration 0095. The migration backfills both columns NOT NULL so
  // this only matters for in-flight branched rows whose snapshot was
  // taken before the column existed.
  const kindRaw = (r.kind ?? "content") as "chrome" | "hero" | "content" | "cta" | "utility";
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    description: r.description ?? "",
    kind: kindRaw,
    // v0.12.3 — `type` is NOT NULL post-0103; fall back to slug only for
    // an in-flight branched row whose snapshot predates the column.
    type: r.type ?? r.slug,
    html: r.html,
    css: r.css,
    js: r.js,
    fields,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    deletedAt: r.deleted_at === null ? null : iso(r.deleted_at),
  };
}

/**
 * v0.12.0 — module usage signal for the AI's `## Modules`
 * decision-support block. Per CLAUDE.md §1A every domain object the
 * AI might reach for ships with usage context, not just identity —
 * so the AI sees "this header is on every product page" rather than
 * three coincidences.
 *
 * Returns one row per module that has at least one placement:
 *   - placementCount: total live placements on undeleted pages
 *   - sampleSlugs: top-3 page slugs (alphabetic for determinism)
 *
 * Modules with zero placements are omitted; the formatter renders
 * them as "unplaced". Branch isolation matches modules.list — main
 * + the caller's own branched pages.
 */
export const listModulesUsageOp = defineOperation({
  name: "modules.list_usage",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}),
  output: z.object({
    usage: z.array(
      z.object({
        moduleId: z.string(),
        placementCount: z.number().int().nonnegative(),
        sampleSlugs: z.array(z.string()),
      }),
    ),
  }),
  handler: async (ctx, _input, tx) => {
    // Branch filter on pages — chats see their own branched pages'
    // placements alongside main; system actors see main only.
    const branchFilter = ctx.chatBranchId
      ? sql` AND (p.chat_branch_id IS NULL OR p.chat_branch_id = ${ctx.chatBranchId}::uuid)`
      : sql` AND p.chat_branch_id IS NULL`;
    const rows = (await tx.execute(sql`
      SELECT
        pm.module_id::text AS module_id,
        COUNT(*)::int AS placement_count,
        (
          SELECT array_agg(DISTINCT p2.slug ORDER BY p2.slug ASC)
          FROM (
            SELECT DISTINCT p3.slug
            FROM page_modules pm3
            JOIN pages p3 ON p3.id = pm3.page_id AND p3.deleted_at IS NULL
            WHERE pm3.module_id = pm.module_id
            ${
              ctx.chatBranchId
                ? sql`AND (p3.chat_branch_id IS NULL OR p3.chat_branch_id = ${ctx.chatBranchId}::uuid)`
                : sql`AND p3.chat_branch_id IS NULL`
            }
            ORDER BY p3.slug ASC
            LIMIT 3
          ) p2
        ) AS sample_slugs
      FROM page_modules pm
      JOIN pages p ON p.id = pm.page_id AND p.deleted_at IS NULL
      WHERE 1=1 ${branchFilter}
      GROUP BY pm.module_id
    `)) as unknown as {
      module_id: string;
      placement_count: number | string;
      sample_slugs: string[] | null;
    }[];
    return ok({
      usage: rows.map((r) => ({
        moduleId: r.module_id,
        placementCount:
          typeof r.placement_count === "string"
            ? Number.parseInt(r.placement_count, 10)
            : r.placement_count,
        sampleSlugs: Array.isArray(r.sample_slugs) ? r.sample_slugs : [],
      })),
    });
  },
});

export const listModulesOp = defineOperation({
  name: "modules.list",
  // CLAUDE.md §11: read surfaces are open to AI. The AI uses this
  // to plan cross-module changes (e.g. "find every module with a
  // hero in its slug").
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ includeDeleted: z.boolean().default(false) }),
  output: z.object({ modules: z.array(moduleRowSchema) }),
  handler: async (ctx, input, tx) => {
    // v0.9.0 — branch-aware: chats see main + their own branched
    // creates; system actors / cross-chat reads see main only.
    const branchFilter = branchVisibilityFilter(ctx);
    const rows = (await tx.execute(
      input.includeDeleted
        ? sql`
            SELECT id::text AS id, slug, display_name, description, kind, type, html, css, js, fields,
                   created_at, updated_at, deleted_at
            FROM modules WHERE 1=1 ${branchFilter} ORDER BY created_at ASC
          `
        : sql`
            SELECT id::text AS id, slug, display_name, description, kind, type, html, css, js, fields,
                   created_at, updated_at, deleted_at
            FROM modules WHERE deleted_at IS NULL ${branchFilter} ORDER BY created_at ASC
          `,
    )) as unknown as Parameters<typeof rowToModule>[0][];
    return ok({ modules: rows.map(rowToModule) });
  },
});

export const getModuleOp = defineOperation({
  name: "modules.get",
  // CLAUDE.md §11: read surfaces are open to AI.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ moduleId: z.string().uuid() }),
  output: z.object({ module: moduleRowSchema }),
  handler: async (ctx, input, tx) => {
    // v0.9.0 — branch-aware read so a chat can fetch its own
    // branched-create modules immediately after creating them.
    const branchFilter = branchVisibilityFilter(ctx);
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, slug, display_name, description, kind, type, html, css, js, fields,
             created_at, updated_at, deleted_at
      FROM modules WHERE id = ${input.moduleId}::uuid ${branchFilter} LIMIT 1
    `)) as unknown as Parameters<typeof rowToModule>[0][];
    const row = rows[0];
    if (!row) {
      return err({ kind: "HandlerError", operation: "modules.get", message: "module not found" });
    }
    return ok({ module: rowToModule(row) });
  },
});

export const createModuleOp = defineOperation({
  name: "modules.create",
  // P6.7.3 — AI can create modules via the `add_module_to_page` tool
  // (and templates-fan-out variants in later phases). Same audit +
  // snapshot path as a human create, just with actor_kind=ai.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: moduleCreateSchema,
  output: z.object({
    moduleId: z.string(),
    /**
     * v0.12.2 — fields the extractor inferred from the input HTML. When
     * the AI passed un-templatised HTML (`<h1>Welcome</h1>`), the
     * extractor inserts placeholders + mints field names; the result
     * here lets the AI see what it got so a follow-up rename is one
     * call, not a guess.
     */
    extractedFields: z.array(moduleFieldSchema).optional(),
  }),
  handler: async (ctx, input, tx) => {
    // v0.12.2 — auto-templatise hardcoded content ONLY when the caller
    // didn't supply explicit fields. Callers that pass `fields` are
    // declaring intent: their HTML may already be pre-templatised
    // (existing {{name}} references aligned with the field list), OR
    // they're authoring fixture HTML where literal content is part of
    // the test (rewriter / media-usage tests need the raw <img src=…>).
    // The extractor runs as a runtime invariant only in the AI-author
    // path where fields are absent — that's where the operator's
    // ergonomic ask actually applies.
    const shouldExtract = !input.fields || input.fields.length === 0;
    const extracted = shouldExtract ? extractModuleStructure(input.html, input.fields) : null;
    const candidateHtml = extracted?.templatizedHtml ?? input.html;
    const candidateFields = (
      input.fields && input.fields.length > 0
        ? input.fields
        : extracted
          ? ([...extracted.fields] as ModuleField[])
          : []
    ) as ModuleField[];
    // Validator only fires on the extractor's output — its job is to
    // catch typo'd / orphan placeholders the extractor itself can't
    // produce. When the caller passes explicit fields with their own
    // HTML, trust them: declared-but-not-yet-referenced fields are a
    // legitimate intermediate state (the AI may add the placeholder in
    // a follow-up update; tests use literal HTML for assertion).
    if (extracted) {
      const validation = validateTemplatizedModule(candidateHtml, candidateFields);
      if (!validation.ok) {
        await recordAudit(tx, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: "modules.create",
          input,
          succeeded: false,
          resultSummary: `validation-failed: ${validation.message}`,
        });
        return err({
          kind: "HandlerError",
          operation: "modules.create",
          message: validation.message,
        });
      }
    }
    const persistedHtml = candidateHtml;
    const extractedMutable = extracted ? ([...extracted.fields] as ModuleField[]) : [];
    const persistedFields = candidateFields;
    // v0.9.0 — branch-scoped uniqueness. Same-branch slug clash
    // surfaces as the unique-index violation at INSERT below; check
    // here narrows it to a clean error. We only check the caller's
    // namespace (main if no branch; the caller's branch otherwise) —
    // the per-branch UNIQUE INDEX from migration 0089 isolates
    // cross-branch slugs.
    const dupNamespace = ctx.chatBranchId ?? "00000000-0000-0000-0000-000000000000";
    const dup = (await tx.execute(sql`
      SELECT 1 FROM modules
      WHERE slug = ${input.slug}
        AND deleted_at IS NULL
        AND COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid) = ${dupNamespace}::uuid
      LIMIT 1
    `)) as unknown as { exists: number }[];
    if (dup.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "modules.create",
        input,
        succeeded: false,
        resultSummary: "slug-already-exists",
      });
      return err({
        kind: "HandlerError",
        operation: "modules.create",
        message: "slug already in use",
      });
    }
    // v0.9.0 — branched-create. When ctx.chatBranchId is set, the row
    // is invisible to other chats until chat.merge_to_main clears the
    // tag. Same-chat reads see it via branchVisibilityFilter.
    // v0.12.0 — description + kind persisted alongside core columns.
    // Schema defaults ("" + "content") let the 82+ legacy callers keep
    // working; AI tool descriptions push the AI to pass them
    // explicitly so the `## Modules` block can render decision-support
    // context (CLAUDE.md §1A).
    // v0.12.3 (issue #106) — derive the stable `type` from displayName
    // when the caller didn't author one explicitly. Every minting path
    // (add_module_to_page/template/layout, build_page) flows
    // through here, so this single chokepoint guarantees every module
    // gets a type without each tool repeating the derivation.
    const moduleType = input.type ?? deriveModuleType(input.displayName);
    const rows = (await tx.execute(sql`
      INSERT INTO modules (slug, display_name, description, kind, type, html, css, js, fields, chat_branch_id)
      VALUES (
        ${input.slug},
        ${input.displayName},
        ${input.description},
        ${input.kind},
        ${moduleType},
        ${persistedHtml},
        ${input.css},
        ${input.js},
        ${jsonbParam(persistedFields)},
        ${ctx.chatBranchId ?? null}::uuid
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const moduleId = rows[0]?.id;
    if (!moduleId) {
      return err({
        kind: "HandlerError",
        operation: "modules.create",
        message: "no id returned",
      });
    }
    // P7 usage-tracker: a fresh module's HTML may already reference
    // existing media (AI tool, paste-from-template, etc.).
    await applyMediaUsageDelta(tx, "", persistedHtml);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "modules.create",
      input,
      succeeded: true,
      entityId: moduleId,
      resultSummary: `slug=${input.slug} extractedFields=${extracted?.fields.length ?? 0}`,
    });
    const state = await loadModuleState(tx, moduleId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "modules.create",
        description: `modules.create slug=${input.slug}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
        entities: [{ kind: "module", entityId: moduleId, state }],
      });
    }
    // v0.12.2 — surface the inferred field shape so the AI's next turn
    // sees the auto-minted names. Only when the AI didn't supply fields
    // explicitly (explicit fields = AI knows what it wants; extracted
    // would be redundant + confusing).
    const extractedForCaller =
      input.fields && input.fields.length > 0 ? undefined : extractedMutable;
    return ok({ moduleId, extractedFields: extractedForCaller });
  },
});

export const updateModuleOp = defineOperation({
  name: "modules.update",
  // P5: AI in scope for the `edit_module` tool — the only mutation the
  // AI can reach in this phase. Page / template / cross-module surfaces
  // stay AI-blocked until their tools land in later phases.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: moduleUpdateSchema,
  output: z.object({
    /**
     * v0.12.2 — same shape as modules.create — when the AI passed
     * un-templatised HTML, the extractor minted fields and we hand them
     * back so the AI's next turn can use the inferred names verbatim.
     */
    extractedFields: z.array(moduleFieldSchema).optional(),
  }),
  handler: async (ctx, input, tx) => {
    // v0.5.0 — per-entity lock. When the caller is in a chat,
    // acquire the lock for this module; reject if another chat holds
    // it. System writes (no chatBranchId) bypass.
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "module",
      entityId: input.moduleId,
      chatBranchId: ctx.chatBranchId,
      holderKey: ctx.chatTaskId,
    });
    if (!lock.permitted) {
      return err(
        await entityWriteBlockedError(tx, "modules.update", "module", input.moduleId, lock),
      );
    }
    // Fetch the FULL prev row — we need it for both the usage-diff and
    // (v0.5.1) the branched-write path where we construct the new state
    // in-memory without touching the live `modules` row.
    const prevRows = (await tx.execute(sql`
      SELECT slug, display_name, description, kind, type, html, css, js, fields, deleted_at
      FROM modules WHERE id = ${input.moduleId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as {
      slug: string;
      display_name: string;
      description: string;
      kind: string;
      type: string | null;
      html: string;
      css: string;
      js: string;
      fields: unknown;
      deleted_at: Date | string | null;
    }[];
    const prev = prevRows[0];
    if (!prev) {
      return err({
        kind: "HandlerError",
        operation: "modules.update",
        message: "module not found",
      });
    }

    // v0.12.2 — auto-extract content from new HTML ONLY when the caller
    // didn't supply explicit fields AND the live module didn't already
    // declare fields. If either is present, the caller is in control of
    // the field schema and we persist the HTML verbatim. Mirrors the
    // modules.create conservative-extraction rule above so the rewriter
    // / media-usage / chained-edit fixtures don't get their literal
    // hrefs / srcs templatised out from under them.
    const rawPrevFields = typeof prev.fields === "string" ? JSON.parse(prev.fields) : prev.fields;
    const prevFields = Array.isArray(rawPrevFields) ? (rawPrevFields as ModuleField[]) : [];
    const explicitFieldsPresent = input.fields !== undefined && input.fields.length > 0;
    const liveFieldsPresent = prevFields.length > 0;
    const shouldExtract = input.html !== undefined && !explicitFieldsPresent && !liveFieldsPresent;
    let extractedHtml = input.html;
    let extractedFields: ModuleField[] | undefined;
    let extractedSurfacedToCaller: ModuleField[] | undefined;
    if (input.html !== undefined && shouldExtract) {
      const extracted = extractModuleStructure(input.html, prevFields);
      const validation = validateTemplatizedModule(extracted.templatizedHtml, extracted.fields);
      if (!validation.ok) {
        await recordAudit(tx, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: "modules.update",
          input,
          succeeded: false,
          resultSummary: `validation-failed: ${validation.message}`,
        });
        return err({
          kind: "HandlerError",
          operation: "modules.update",
          message: validation.message,
        });
      }
      extractedHtml = extracted.templatizedHtml;
      const extractedMutable = [...extracted.fields] as ModuleField[];
      extractedFields = input.fields ?? extractedMutable;
      extractedSurfacedToCaller =
        input.fields && input.fields.length > 0 ? undefined : extractedMutable;
    }
    const persistedHtml = extractedHtml;
    const persistedFields = extractedFields ?? input.fields;

    const branchId = ctx.chatBranchId ?? null;

    // v0.5.1 — branched writes skip the live UPDATE. Module code stays
    // visible to other chats at its pre-edit state until publish merges
    // the branch into main. The snapshot carries the new state so the
    // caller's own chat preview sees the edit via the branch overlay
    // in pages.render_preview.
    if (!branchId) {
      // buildPatchSet ignores undefined keys and always appends updated_at = now().
      // v0.4.0 — `fields` is jsonb; cast via SQL fragment.
      const sets = buildPatchSet({
        display_name: input.displayName,
        description: input.description,
        kind: input.kind,
        type: input.type,
        html: persistedHtml,
        css: input.css,
        js: input.js,
        fields: persistedFields !== undefined ? sql`${jsonbParam(persistedFields)}` : undefined,
      });
      await tx.execute(sql`
        UPDATE modules SET ${sets} WHERE id = ${input.moduleId}::uuid
      `);
      // P7 usage-tracker: only diff when html changed AND we wrote live.
      // For branched writes, usage delta is applied at publish time.
      if (persistedHtml !== undefined) {
        await applyMediaUsageDelta(tx, prev.html, persistedHtml);
      }
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "modules.update",
      input,
      succeeded: true,
      entityId: input.moduleId,
      resultSummary: `fields=${[
        input.displayName !== undefined && "displayName",
        input.html !== undefined && "html",
        input.css !== undefined && "css",
        input.js !== undefined && "js",
      ]
        .filter(Boolean)
        .join(",")}${branchId ? " (branch)" : ""}`,
    });

    // For branched writes, construct the new state from the LATEST
    // branched snapshot (if any) + input; for live writes, re-load to
    // capture defaults applied by the DB.
    //
    // v0.10.0 — uses `loadModuleStateWithBranchOverlay` instead of the
    // live row. Without the overlay, chained branched edits silently
    // dropped each other's fields: edit 1 set html='B' (snapshot only,
    // live still 'A'); edit 2 read live and emitted snapshot 2 with
    // html='A' — edit 1 lost at Stage when merge applied snapshot 2.
    let state: import("../../snapshots/index.js").ModuleState | null;
    if (branchId) {
      const base = await loadModuleStateWithBranchOverlay(tx, input.moduleId, branchId);
      if (!base) {
        return err({
          kind: "HandlerError",
          operation: "modules.update",
          message: "module not found while building branched state",
        });
      }
      state = {
        ...base,
        displayName: input.displayName ?? base.displayName,
        type: input.type ?? base.type,
        html: persistedHtml ?? base.html,
        css: input.css ?? base.css,
        js: input.js ?? base.js,
        fields: persistedFields ?? base.fields,
        deletedAt: null,
      };
    } else {
      state = await loadModuleState(tx, input.moduleId);
    }

    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "modules.update",
        description: `modules.update slug=${state.slug}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: branchId,
        entities: [{ kind: "module", entityId: input.moduleId, state }],
      });
    }
    return ok({ extractedFields: extractedSurfacedToCaller });
  },
});

export const deleteModuleOp = defineOperation({
  name: "modules.delete",
  // CLAUDE.md §11: AI cleans up stale modules in routine maintenance.
  // Soft-delete only; revert via the snapshots.revert_module path.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ moduleId: z.string().uuid() }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    // v0.5.0 — per-entity lock.
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "module",
      entityId: input.moduleId,
      chatBranchId: ctx.chatBranchId,
      holderKey: ctx.chatTaskId,
    });
    if (!lock.permitted) {
      return err(
        await entityWriteBlockedError(tx, "modules.delete", "module", input.moduleId, lock),
      );
    }
    const rows = (await tx.execute(sql`
      SELECT deleted_at, html FROM modules WHERE id = ${input.moduleId}::uuid
    `)) as unknown as { deleted_at: Date | null; html: string }[];
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "modules.delete",
        message: "module not found",
      });
    }
    if (target.deleted_at !== null) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "modules.delete",
        input,
        succeeded: true,
        entityId: input.moduleId,
        resultSummary: "already-deleted",
      });
      return ok({});
    }
    await tx.execute(sql`
      UPDATE modules SET deleted_at = now() WHERE id = ${input.moduleId}::uuid
    `);
    // P7 usage-tracker: deletion drops every reference the module held.
    await applyMediaUsageDelta(tx, target.html, "");
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "modules.delete",
      input,
      succeeded: true,
      entityId: input.moduleId,
      resultSummary: "soft-deleted",
    });
    const state = await loadModuleState(tx, input.moduleId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "modules.delete",
        description: `modules.delete slug=${state.slug}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
        entities: [{ kind: "module", entityId: input.moduleId, state }],
      });
    }
    return ok({});
  },
});

// ---------------------------------------------------------------------
// modules.delete_many — bulk variant per CLAUDE.md §11. Soft-deletes
// in a single tx; the same media-usage delta runs per affected module
// so usage_count drops atomically.
// ---------------------------------------------------------------------

export const deleteModulesManyOp = defineOperation({
  name: "modules.delete_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      moduleIds: z.array(z.string().uuid()).min(1).max(200),
    })
    .strict(),
  output: z.object({
    deleted: z.number().int(),
    alreadyDeleted: z.number().int(),
    notFound: z.number().int(),
  }),
  handler: async (ctx, input, tx) => {
    let deleted = 0;
    let alreadyDeleted = 0;
    let notFound = 0;
    for (const id of input.moduleIds) {
      const rows = (await tx.execute(sql`
        SELECT deleted_at, html FROM modules WHERE id = ${id}::uuid
      `)) as unknown as { deleted_at: Date | null; html: string }[];
      const target = rows[0];
      if (!target) {
        notFound += 1;
        continue;
      }
      if (target.deleted_at !== null) {
        alreadyDeleted += 1;
        continue;
      }
      await tx.execute(sql`
        UPDATE modules SET deleted_at = now() WHERE id = ${id}::uuid
      `);
      await applyMediaUsageDelta(tx, target.html, "");
      const state = await loadModuleState(tx, id);
      if (state) {
        await emitSnapshot(tx, {
          actorId: ctx.actorId,
          opKind: "modules.delete",
          description: `modules.delete_many slug=${state.slug}`,
          chatTaskId: ctx.chatTaskId ?? null,
          chatBranchId: ctx.chatBranchId ?? null,
          entities: [{ kind: "module", entityId: id, state }],
        });
      }
      deleted += 1;
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "modules.delete_many",
      input,
      succeeded: true,
      resultSummary: `deleted=${deleted},alreadyDeleted=${alreadyDeleted},notFound=${notFound}`,
    });
    return ok({ deleted, alreadyDeleted, notFound });
  },
});

// ─── v0.2.33 bulk variant: modules.update_many ───────────────────────

/**
 * Bulk metadata edits across many modules in one tx (per CLAUDE.md §11).
 * Each item carries the same shape as modules.update (moduleId + optional
 * displayName/html/css/js). Per-item failures are reported in the
 * result; the rest of the batch still applies.
 */
export const updateModulesManyOp = defineOperation({
  name: "modules.update_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ updates: z.array(moduleUpdateSchema).min(1).max(200) }).strict(),
  output: z.object({
    updated: z.number().int(),
    notFound: z.number().int(),
    failed: z.array(z.string()),
  }),
  handler: async (ctx, input, tx) => {
    let updated = 0;
    let notFound = 0;
    const failed: string[] = [];
    for (const upd of input.updates) {
      const r = await updateModuleOp.handler(ctx, upd, tx);
      if (!r.ok) {
        const msg = (r.error as { message?: string }).message ?? "";
        if (msg.includes("not found") || msg.includes("deleted")) notFound += 1;
        else failed.push(upd.moduleId);
        continue;
      }
      updated += 1;
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "modules.update_many",
      input,
      succeeded: true,
      resultSummary: `updated=${updated},notFound=${notFound},failed=${failed.length}`,
    });
    return ok({ updated, notFound, failed });
  },
});
