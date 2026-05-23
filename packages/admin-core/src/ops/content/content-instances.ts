// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.0 — `content_instances` ops.
 *
 * A `content_instances` row carries the values that fill a module's
 * `{{fieldName}}` placeholders. Identity is row-level, not placement-level:
 * two placements of the same module can bind to the SAME content_instances
 * row (sync_mode='synced'), so editing the row propagates to every page
 * referencing it. Per CLAUDE.md §11, the default actorScope is
 * `["human", "ai", "system"]` for all 5 CRUD ops — content edits are
 * routine, not gated.
 *
 * The only escalation is `content_instances.delete` with N>0 placements:
 * direct delete returns a structured error pointing the AI at the
 * propose/execute flow (lands in v0.12.0.1 per CLAUDE.md §11.A). Direct
 * delete with zero placements is allowed.
 *
 * Branch isolation: writes during a chat are tagged with
 * `ctx.chatBranchId` and emit a `content_instance_snapshots` row only —
 * the live row is NOT touched until `chat.publish` merges the branch.
 * Reads use `branchVisibilityFilter(ctx)` so a chat sees its own
 * branched-create rows immediately.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  contentInstanceCreateSchema,
  contentInstanceDeleteSchema,
  contentInstanceUpdateSchema,
  err,
  forkPlacementContentSchema,
  moduleRefSchema,
  ok,
  setPlacementContentSchema,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { branchVisibilityFilter } from "../../branch.js";
import { checkAndAcquireEntityLock, lockedError } from "../../locks.js";
import {
  emitSnapshot,
  loadContentInstanceState,
  loadContentInstanceStateWithBranchOverlay,
  loadPageLayoutState,
} from "../../snapshots/index.js";

// ─── Row shape returned by reads ─────────────────────────────────────

const contentInstancePlacementSchema = z.object({
  pageId: z.string(),
  pageSlug: z.string(),
  pageTitle: z.string(),
  blockName: z.string(),
  position: z.number().int(),
  syncMode: z.enum(["synced", "unsynced"]),
});

