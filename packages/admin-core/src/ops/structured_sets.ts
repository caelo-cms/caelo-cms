// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.5 — generic named-list primitive. One table holds N kinds of
 * structured data (nav-menus, taxonomies, theme tokens, tag lists,
 * link blocks). The `kind` discriminator drives a per-kind Zod
 * validator from `@caelo/shared/structured-sets` and a per-kind
 * renderer at preview / deploy time.
 *
 * Why a single table: every named-list editor surface ends up
 * structurally identical (CRUD on a `(kind, slug, items)` triple). One
 * primitive avoids a sprawl of one-off tables and gives `change_page_slug`
 * a single place to walk when retargeting links across menus + footers
 * + taxonomies + future kinds.
 */

import type { TransactionRunner } from "@caelo/query-api";
import { defineOperation } from "@caelo/query-api";
import { err, ok, structuredSetKind, validateStructuredSetItems } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { ZodError, z } from "zod";
import { recordAudit } from "../audit.js";

const setRow = z.object({
  id: z.string(),
  kind: structuredSetKind,
  slug: z.string(),
  displayName: z.string(),
  items: z.unknown(),
  updatedAt: z.string(),
});

function describeZodIssues(e: ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
}

function rowToOut(r: {
  id: string;
  kind: string;
  slug: string;
  display_name: string;
  items: unknown;
  updated_at: string | Date;
}): z.infer<typeof setRow> {
  return {
    id: r.id,
    kind: structuredSetKind.parse(r.kind),
    slug: r.slug,
    displayName: r.display_name,
    items: typeof r.items === "string" ? JSON.parse(r.items) : r.items,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export const setStructuredSetOp = defineOperation({
  name: "structured_sets.set",
  // P6.7.5 — AI calls this via the `set_structured_set` and
  // `update_theme` tools. Per-kind Zod validation runs in the handler.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      kind: structuredSetKind,
      slug: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[a-z0-9-]+$/, "lowercase letters/digits/hyphens"),
      displayName: z.string().min(1).max(200),
      items: z.array(z.unknown()),
    })
    .strict(),
  output: z.object({ setId: z.string() }),
  handler: async (ctx, input, tx) => {
    let validated: unknown[];
    try {
      validated = validateStructuredSetItems(input.kind, input.items);
    } catch (e) {
      if (e instanceof ZodError) {
        await recordAudit(tx, {
          actorId: ctx.actorId,
          operation: "structured_sets.set",
          input,
          succeeded: false,
          resultSummary: `validation: ${describeZodIssues(e)}`,
        });
        return err({
          kind: "HandlerError",
          operation: "structured_sets.set",
          message: `items invalid for kind=${input.kind}: ${describeZodIssues(e)}`,
        });
      }
      throw e;
    }
    // Note: cast through ::text first so Bun's SQL adapter doesn't
    // try to JSON-encode the string a second time. Without ::text the
    // adapter sees the JSON-stringified value and re-wraps it as a
    // JSON string before binding, ending up with a jsonb column whose
    // top-level type is `string` instead of `array`.
    const itemsJson = JSON.stringify(validated);
    const rows = (await tx.execute(sql`
      INSERT INTO structured_sets (kind, slug, display_name, items, updated_by)
      VALUES (
        ${input.kind},
        ${input.slug},
        ${input.displayName},
        ${itemsJson}::text::jsonb,
        ${ctx.actorId}::uuid
      )
      ON CONFLICT (kind, slug) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        items        = EXCLUDED.items,
        updated_at   = now(),
        updated_by   = EXCLUDED.updated_by
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) {
      return err({ kind: "HandlerError", operation: "structured_sets.set", message: "no id" });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "structured_sets.set",
      input,
      succeeded: true,
      entityId: id,
      resultSummary: `${input.kind}/${input.slug} items=${validated.length}`,
    });
    return ok({ setId: id });
  },
});

export const getStructuredSetOp = defineOperation({
  name: "structured_sets.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      kind: structuredSetKind,
      slug: z.string().min(1).max(120),
    })
    .strict(),
  output: z.object({ set: setRow.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, slug, display_name, items, updated_at
      FROM structured_sets
      WHERE kind = ${input.kind} AND slug = ${input.slug}
      LIMIT 1
    `)) as unknown as {
      id: string;
      kind: string;
      slug: string;
      display_name: string;
      items: unknown;
      updated_at: string | Date;
    }[];
    const r = rows[0];
    return ok({ set: r ? rowToOut(r) : null });
  },
});