const contentInstanceRowSchema = z.object({
  id: z.string(),
  moduleId: z.string(),
  moduleSlug: z.string(),
  moduleDisplayName: z.string(),
  /** v0.12.0 — module's coarse role tag; lets the AI's content-library
   *  block group instances by what they represent (chrome vs hero etc). */
  moduleKind: z.enum(["chrome", "hero", "content", "cta", "utility"]).optional(),
  slug: z.string().nullable(),
  displayName: z.string().nullable(),
  /** v0.12.0 — why this row exists as a shared instance. */
  purpose: z.string().nullable(),
  values: z.record(z.string(), z.unknown()),
  version: z.number().int().nonnegative(),
  placementCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

type ContentInstanceRowSql = {
  id: string;
  module_id: string;
  module_slug: string;
  module_display_name: string;
  module_kind?: string | null;
  slug: string | null;
  display_name: string | null;
  purpose?: string | null;
  values: unknown;
  version: number | string;
  placement_count: number | string;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at: string | Date | null;
};

function iso(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * v0.12.1 — validate nested-module-ref shapes in `values` against the
 * module's declared `fields[]`. Catches:
 *
 *   - A `module` / `module-list` field whose value isn't the expected
 *     `{ moduleId, contentInstanceId }` shape.
 *   - A nested ref pointing at a non-existent or soft-deleted module
 *     or content_instance.
 *   - A nested ref whose content_instance is for a different module
 *     than the field/list element declares.
 *   - A `module-list` whose array size violates declared min/max.
 *   - A `module` field whose value is missing entirely (required).
 *
 * Returns `{ ok: true }` if every nested ref is valid (or no nested
 * fields exist); otherwise `{ ok: false, message }` naming the
 * offending field so the AI's recovery is one round-trip.
 */
async function validateNestedRefs(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  moduleId: string,
  values: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  // Read the owning module's fields schema. Skip if module not found —
  // the caller already validated that.
  const modRows = (await tx.execute(sql`
    SELECT fields FROM modules WHERE id = ${moduleId}::uuid LIMIT 1
  `)) as unknown as { fields: unknown }[];
  if (modRows.length === 0) return { ok: true };
  const rawFields =
    typeof modRows[0]?.fields === "string" ? JSON.parse(modRows[0].fields) : modRows[0]?.fields;
  if (!Array.isArray(rawFields)) return { ok: true };

  type Field = {
    name: string;
    kind: string;
    allowedModuleSlugs?: string[];
    min?: number;
    max?: number;
  };
  const fields: Field[] = rawFields.filter(
    (f): f is Field =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as { name?: unknown }).name === "string" &&
      typeof (f as { kind?: unknown }).kind === "string",
  );

  // v0.12.1 — per-primitive-kind shape checks. Catches AI shape errors
  // at write time (e.g. number field gets a non-numeric string) instead
  // of letting the renderer silently String()-coerce them. We only
  // validate kinds where the right shape is unambiguous — `text` /
  // `richtext` / `image` / `link` accept varied legitimate values
  // (objects, strings) and over-validating would block valid edits.
  for (const f of fields) {
    if (f.kind !== "number" && f.kind !== "boolean" && f.kind !== "url") continue;
    const v = values[f.name];
    if (v === undefined || v === null) continue; // optional — falls back to default
    if (f.kind === "number") {
      const ok =
        typeof v === "number" ||
        (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
      if (!ok) {
        return {
          ok: false,
          message: `field "${f.name}" (kind=number) expects a number or numeric string; got ${JSON.stringify(v)}`,
        };
      }
    } else if (f.kind === "boolean") {
      const ok =
        typeof v === "boolean" || (typeof v === "string" && (v === "true" || v === "false"));
      if (!ok) {
        return {
          ok: false,
          message: `field "${f.name}" (kind=boolean) expects true|false or "true"|"false"; got ${JSON.stringify(v)}`,
        };
      }
    } else if (f.kind === "url") {
      // Permissive URL shape — paths, absolute URLs, mailto/tel, and
      // fragment-only links all legitimate. Reject only obviously-not-
      // a-URL primitives (numbers, booleans, empty strings).
      const ok =
        typeof v === "string" &&
        v.length > 0 &&
        (v.startsWith("/") ||
          v.startsWith("http://") ||
          v.startsWith("https://") ||
          v.startsWith("mailto:") ||
          v.startsWith("tel:") ||
          v.startsWith("#"));
      if (!ok) {
        return {
          ok: false,
          message: `field "${f.name}" (kind=url) expects a relative path, absolute URL, mailto:, tel:, or #-fragment string; got ${JSON.stringify(v)}`,
        };
      }
    }
  }

  // Collect every (moduleId, contentInstanceId) pair the values declare
  // so we can batch-fetch existence + module-match in one query each.
  const refsToCheck: {
    fieldName: string;
    index: number | null;
    ref: { moduleId: string; contentInstanceId: string };
  }[] = [];
  for (const f of fields) {
    if (f.kind === "module") {
      const v = values[f.name];
      if (v === undefined || v === null) continue; // optional — render emits comment
      const parsed = moduleRefSchema.safeParse(v);
      if (!parsed.success) {
        return {
          ok: false,
          message: `field "${f.name}" (kind=module) expects { moduleId, contentInstanceId }; got ${JSON.stringify(v)}`,
        };
      }
      refsToCheck.push({ fieldName: f.name, index: null, ref: parsed.data });
    } else if (f.kind === "module-list") {
      const v = values[f.name];
      if (v === undefined || v === null) {
        if (f.min !== undefined && f.min > 0) {
          return {
            ok: false,
            message: `field "${f.name}" (kind=module-list) is missing; declared min=${f.min}`,
          };
        }
        continue;
      }
      if (!Array.isArray(v)) {
        return {
          ok: false,
          message: `field "${f.name}" (kind=module-list) expects an array; got ${typeof v}`,
        };
      }
      if (f.min !== undefined && v.length < f.min) {
        return {
          ok: false,
          message: `field "${f.name}" has ${v.length} item(s); declared min=${f.min}`,
        };
      }
      if (f.max !== undefined && v.length > f.max) {
        return {
          ok: false,
          message: `field "${f.name}" has ${v.length} item(s); declared max=${f.max}`,
        };
      }
      for (let i = 0; i < v.length; i += 1) {
        const el = v[i];
        const parsed = moduleRefSchema.safeParse(el);
        if (!parsed.success) {
          return {
            ok: false,
            message: `field "${f.name}"[${i}] expects { moduleId, contentInstanceId }; got ${JSON.stringify(el)}`,
          };
        }
        refsToCheck.push({ fieldName: f.name, index: i, ref: parsed.data });
      }
    }
  }
  if (refsToCheck.length === 0) return { ok: true };

  // Verify every referenced module + content_instance exists, isn't
  // soft-deleted, and the content_instance.module_id matches the
  // referenced module_id.
  const allInstanceIds = [...new Set(refsToCheck.map((r) => r.ref.contentInstanceId))];
  const ciRows = (await tx.execute(sql`
    SELECT id::text AS id, module_id::text AS module_id, deleted_at
    FROM content_instances
    WHERE id IN (${sql.join(
      allInstanceIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `)) as unknown as { id: string; module_id: string; deleted_at: Date | null }[];
  const ciMap = new Map(ciRows.map((r) => [r.id, r]));

  const allModuleIds = [...new Set(refsToCheck.map((r) => r.ref.moduleId))];
  const modRows2 = (await tx.execute(sql`
    SELECT id::text AS id, slug, deleted_at
    FROM modules
    WHERE id IN (${sql.join(
      allModuleIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `)) as unknown as { id: string; slug: string; deleted_at: Date | null }[];
  const moduleMap = new Map(modRows2.map((r) => [r.id, r]));

  for (const c of refsToCheck) {
    const m = moduleMap.get(c.ref.moduleId);
    const where = c.index === null ? c.fieldName : `${c.fieldName}[${c.index}]`;
    if (!m || m.deleted_at !== null) {
      return {
        ok: false,
        message: `field "${where}" references module ${c.ref.moduleId} which does not exist or is deleted`,
      };
    }
    const ci = ciMap.get(c.ref.contentInstanceId);
    if (!ci || ci.deleted_at !== null) {
      return {
        ok: false,
        message: `field "${where}" references content_instance ${c.ref.contentInstanceId} which does not exist or is deleted`,
      };
    }
    if (ci.module_id !== c.ref.moduleId) {
      return {
        ok: false,
        message: `field "${where}" content_instance ${c.ref.contentInstanceId} is for module ${ci.module_id}, but the ref declares module ${c.ref.moduleId}`,
      };
    }
    // allowedModuleSlugs whitelist (when present, the renderer enforces
    // at runtime but we mirror it at write time for the AI's benefit).
    const declared = fields.find((f) => f.name === c.fieldName);
    if (declared?.allowedModuleSlugs && declared.allowedModuleSlugs.length > 0) {
      if (!declared.allowedModuleSlugs.includes(m.slug)) {
        return {
          ok: false,
          message: `field "${where}" module slug "${m.slug}" is not in allowedModuleSlugs [${declared.allowedModuleSlugs.join(", ")}]`,
        };
      }
    }
  }
  return { ok: true };
}

function rowToContentInstance(r: ContentInstanceRowSql): z.infer<typeof contentInstanceRowSchema> {
  const rawValues = typeof r.values === "string" ? JSON.parse(r.values) : r.values;
  const moduleKindRaw =
    r.module_kind === "chrome" ||
    r.module_kind === "hero" ||
    r.module_kind === "content" ||
    r.module_kind === "cta" ||
    r.module_kind === "utility"
      ? r.module_kind
      : undefined;
  return {
    id: r.id,
    moduleId: r.module_id,
    moduleSlug: r.module_slug,
    moduleDisplayName: r.module_display_name,
    moduleKind: moduleKindRaw,
    slug: r.slug,
    displayName: r.display_name,
    purpose: r.purpose ?? null,
    values: (rawValues ?? {}) as Record<string, unknown>,
    version: typeof r.version === "string" ? Number.parseInt(r.version, 10) : r.version,
    placementCount:
      typeof r.placement_count === "string"
        ? Number.parseInt(r.placement_count, 10)
        : r.placement_count,
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
    deletedAt: iso(r.deleted_at),
  };
}

// ─── content_instances.list ──────────────────────────────────────────

export const listContentInstancesOp = defineOperation({
  name: "content_instances.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      moduleId: z.string().uuid().optional(),
      slug: z.string().min(1).max(64).optional(),
      search: z.string().min(1).max(128).optional(),
      pageId: z.string().uuid().optional(),
      includeDeleted: z.boolean().default(false),
    })
    .strict(),
  output: z.object({ instances: z.array(contentInstanceRowSchema) }),
  handler: async (ctx, input, tx) => {
    // v0.12.2 — `chat_branch_id` exists on BOTH content_instances and
    // modules; this query joins both so the helper's unqualified
    // `chat_branch_id` filter is ambiguous to the planner. Inline the
    // ci-qualified equivalent here rather than touching the shared
    // helper (other callers don't join modules).
    const branchFilter = ctx.chatBranchId
      ? sql` AND (ci.chat_branch_id IS NULL OR ci.chat_branch_id = ${ctx.chatBranchId}::uuid)`
      : sql` AND ci.chat_branch_id IS NULL`;
    const moduleFilter = input.moduleId ? sql`AND ci.module_id = ${input.moduleId}::uuid` : sql``;
    const slugFilter = input.slug ? sql`AND ci.slug = ${input.slug}` : sql``;
    const searchFilter = input.search
      ? sql`AND (ci.display_name ILIKE ${`%${input.search}%`} OR ci.slug ILIKE ${`%${input.search}%`})`
      : sql``;
    const pageFilter = input.pageId
      ? sql`AND EXISTS (SELECT 1 FROM page_modules pm WHERE pm.content_instance_id = ci.id AND pm.page_id = ${input.pageId}::uuid)`
      : sql``;
    const deletedFilter = input.includeDeleted ? sql`` : sql`AND ci.deleted_at IS NULL`;

    const rows = (await tx.execute(sql`
      SELECT
        ci.id::text AS id,
        ci.module_id::text AS module_id,
        m.slug AS module_slug,
        m.display_name AS module_display_name,
        m.kind AS module_kind,
        ci.slug,
        ci.display_name,
        ci.purpose,
        ci."values" AS values,
        ci.version,
        ci.created_at,
        ci.updated_at,
        ci.deleted_at,
        (SELECT COUNT(*) FROM page_modules pm WHERE pm.content_instance_id = ci.id)::int
          AS placement_count
      FROM content_instances ci
      JOIN modules m ON m.id = ci.module_id
      WHERE 1=1
        ${branchFilter}
        ${deletedFilter}
        ${moduleFilter}
        ${slugFilter}
        ${searchFilter}
        ${pageFilter}
      ORDER BY ci.created_at ASC
    `)) as unknown as ContentInstanceRowSql[];

    return ok({ instances: rows.map(rowToContentInstance) });
  },
});

// ─── content_instances.get ───────────────────────────────────────────

export const getContentInstanceOp = defineOperation({
  name: "content_instances.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ id: z.string().uuid() }).strict(),
  output: z.object({
    instance: contentInstanceRowSchema,
    placements: z.array(contentInstancePlacementSchema),
  }),
  handler: async (ctx, input, tx) => {
    // v0.12.2 — ci ⨝ modules both have chat_branch_id; qualify with `ci.`
    // to avoid the planner ambiguity that the shared helper triggers.
    // Same pattern as content_instances.list.
    const branchFilter = ctx.chatBranchId
      ? sql` AND (ci.chat_branch_id IS NULL OR ci.chat_branch_id = ${ctx.chatBranchId}::uuid)`
      : sql` AND ci.chat_branch_id IS NULL`;
    const rows = (await tx.execute(sql`
      SELECT
        ci.id::text AS id,
        ci.module_id::text AS module_id,
        m.slug AS module_slug,
        m.display_name AS module_display_name,
        m.kind AS module_kind,
        ci.slug,
        ci.display_name,
        ci.purpose,
        ci."values" AS values,
        ci.version,
        ci.created_at,
        ci.updated_at,
        ci.deleted_at,
        (SELECT COUNT(*) FROM page_modules pm WHERE pm.content_instance_id = ci.id)::int
          AS placement_count
      FROM content_instances ci
      JOIN modules m ON m.id = ci.module_id
      WHERE ci.id = ${input.id}::uuid ${branchFilter}
      LIMIT 1
    `)) as unknown as ContentInstanceRowSql[];
    const r = rows[0];
    if (!r) {
      return err({
        kind: "HandlerError",
        operation: "content_instances.get",
        message: "content_instance not found",
      });
    }
    const placements = (await tx.execute(sql`
      SELECT
        pm.page_id::text AS page_id,
        p.slug AS page_slug,
        p.title AS page_title,
        pm.block_name,
        pm.position,
        pm.sync_mode
      FROM page_modules pm
      JOIN pages p ON p.id = pm.page_id
      WHERE pm.content_instance_id = ${input.id}::uuid
        AND p.deleted_at IS NULL
      ORDER BY p.slug ASC, pm.block_name ASC, pm.position ASC
    `)) as unknown as {
      page_id: string;
      page_slug: string;
      page_title: string;
      block_name: string;
      position: number;
      sync_mode: "synced" | "unsynced";
    }[];
    return ok({
      instance: rowToContentInstance(r),
      placements: placements.map((p) => ({
        pageId: p.page_id,
        pageSlug: p.page_slug,
        pageTitle: p.page_title,
        blockName: p.block_name,
        position: p.position,
        syncMode: p.sync_mode,
      })),
    });
  },
});

// ─── content_instances.create ────────────────────────────────────────

export const createContentInstanceOp = defineOperation({
  name: "content_instances.create",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: contentInstanceCreateSchema,
  output: z.object({ contentInstanceId: z.string() }),
  handler: async (ctx, input, tx) => {
    // Verify the referenced module exists + isn't soft-deleted, and is
    // visible to the caller's branch (chats can create instances of
    // their own branched-create modules).
    const branchFilter = branchVisibilityFilter(ctx);
    const moduleRows = (await tx.execute(sql`
      SELECT id::text AS id FROM modules
      WHERE id = ${input.moduleId}::uuid AND deleted_at IS NULL ${branchFilter}
      LIMIT 1
    `)) as unknown as { id: string }[];
    if (!moduleRows[0]) {
      return err({
        kind: "HandlerError",
        operation: "content_instances.create",
        message: `module ${input.moduleId} not found`,
      });
    }

    // Slug uniqueness within (moduleId, branch namespace). Per-branch
    // uniqueness so two chats can both claim the same slug temporarily;
    // chat.publish resolves by promoting one branch into main.
    if (input.slug !== undefined) {
      const dupNamespace = ctx.chatBranchId ?? "00000000-0000-0000-0000-000000000000";
      const dup = (await tx.execute(sql`
        SELECT 1 FROM content_instances
        WHERE module_id = ${input.moduleId}::uuid
          AND slug = ${input.slug}
          AND deleted_at IS NULL
          AND COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = ${dupNamespace}::uuid
        LIMIT 1
      `)) as unknown as { exists: number }[];
      if (dup.length > 0) {
        await recordAudit(tx, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: "content_instances.create",
          input,
          succeeded: false,
          resultSummary: "slug-already-exists",
        });
        return err({
          kind: "HandlerError",
          operation: "content_instances.create",
          message: `slug "${input.slug}" already in use for this module`,
        });
      }
    }

    // v0.12.1 — validate nested-module-ref shapes against the module's
    // declared fields[] BEFORE persisting so bad refs fail at write time
    // with an actionable error (not at render time as missingSlots).
    const refValidation = await validateNestedRefs(tx, input.moduleId, input.values);
    if (!refValidation.ok) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "content_instances.create",
        input,
        succeeded: false,
        resultSummary: `nested-ref-validation: ${refValidation.message}`,
      });
      return err({
        kind: "HandlerError",
        operation: "content_instances.create",
        message: refValidation.message,
      });
    }

    const valuesJson = JSON.stringify(input.values);
    const rows = (await tx.execute(sql`
      INSERT INTO content_instances
        (module_id, slug, display_name, purpose, "values", updated_by, chat_branch_id)
      VALUES (
        ${input.moduleId}::uuid,
        ${input.slug ?? null},
        ${input.displayName ?? null},
        ${input.purpose ?? null},
        ${valuesJson}::jsonb,
        ${ctx.actorId}::uuid,
        ${ctx.chatBranchId ?? null}::uuid
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const contentInstanceId = rows[0]?.id;
    if (!contentInstanceId) {
      return err({
        kind: "HandlerError",
        operation: "content_instances.create",
        message: "no id returned",
      });
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "content_instances.create",
      input,
      succeeded: true,
      entityId: contentInstanceId,
      resultSummary: `moduleId=${input.moduleId}${input.slug ? ` slug=${input.slug}` : ""}`,
    });

    const state = await loadContentInstanceState(tx, contentInstanceId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "content_instances.create",
        description: `content_instances.create moduleId=${input.moduleId}${input.slug ? ` slug=${input.slug}` : ""}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
        entities: [{ kind: "contentInstance", entityId: contentInstanceId, state }],
      });
    }

    return ok({ contentInstanceId });
  },
});

// ─── content_instances.set_values ────────────────────────────────────

async function countPlacements(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  contentInstanceId: string,
): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT COUNT(*)::int AS n FROM page_modules
    WHERE content_instance_id = ${contentInstanceId}::uuid
  `)) as unknown as { n: number | string }[];
  const n = rows[0]?.n ?? 0;
  return typeof n === "string" ? Number.parseInt(n, 10) : n;
}

/**
 * v0.12.2 — fetch up to `limit` distinct pages that reference this
 * content_instance via a placement, so the delete-refusal error body
 * can name them inline (saves the AI a discovery round-trip per
 * CLAUDE.md §11 "failure surfaces are AI-actionable"). Deduped on
 * page_id because one page can carry multiple placements of the same
 * shared instance.
 */
async function listAffectedPagesForCi(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  contentInstanceId: string,
  limit: number,
): Promise<{ slug: string; title: string }[]> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT p.slug, p.title
    FROM page_modules pm
    JOIN pages p ON p.id = pm.page_id
    WHERE pm.content_instance_id = ${contentInstanceId}::uuid
    ORDER BY p.slug ASC
    LIMIT ${limit}
  `)) as unknown as { slug: string; title: string }[];
  return rows;
}

export const setContentInstanceValuesOp = defineOperation({
  name: "content_instances.set_values",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: contentInstanceUpdateSchema,
  output: z.object({
    placementCount: z.number().int().nonnegative(),
    version: z.number().int().positive(),
  }),
  handler: async (ctx, input, tx) => {
    // Per-instance lock so two chats can't simultaneously rewrite a
    // shared instance. Mirrors modules.update's lock contract.
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "contentInstance",
      entityId: input.id,
      chatBranchId: ctx.chatBranchId,
    });
    if (!lock.permitted && lock.holder) {
      return err(
        await lockedError(
          tx,
          "content_instances.set_values",
          "contentInstance",
          input.id,
          lock.holder,
        ),
      );
    }

    // Load current state (branch-aware so chained edits see the latest
    // branched snapshot, not the stale live row).
    const branchId = ctx.chatBranchId ?? null;
    const prev = branchId
      ? await loadContentInstanceStateWithBranchOverlay(tx, input.id, branchId)
      : await loadContentInstanceState(tx, input.id);
    if (!prev || prev.deletedAt !== null) {
      return err({
        kind: "HandlerError",
        operation: "content_instances.set_values",
        message: "content_instance not found",
      });
    }
    if (input.expectedVersion !== undefined && prev.version !== input.expectedVersion) {
      return err({
        kind: "HandlerError",
        operation: "content_instances.set_values",
        message: `Conflict: expected version ${input.expectedVersion}, found ${prev.version}`,
      });
    }

    // v0.12.1 — validate nested-module-ref shapes against the owning
    // module's fields[] so bad refs fail at write time, not render time.
    const refValidation = await validateNestedRefs(tx, prev.moduleId, input.values);
    if (!refValidation.ok) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "content_instances.set_values",
        input,
        succeeded: false,
        entityId: input.id,
        resultSummary: `nested-ref-validation: ${refValidation.message}`,
      });
      return err({
        kind: "HandlerError",
        operation: "content_instances.set_values",
        message: refValidation.message,
      });
    }

    const valuesJson = JSON.stringify(input.values);
    const nextVersion = prev.version + 1;

    if (!branchId) {
      // Live write — touches the canonical row. Optional slug + displayName
      // edits are applied in the same UPDATE so the rename op surface stays
      // collapsed into set_values (one op, one snapshot).
      const slugSet = input.slug !== undefined ? sql`, slug = ${input.slug}` : sql``;
      const displayNameSet =
        input.displayName !== undefined ? sql`, display_name = ${input.displayName}` : sql``;
      // v0.12.0 — purpose may be set or cleared (null) by the operator
      // when they want to repurpose a shared instance.
      const purposeSet = input.purpose !== undefined ? sql`, purpose = ${input.purpose}` : sql``;
      await tx.execute(sql`
        UPDATE content_instances
        SET "values" = ${valuesJson}::jsonb,
            version = ${nextVersion},
            updated_at = now(),
            updated_by = ${ctx.actorId}::uuid
            ${slugSet}
            ${displayNameSet}
            ${purposeSet}
        WHERE id = ${input.id}::uuid
      `);
    }
    // For branched writes, the snapshot below carries the new state;
    // live row stays untouched until chat.publish merges.

    const placementCount = await countPlacements(tx, input.id);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "content_instances.set_values",
      input,
      succeeded: true,
      entityId: input.id,
      resultSummary: `placementCount=${placementCount}${branchId ? " (branch)" : ""}`,
    });

    const state = branchId
      ? {
          schemaVersion: 1 as const,
          moduleId: prev.moduleId,
          slug: input.slug === undefined ? prev.slug : input.slug,
          displayName: input.displayName === undefined ? prev.displayName : input.displayName,
          values: input.values,
          version: nextVersion,
          deletedAt: null,
        }
      : await loadContentInstanceState(tx, input.id);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "content_instances.set_values",
        description: `content_instances.set_values id=${input.id}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: branchId,
        entities: [{ kind: "contentInstance", entityId: input.id, state }],
      });
    }

    return ok({ placementCount, version: nextVersion });
  },
});

// ─── content_instances.delete ────────────────────────────────────────

export const deleteContentInstanceOp = defineOperation({
  name: "content_instances.delete",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: contentInstanceDeleteSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "contentInstance",
      entityId: input.id,
      chatBranchId: ctx.chatBranchId,
    });
    if (!lock.permitted && lock.holder) {
      return err(
        await lockedError(tx, "content_instances.delete", "contentInstance", input.id, lock.holder),
      );
    }

    const rows = (await tx.execute(sql`
      SELECT deleted_at FROM content_instances WHERE id = ${input.id}::uuid
    `)) as unknown as { deleted_at: Date | null }[];
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "content_instances.delete",
        message: "content_instance not found",
      });
    }
    if (target.deleted_at !== null) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "content_instances.delete",
        input,
        succeeded: true,
        entityId: input.id,
        resultSummary: "already-deleted",
      });
      return ok({});
    }

    const placementCount = await countPlacements(tx, input.id);
    if (placementCount > 0) {
      // Per CLAUDE.md §11.A — a hard-to-revert action (cascade across
      // many pages) needs a propose/execute gate. The gated variant
      // lands in v0.12.0.1; for now, surface the blast radius + the
      // recovery path. The AI's tool description carries the same
      // contract.
      //
      // v0.12.2 — name the top-3 affected pages inline so the AI can
      // discover the placements without a follow-up
      // get_content_instance call (CLAUDE.md §11 "failure surfaces are
      // AI-actionable").
      const affectedPages = await listAffectedPagesForCi(tx, input.id, 3);
      const samples = affectedPages.map((p) => `/${p.slug}`).join(", ");
      const moreSuffix = placementCount > affectedPages.length ? `, …` : "";
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "content_instances.delete",
        input,
        succeeded: false,
        entityId: input.id,
        resultSummary: `blocked: placementCount=${placementCount}`,
      });
      return err({
        kind: "HandlerError",
        operation: "content_instances.delete",
        message: `cannot delete: ${placementCount} placement(s) reference this content_instance${samples ? ` (on ${samples}${moreSuffix})` : ""}. Detach each placement first via fork_placement_content, OR (v0.12.0.1+) submit a propose_delete_content_instance proposal so the Owner can approve the cascade.`,
        nextAction: {
          tool: "fork_placement_content",
          args: {},
          reason:
            "detach each referencing placement into its own private content_instance before deleting",
        },
      });
    }

    await tx.execute(sql`
      UPDATE content_instances
      SET deleted_at = now(),
          updated_by = ${ctx.actorId}::uuid
      WHERE id = ${input.id}::uuid
    `);

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "content_instances.delete",
      input,
      succeeded: true,
      entityId: input.id,
      resultSummary: "soft-deleted",
    });

    const state = await loadContentInstanceState(tx, input.id);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "content_instances.delete",
        description: `content_instances.delete id=${input.id}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
        entities: [{ kind: "contentInstance", entityId: input.id, state }],
      });
    }
    return ok({});
  },
});