export const listStructuredSetsOp = defineOperation({
  name: "structured_sets.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ kind: structuredSetKind.optional() }).strict(),
  output: z.object({ sets: z.array(setRow) }),
  handler: async (_ctx, input, tx) => {
    const rows = input.kind
      ? ((await tx.execute(sql`
          SELECT id::text AS id, kind, slug, display_name, items, updated_at
          FROM structured_sets WHERE kind = ${input.kind}
          ORDER BY kind, slug
        `)) as unknown as {
          id: string;
          kind: string;
          slug: string;
          display_name: string;
          items: unknown;
          updated_at: string | Date;
        }[])
      : ((await tx.execute(sql`
          SELECT id::text AS id, kind, slug, display_name, items, updated_at
          FROM structured_sets
          ORDER BY kind, slug
        `)) as unknown as {
          id: string;
          kind: string;
          slug: string;
          display_name: string;
          items: unknown;
          updated_at: string | Date;
        }[]);
    return ok({ sets: rows.map(rowToOut) });
  },
});

export const deleteStructuredSetOp = defineOperation({
  name: "structured_sets.delete",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ setId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`DELETE FROM structured_sets WHERE id = ${input.setId}::uuid`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      operation: "structured_sets.delete",
      input,
      succeeded: true,
      entityId: input.setId,
    });
    return ok({});
  },
});

/**
 * P6.7.5 — slug-rewrite helper. Walks every nav-menu / link-list item
 * (and recursively into nav-menu children) and swaps any `href`
 * matching `oldPath` to `newPath`. Called from the page-update path
 * when the slug changes so menus stay valid in the same transaction
 * as the redirect insert.
 *
 * Path matching is exact — `oldPath = "/about-us"` doesn't touch
 * `"/about-us/team"`. That's deliberate; partial-match rewriting
 * lives in the cross-page link rewriter (P8).
 */
export async function rewriteSlugReferences(
  tx: TransactionRunner,
  oldPath: string,
  newPath: string,
): Promise<{ rewrittenSets: number }> {
  const sets = (await tx.execute(sql`
    SELECT id::text AS id, kind, items::text AS items
    FROM structured_sets
    WHERE kind IN ('nav-menu', 'link-list')
  `)) as unknown as { id: string; kind: string; items: string }[];

  let touched = 0;
  for (const s of sets) {
    const items = JSON.parse(s.items) as unknown[];
    const next = rewriteHrefsInArray(items, oldPath, newPath);
    if (next.changed) {
      // See note in setStructuredSetOp — cast through ::text first.
      const nextJson = JSON.stringify(next.items);
      await tx.execute(sql`
        UPDATE structured_sets
        SET items = ${nextJson}::text::jsonb, updated_at = now()
        WHERE id = ${s.id}::uuid
      `);
      touched += 1;
    }
  }
  return { rewrittenSets: touched };
}

interface HrefRewriteResult {
  items: unknown[];
  changed: boolean;
}

function rewriteHrefsInArray(
  items: unknown[],
  oldPath: string,
  newPath: string,
): HrefRewriteResult {
  let changed = false;
  const next = items.map((it) => {
    if (!it || typeof it !== "object") return it;
    const obj = it as Record<string, unknown>;
    const out: Record<string, unknown> = { ...obj };
    if (typeof obj["href"] === "string" && obj["href"] === oldPath) {
      out["href"] = newPath;
      changed = true;
    }
    if (Array.isArray(obj["children"])) {
      const child = rewriteHrefsInArray(obj["children"] as unknown[], oldPath, newPath);
      if (child.changed) {
        out["children"] = child.items;
        changed = true;
      }
    }
    return out;
  });
  return { items: next, changed };
}