// ─── placement.set_content ───────────────────────────────────────────

/**
 * Bind a placement to a content_instance + choose sync mode. Direct write
 * to live `page_modules.content_instance_id` + `page_modules.sync_mode`
 * for the page-level binding row. For branched callers, the change rides
 * via the existing `pages.set_modules` flow (the AI calls add/remove/move
 * module tools which use that op); this op is the explicit "rebind only"
 * surface so the operator can flip a placement to a shared instance
 * without rewriting the whole layout.
 *
 * Branch isolation: the page lock guards the placement row; concurrent
 * chats can't both rebind the same placement. For chat-branched callers,
 * the binding write IS routed through a page_layout_snapshot — same
 * pattern as pages.set_modules — so the visible-to-this-chat overlay
 * sees the new binding and publish merge applies it atomically with
 * any other layout changes.
 */
export const setPlacementContentOp = defineOperation({
  name: "placement.set_content",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: setPlacementContentSchema,
  output: z.object({ contentInstanceId: z.string() }),
  handler: async (ctx, input, tx) => {
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "page",
      entityId: input.pageId,
      chatBranchId: ctx.chatBranchId,
    });
    if (!lock.permitted && lock.holder) {
      return err(await lockedError(tx, "placement.set_content", "page", input.pageId, lock.holder));
    }

    // Verify the placement exists (live; for branched callers, the
    // page-set-modules op is the right tool for placements that exist
    // only in a branch snapshot).
    const placementRows = (await tx.execute(sql`
      SELECT module_id::text AS module_id
      FROM page_modules
      WHERE page_id = ${input.pageId}::uuid
        AND block_name = ${input.blockName}
        AND position = ${input.position}
      LIMIT 1
    `)) as unknown as { module_id: string }[];
    const placement = placementRows[0];
    if (!placement) {
      return err({
        kind: "HandlerError",
        operation: "placement.set_content",
        message: `no placement at (${input.blockName}, ${input.position}) on page ${input.pageId}`,
        nextAction: {
          tool: "inspect_page_render",
          args: { pageId: input.pageId },
          reason:
            "fetch the page's actual blocks + placements; pick a (blockName, position) pair that exists and retry",
        },
      });
    }

    // Verify the target content_instance exists, isn't deleted, and is
    // for the same module as the placement (FK + business-rule check).
    // v0.12.0+ — apply branchVisibilityFilter so the caller can only
    // bind to content_instances on main OR their own chat branch. Without
    // this, a chat could bind one of its placements to another chat's
    // branched-create content_instance — which would materialise on the
    // OTHER chat's publish and surprise that chat's operator. Mirror
    // the read-side guard already used by content_instances.get +
    // create's module-id check.
    const branchFilter = branchVisibilityFilter(ctx);
    const ciRows = (await tx.execute(sql`
      SELECT module_id::text AS module_id, deleted_at
      FROM content_instances
      WHERE id = ${input.contentInstanceId}::uuid ${branchFilter}
      LIMIT 1
    `)) as unknown as { module_id: string; deleted_at: Date | null }[];
    const ci = ciRows[0];
    if (!ci || ci.deleted_at !== null) {
      return err({
        kind: "HandlerError",
        operation: "placement.set_content",
        message: "content_instance not found or deleted",
      });
    }
    if (ci.module_id !== placement.module_id) {
      return err({
        kind: "HandlerError",
        operation: "placement.set_content",
        message: `content_instance ${input.contentInstanceId} is for module ${ci.module_id}, but the placement uses module ${placement.module_id}. Pick a content_instance for the placement's module.`,
      });
    }

    // Branched callers route through pages.set_modules. For routine
    // direct (non-branched) callers, update the live row.
    if (!ctx.chatBranchId) {
      await tx.execute(sql`
        UPDATE page_modules
        SET content_instance_id = ${input.contentInstanceId}::uuid,
            sync_mode = ${input.syncMode}
        WHERE page_id = ${input.pageId}::uuid
          AND block_name = ${input.blockName}
          AND position = ${input.position}
      `);
    } else {
      // Branched: re-emit the page's layout snapshot with the new
      // binding. Read current layout, swap this placement's binding,
      // emit. Mirrors how pages.set_modules constructs the branched
      // snapshot but limited to one placement.
      const layoutState = await loadPageLayoutState(tx, input.pageId);
      const nextBlocks = layoutState.blocks.map((b) => {
        if (b.blockName !== input.blockName) return b;
        const placements = (b.placements ?? []).map((p, i) =>
          i === input.position
            ? { ...p, contentInstanceId: input.contentInstanceId, syncMode: input.syncMode }
            : p,
        );
        return { ...b, placements };
      });
      const nextLayout = { schemaVersion: 1 as const, blocks: nextBlocks };
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "placement.set_content",
        description: `placement.set_content page=${input.pageId} block=${input.blockName} pos=${input.position}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId,
        entities: [{ kind: "pageLayout", entityId: input.pageId, state: nextLayout }],
      });
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "placement.set_content",
        input,
        succeeded: true,
        entityId: input.pageId,
        resultSummary: `block=${input.blockName} pos=${input.position} syncMode=${input.syncMode} (branched)`,
      });
      return ok({ contentInstanceId: input.contentInstanceId });
    }

    await tx.execute(sql`
      UPDATE pages SET updated_at = now(), version = version + 1
      WHERE id = ${input.pageId}::uuid
    `);

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "placement.set_content",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: `block=${input.blockName} pos=${input.position} syncMode=${input.syncMode}`,
    });

    const layoutState = await loadPageLayoutState(tx, input.pageId);
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "placement.set_content",
      description: `placement.set_content page=${input.pageId} block=${input.blockName} pos=${input.position}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: null,
      entities: [{ kind: "pageLayout", entityId: input.pageId, state: layoutState }],
    });

    return ok({ contentInstanceId: input.contentInstanceId });
  },
});

// ─── placement.fork_content ──────────────────────────────────────────

/**
 * Duplicate the placement's current content_instance into a fresh
 * unsynced one. Use case: a synced placement diverges (operator wants
 * to edit this page's text without affecting the other pages bound to
 * the same shared instance).
 */
export const forkPlacementContentOp = defineOperation({
  name: "placement.fork_content",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: forkPlacementContentSchema,
  output: z.object({ contentInstanceId: z.string() }),
  handler: async (ctx, input, tx) => {
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "page",
      entityId: input.pageId,
      chatBranchId: ctx.chatBranchId,
    });
    if (!lock.permitted && lock.holder) {
      return err(
        await lockedError(tx, "placement.fork_content", "page", input.pageId, lock.holder),
      );
    }

    const placementRows = (await tx.execute(sql`
      SELECT module_id::text AS module_id,
             content_instance_id::text AS content_instance_id,
             sync_mode
      FROM page_modules
      WHERE page_id = ${input.pageId}::uuid
        AND block_name = ${input.blockName}
        AND position = ${input.position}
      LIMIT 1
    `)) as unknown as {
      module_id: string;
      content_instance_id: string;
      sync_mode: "synced" | "unsynced";
    }[];
    const placement = placementRows[0];
    if (!placement) {
      return err({
        kind: "HandlerError",
        operation: "placement.fork_content",
        message: `no placement at (${input.blockName}, ${input.position}) on page ${input.pageId}`,
      });
    }

    // Read the source instance's values so the fork starts as a deep copy.
    const srcRows = (await tx.execute(sql`
      SELECT "values" AS values
      FROM content_instances
      WHERE id = ${placement.content_instance_id}::uuid
      LIMIT 1
    `)) as unknown as { values: unknown }[];
    const srcValues = srcRows[0]?.values ?? {};
    const valuesJson = typeof srcValues === "string" ? srcValues : JSON.stringify(srcValues);

    // Mint the new (unsynced) content_instance, copy values, and bind
    // the placement to it.
    const minted = (await tx.execute(sql`
      INSERT INTO content_instances
        (module_id, "values", updated_by, chat_branch_id)
      VALUES (
        ${placement.module_id}::uuid,
        ${valuesJson}::jsonb,
        ${ctx.actorId}::uuid,
        ${ctx.chatBranchId ?? null}::uuid
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const newCiId = minted[0]?.id;
    if (!newCiId) {
      return err({
        kind: "HandlerError",
        operation: "placement.fork_content",
        message: "failed to mint forked content_instance",
      });
    }

    if (!ctx.chatBranchId) {
      await tx.execute(sql`
        UPDATE page_modules
        SET content_instance_id = ${newCiId}::uuid,
            sync_mode = 'unsynced'
        WHERE page_id = ${input.pageId}::uuid
          AND block_name = ${input.blockName}
          AND position = ${input.position}
      `);
      await tx.execute(sql`
        UPDATE pages SET updated_at = now(), version = version + 1
        WHERE id = ${input.pageId}::uuid
      `);
    }

    // Emit a content_instance snapshot for the new row (so revert + audit
    // see the fork) plus a pageLayout snapshot reflecting the rebound
    // placement.
    const ciState = await loadContentInstanceState(tx, newCiId);
    const layoutState = await loadPageLayoutState(tx, input.pageId);
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "placement.fork_content",
      description: `placement.fork_content page=${input.pageId} block=${input.blockName} pos=${input.position}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: ctx.chatBranchId ?? null,
      entities: [
        ...(ciState
          ? [{ kind: "contentInstance" as const, entityId: newCiId, state: ciState }]
          : []),
        { kind: "pageLayout", entityId: input.pageId, state: layoutState },
      ],
    });

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "placement.fork_content",
      input,
      succeeded: true,
      entityId: input.pageId,
      resultSummary: `newCi=${newCiId} block=${input.blockName} pos=${input.position}`,
    });

    return ok({ contentInstanceId: newCiId });
  },
});
