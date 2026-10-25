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
 * The only refusal is `content_instances.delete` with N>0 placements:
 * deleting would strand the pages bound to the row, so the op returns a
 * structured error pointing the AI at `fork_placement_content` for each
 * referencing placement (#63). Forking keeps every page's content, so
 * detach-then-delete is routine and needs no Owner gate. Direct delete
 * with zero placements is allowed.
 *
 * Branch isolation: writes during a chat are tagged with
 * `ctx.chatBranchId` and emit a `content_instance_snapshots` row only —
 * the live row is NOT touched until `chat.publish` merges the branch.
 * Reads use `branchVisibilityFilter(ctx)` so a chat sees its own
 * branched-create rows immediately.
 */

import { defineOperation, OperationAbortError } from "@caelo-cms/query-api";
import {
  COPY_ID_EXACTLY_HINT,
  collectNestedRefs,
  contentInstanceCreateSchema,
  contentInstanceDeleteSchema,
  contentInstancesCreateManySchema,
  contentInstanceUpdateSchema,
  describeMalformedUuid,
  err,
  forkPlacementContentSchema,
  moduleRefSchema,
  ok,
  parseLinkRef,
  setPlacementContentSchema,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { branchVisibilityFilter } from "../../branch.js";
import { emitDomainEvent } from "../../domain-events.js";
import { pendingSnapshotSql } from "../../draft.js";
import { canonicaliseInstanceValues } from "../../links/canonicalise-writes.js";
import { withHumanisedLinks } from "../../links/humanise.js";
import { recordPendingImportLinks } from "../../links/import-targets.js";
import { checkAndAcquireEntityLock, entityWriteBlockedError } from "../../locks.js";
import {
  emitSnapshot,
  loadBranchedModuleStates,
  loadContentInstanceBranchStates,
  loadContentInstanceState,
  loadContentInstanceStateWithBranchOverlay,
  loadModuleStateWithBranchOverlay,
  loadPageLayoutState,
  loadPageLayoutStateWithBranchOverlay,
} from "../../snapshots/index.js";
import type { PageLayoutState } from "../../snapshots/state.js";
import { jsonbParam } from "../../sql-helpers.js";
import { findContentInstancesContaining } from "./content-instance-refs.js";

// ─── Row shape returned by reads ─────────────────────────────────────

const contentInstancePlacementSchema = z.object({
  pageId: z.string(),
  pageSlug: z.string(),
  /** The page's URL path — unique, unlike its slug (epic #690). */
  pagePath: z.string(),
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
  /** Placements bound to this instance as the caller sees them (branch view). */
  placementCount: z.number().int().nonnegative(),
  /**
   * #1067 — instances that show this one inside a `module` / `module-list`
   * field. Orphan = no placements AND no nested parents.
   */
  nestedParentCount: z.number().int().nonnegative(),
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
 *
 * Side-effect: NORMALIZES `values` in place for `kind=url` fields —
 * an empty/whitespace-only url is coerced to the safe placeholder "#"
 * (see the url branch below) so one missing link target can't abort an
 * atomic build. Callers persist `values` after this returns, so the
 * coercion is durable.
 */
async function validateNestedRefs(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  chatBranchId: string | null,
  moduleId: string,
  values: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; message: string; refusal?: true }> {
  // Read the owning module's fields schema AS THE CALLER SEES IT (#1042):
  // a chat's `edit_module` lands only in its branch snapshot, so reading
  // live `modules.fields` validated the values against main's schema — a
  // field the chat had just turned from `module` into `module-list`
  // rejected the list it now declares. Skip if module not found — the
  // caller already validated that.
  const owner = await loadModuleStateWithBranchOverlay(tx, moduleId, chatBranchId);
  if (owner === null) return { ok: true };
  const rawFields: unknown = owner.fields;
  if (!Array.isArray(rawFields)) return { ok: true };

  type Field = {
    name: string;
    kind: string;
    allowedModuleTypes?: string[];
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
      // Resilience (build_page atomicity) — an EMPTY or whitespace-only
      // url value is a MISSING link target, not an authoring error worth
      // rolling back an atomic multi-module build over (a 29-module
      // homepage was killed by one empty CTA link). Coerce it to "#" — a
      // safe no-op placeholder anchor — and accept. "#" is a resilience
      // placeholder, NOT a valid target: the internal-link integrity
      // check at stage/publish surfaces genuinely-missing targets loudly
      // and separately. We mutate `values` in place so the coerced "#"
      // persists through the caller's INSERT/UPDATE, the emitted
      // snapshot state, and the audit record — not just past validation.
      if (typeof v === "string" && v.trim() === "") {
        values[f.name] = "#";
        continue;
      }
      // Permissive URL shape — paths, absolute URLs, mailto/tel, and
      // fragment-only links all legitimate. A non-empty string that is
      // none of these is a real authoring error, kept rejected with the
      // actionable message. Non-string primitives (numbers, booleans)
      // stay rejected too.
      const ok =
        typeof v === "string" &&
        (v.startsWith("/") ||
          v.startsWith("http://") ||
          v.startsWith("https://") ||
          v.startsWith("mailto:") ||
          v.startsWith("tel:") ||
          v.startsWith("#") ||
          // Epic #724 — the stored form of an internal link.
          parseLinkRef(v) !== null);
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
        return { ok: false, message: moduleRefMessage(`field "${f.name}" (kind=module)`, v) };
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
          return { ok: false, message: moduleRefMessage(`field "${f.name}"[${i}]`, el) };
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
  const ciMap = new Map<string, { module_id: string; deleted_at: Date | string | null }>(
    ciRows.map((r) => [r.id, r]),
  );

  const allModuleIds = [...new Set(refsToCheck.map((r) => r.ref.moduleId))];
  const modRows2 = (await tx.execute(sql`
    SELECT id::text AS id, slug, type, deleted_at
    FROM modules
    WHERE id IN (${sql.join(
      allModuleIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `)) as unknown as { id: string; slug: string; type: string; deleted_at: Date | null }[];
  const moduleMap = new Map<string, { slug: string; type: string; deleted_at: unknown }>(
    modRows2.map((r) => [r.id, r]),
  );
  // Same branch view for the referenced rows: a chat's own module edits
  // (type, delete) and instance deletes live only in its snapshots.
  if (chatBranchId) {
    for (const [id, st] of await loadBranchedModuleStates(tx, chatBranchId, allModuleIds)) {
      moduleMap.set(id, { slug: st.slug, type: st.type, deleted_at: st.deletedAt });
    }
    for (const [id, st] of await loadContentInstanceBranchStates(
      tx,
      allInstanceIds,
      chatBranchId,
    )) {
      ciMap.set(id, { module_id: st.moduleId, deleted_at: st.deletedAt });
    }
  }

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
    // v0.12.3 (issue #106) — allowedModuleTypes whitelist. This is the
    // ONLY enforcement site (the renderer does NOT enforce it — the
    // stale "renderer enforces at runtime" comment that lived here was
    // wrong). Match against the referenced module's STABLE `type`, not
    // its unique `slug`: an AI-minted module's slug carries a uniqueness
    // suffix (`button-mpqxq3ch`) that could never match an authored
    // allowlist, whereas its `type` is the reusable class (`button`).
    const declared = fields.find((f) => f.name === c.fieldName);
    if (declared?.allowedModuleTypes && declared.allowedModuleTypes.length > 0) {
      if (!declared.allowedModuleTypes.includes(m.type)) {
        const allowed = declared.allowedModuleTypes.join(", ");
        return {
          ok: false,
          // #1091 — the authored allowlist working as designed: the
          // caller picks an allowed module or widens the list.
          refusal: true,
          // AI-actionable per CLAUDE.md §11.A: name the valid set + the
          // exact next step so the AI self-corrects instead of punting
          // the implementation detail to a non-technical operator (§1A).
          message:
            `field "${where}" references module "${m.slug}" (type "${m.type}"), which is not in this field's allowedModuleTypes [${allowed}]. ` +
            `Next step: reference an existing module whose type is one of [${allowed}] (\`list_modules\` shows each module's type and this field's allowedModuleTypes), ` +
            `or, if this module SHOULD be allowed here, add "${m.type}" to the field's allowedModuleTypes via edit_module on the parent module. ` +
            `Do not ask the operator to fix this — pick a valid module or widen the allowlist and retry.`,
        };
      }
    }
  }
  return { ok: true };
}

function rowToContentInstance(
  r: ContentInstanceRowSql,
  placementCount: number,
  nestedParentCount: number,
): z.infer<typeof contentInstanceRowSchema> {
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
    placementCount,
    nestedParentCount,
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
    deletedAt: iso(r.deleted_at),
  };
}

// ─── content_instances.list ──────────────────────────────────────────

export const listContentInstancesOp = withHumanisedLinks(
  defineOperation({
    name: "content_instances.list",
    // #453 — plugin actors read too. The vendor URL an embed points at
    // usually lives in a content value rather than in module HTML (the
    // extractor lifts it out at authoring time), so a plugin reasoning
    // about what a module loads cannot see it any other way. Read only;
    // the write ops stay closed to plugins.
    actorScope: ["human", "ai", "plugin", "system"],
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
      // #1045 — "instances used on this page" as the caller's branch sees
      // the page (the live `page_modules` join listed main's placements).
      let pageFilter = sql``;
      if (input.pageId) {
        const layout = await loadPageLayoutStateWithBranchOverlay(
          tx,
          input.pageId,
          ctx.chatBranchId ?? null,
        );
        const onPage = [
          ...new Set(
            layout.blocks.flatMap((b) => (b.placements ?? []).map((p) => p.contentInstanceId)),
          ),
        ];
        if (onPage.length === 0) return ok({ instances: [] });
        pageFilter = sql`AND ci.id IN (${sql.join(
          onPage.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
      }
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
        ci.deleted_at
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

      // #820 — same caller-branch overlay as content_instances.get: a
      // branched set_values lands only in content_instance_snapshots, so a
      // list without it showed pre-edit values (and the markup guard could
      // not see copies the same chat had just written).
      if (ctx.chatBranchId) {
        const states = await loadContentInstanceBranchStates(
          tx,
          rows.map((r) => r.id),
          ctx.chatBranchId,
        );
        for (const r of rows) {
          const overlay = states.get(r.id);
          if (!overlay) continue;
          r.values = overlay.values;
          r.slug = overlay.slug;
          r.display_name = overlay.displayName;
          r.version = overlay.version;
          r.deleted_at = overlay.deletedAt;
        }
      }
      const visible = input.includeDeleted ? rows : rows.filter((r) => r.deleted_at === null);
      const ids = visible.map((r) => r.id);
      const branchId = ctx.chatBranchId ?? null;
      const counts = await countPlacementsInView(tx, ids, branchId);
      const parents = await nestedParentsInView(tx, branchId, ids);

      return ok({
        instances: visible.map((r) =>
          rowToContentInstance(r, counts.get(r.id) ?? 0, parents.get(r.id)?.length ?? 0),
        ),
      });
    },
  }),
);

// ─── content_instances.get ───────────────────────────────────────────

export const getContentInstanceOp = withHumanisedLinks(
  defineOperation({
    name: "content_instances.get",
    actorScope: ["human", "ai", "system"],
    database: "cms_admin",
    input: z.object({ id: z.string().uuid() }).strict(),
    output: z.object({
      instance: contentInstanceRowSchema,
      placements: z.array(contentInstancePlacementSchema),
      /** Ids of the instances that show this one inside a module / module-list field. */
      nestedParents: z.array(z.string()),
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
        ci.deleted_at
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
      // Run #8 R3 — overlay the caller-branch snapshot state. Branched
      // `set_values` writes ONLY a content_instance_snapshots row (the live
      // row is untouched until publish), so without this overlay the AI's
      // read-back showed pre-edit values and it blindly re-edited content it
      // had already written. Same overlay helper the write path uses for
      // chained edits, so read and write see identical state.
      if (ctx.chatBranchId) {
        const overlay = await loadContentInstanceStateWithBranchOverlay(
          tx,
          input.id,
          ctx.chatBranchId,
        );
        if (overlay) {
          r.values = overlay.values;
          r.slug = overlay.slug;
          r.display_name = overlay.displayName;
          r.version = overlay.version;
          r.deleted_at = overlay.deletedAt;
        }
      }
      // #1067 — placements and nested parents as the caller's branch sees
      // them; the live `page_modules` read showed main's bindings, so a
      // chat that had just placed (or forked away) the instance read the
      // opposite of its own draft.
      const branchId = ctx.chatBranchId ?? null;
      const inView = await listPlacementsInView(tx, [input.id], branchId);
      const nestedParents =
        (await nestedParentsInView(tx, branchId, [input.id])).get(input.id) ?? [];
      return ok({
        instance: rowToContentInstance(r, inView.length, nestedParents.length),
        placements: inView
          .filter((p) => !p.pageDeleted)
          .map((p) => ({
            pageId: p.pageId,
            pageSlug: p.pageSlug,
            pagePath: p.path,
            pageTitle: p.pageTitle,
            blockName: p.blockName,
            position: p.position,
            syncMode: p.syncMode,
          })),
        nestedParents,
      });
    },
  }),
);

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

    // Epic #724 — internal links (`/about`, own-domain URLs, media URLs)
    // are stored as references; a link to no page refuses the write.
    const linkCanon = await canonicaliseInstanceValues(
      tx,
      ctx,
      input.moduleId,
      input.values,
      undefined,
    );
    if (!linkCanon.ok) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "content_instances.create",
        input,
        succeeded: false,
        resultSummary: `link-canonicalisation: ${linkCanon.issues.length} issue(s)`,
      });
      return err({
        kind: "HandlerError",
        operation: "content_instances.create",
        message: linkCanon.message,
      });
    }
    Object.assign(input.values, linkCanon.value);

    // v0.12.1 — validate nested-module-ref shapes against the module's
    // declared fields[] BEFORE persisting so bad refs fail at write time
    // with an actionable error (not at render time as missingSlots).
    const refValidation = await validateNestedRefs(
      tx,
      ctx.chatBranchId ?? null,
      input.moduleId,
      input.values,
    );
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
        ...(refValidation.refusal ? { refusal: true as const } : {}),
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
        ${jsonbParam(valuesJson)},
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

    // Epic #724 — links to pages the chat's import run will still build.
    await recordPendingImportLinks(tx, linkCanon.pending, {
      kind: "content_instance",
      id: contentInstanceId,
    });
    return ok({ contentInstanceId });
  },
});

// ─── content_instances.create_many ───────────────────────────────────

/**
 * Issue #299 — bulk variant of `content_instances.create` per CLAUDE.md
 * §11 (run #15 fired the singular 9× in a row for what was ONE
 * conceptual operation). Each item runs the exact singular path —
 * module check, slug-dup check, nested-ref + field-shape validation,
 * audit, snapshot — inside ONE shared transaction.
 *
 * All-or-nothing: a failure at index i throws `OperationAbortError`
 * so items 0..i-1 roll back too (a `return err` after partial writes
 * would COMMIT them — see errors.ts). The message names `instances[i]`
 * and forwards the singular validator's field-naming message verbatim.
 */
export const createContentInstancesManyOp = defineOperation({
  name: "content_instances.create_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: contentInstancesCreateManySchema,
  output: z.object({ contentInstanceIds: z.array(z.string()) }),
  handler: async (ctx, input, tx) => {
    const contentInstanceIds: string[] = [];
    for (let i = 0; i < input.instances.length; i += 1) {
      const item = input.instances[i];
      if (item === undefined) continue;
      const r = await createContentInstanceOp.handler(ctx, item, tx);
      if (!r.ok) {
        const inner = r.error as { message?: string };
        const queryError = {
          kind: "HandlerError" as const,
          operation: "content_instances.create_many",
          message: `instances[${i}] (moduleId=${item.moduleId}${item.slug ? `, slug=${item.slug}` : ""}): ${
            inner.message ?? r.error.kind
          }. The whole batch was rolled back — fix this item and resend all ${input.instances.length}.`,
        };
        if (contentInstanceIds.length > 0) throw new OperationAbortError(queryError);
        return err(queryError);
      }
      contentInstanceIds.push((r.value as { contentInstanceId: string }).contentInstanceId);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "content_instances.create_many",
      input,
      succeeded: true,
      resultSummary: `created=${contentInstanceIds.length}`,
    });
    return ok({ contentInstanceIds });
  },
});

// ─── content_instances.set_values ────────────────────────────────────

/** One placement bound to a content_instance, as the caller sees it. */
interface PlacementInView {
  readonly contentInstanceId: string;
  readonly pageId: string;
  readonly path: string;
  readonly pageSlug: string;
  readonly pageTitle: string;
  /** The page is soft-deleted; its placement still holds the instance (restore). */
  readonly pageDeleted: boolean;
  readonly blockName: string;
  readonly position: number;
  readonly syncMode: "synced" | "unsynced";
}

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/**
 * The placements bound to any of `contentInstanceIds` as `branchId` sees
 * them: live `page_modules`, with every page the branch has a pending
 * layout snapshot for replaced by that snapshot. PR #947 review — in a
 * chat, `fork_placement_content` rebinds only the branch layout, so a
 * live-only view kept refusing the delete the refusal told the AI to
 * retry. #1067 — every placement read (get, list's placementCount,
 * set_values' blast radius, delete's guard) goes through here so they
 * agree with each other and with the preview. Ordered by path so
 * messages name pages deterministically.
 */
async function listPlacementsInView(
  tx: Tx,
  contentInstanceIds: readonly string[],
  branchId: string | null,
): Promise<PlacementInView[]> {
  if (contentInstanceIds.length === 0) return [];
  const idList = sql.join(
    contentInstanceIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const live = (await tx.execute(sql`
    SELECT pm.content_instance_id::text AS content_instance_id, pm.page_id::text AS page_id,
           p.current_path AS path, p.slug AS page_slug, p.title AS page_title,
           (p.deleted_at IS NOT NULL) AS page_deleted, pm.block_name, pm.position, pm.sync_mode
    FROM page_modules pm
    JOIN pages p ON p.id = pm.page_id
    WHERE pm.content_instance_id IN (${idList})
  `)) as unknown as {
    content_instance_id: string;
    page_id: string;
    path: string;
    page_slug: string;
    page_title: string;
    page_deleted: boolean;
    block_name: string;
    position: number;
    sync_mode: "synced" | "unsynced";
  }[];
  const placements: PlacementInView[] = live.map((r) => ({
    contentInstanceId: r.content_instance_id,
    pageId: r.page_id,
    path: r.path,
    pageSlug: r.page_slug,
    pageTitle: r.page_title,
    pageDeleted: r.page_deleted,
    blockName: r.block_name,
    position: r.position,
    syncMode: r.sync_mode,
  }));
  if (branchId === null) return sortByPath(placements);

  // The newest pending layout per page the branch reshaped — the same row
  // `loadPageLayoutStateWithBranchOverlay` picks, in one query.
  const overlaid = (await tx.execute(sql`
    SELECT DISTINCT ON (pls.page_id)
           pls.page_id::text AS page_id, p.current_path AS path, p.slug AS page_slug,
           p.title AS page_title, (p.deleted_at IS NOT NULL) AS page_deleted, pls.state
    FROM page_layout_snapshots pls
    JOIN site_snapshots ss ON ss.id = pls.site_snapshot_id
    JOIN pages p ON p.id = pls.page_id
    WHERE ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}
    ORDER BY pls.page_id, ss.created_at DESC
  `)) as unknown as {
    page_id: string;
    path: string;
    page_slug: string;
    page_title: string;
    page_deleted: boolean;
    state: unknown;
  }[];
  const wanted = new Set(contentInstanceIds);
  const overlaidIds = new Set(overlaid.map((r) => r.page_id));
  const inView = placements.filter((p) => !overlaidIds.has(p.pageId));
  for (const page of overlaid) {
    const layout = (
      typeof page.state === "string" ? JSON.parse(page.state) : page.state
    ) as PageLayoutState;
    for (const block of layout.blocks) {
      if (!block.placements) {
        throw new Error(
          `content_instances: branch layout of page ${page.page_id} block ${block.blockName} has no placements — the snapshot predates v0.12; undo that chat's layout change and redo it`,
        );
      }
      block.placements.forEach((pl, position) => {
        if (!wanted.has(pl.contentInstanceId)) return;
        inView.push({
          contentInstanceId: pl.contentInstanceId,
          pageId: page.page_id,
          path: page.path,
          pageSlug: page.page_slug,
          pageTitle: page.page_title,
          pageDeleted: page.page_deleted,
          blockName: block.blockName,
          position,
          syncMode: pl.syncMode,
        });
      });
    }
  }
  return sortByPath(inView);
}

function sortByPath(placements: PlacementInView[]): PlacementInView[] {
  return placements.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.blockName.localeCompare(b.blockName) ||
      a.position - b.position,
  );
}

/** Placement count per instance id, as the caller sees it (absent = 0). */
export async function countPlacementsInView(
  tx: Tx,
  contentInstanceIds: readonly string[],
  branchId: string | null,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const p of await listPlacementsInView(tx, contentInstanceIds, branchId)) {
    counts.set(p.contentInstanceId, (counts.get(p.contentInstanceId) ?? 0) + 1);
  }
  return counts;
}

/** Above this many ids the parent scan matches any nested ref instead of OR-ing ids. */
const NESTED_PARENT_ID_NEEDLES_MAX = 20;

/**
 * The content instances (live + the caller's branch view, deleted ones
 * excluded) that list each of `contentInstanceIds` in a `module` /
 * `module-list` field, keyed by child id. A child with no placement of
 * its own still renders wherever such a parent renders — it is not an
 * orphan (#1067). The substring prefilter is confirmed against the
 * parsed refs.
 */
async function nestedParentsInView(
  tx: Tx,
  branchId: string | null,
  contentInstanceIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (contentInstanceIds.length === 0) return out;
  const wanted = new Set(contentInstanceIds);
  const needles =
    contentInstanceIds.length > NESTED_PARENT_ID_NEEDLES_MAX
      ? ["contentInstanceId"]
      : contentInstanceIds;
  const candidates = await findContentInstancesContaining(tx, branchId, needles);
  for (const c of candidates) {
    const refs = collectNestedRefs(JSON.parse(c.valuesText) as Record<string, unknown>);
    for (const childId of new Set(refs.map((r) => r.contentInstanceId))) {
      if (childId === c.contentInstanceId || !wanted.has(childId)) continue;
      const parents = out.get(childId) ?? [];
      parents.push(c.contentInstanceId);
      out.set(childId, parents);
    }
  }
  return out;
}

export const setContentInstanceValuesOp = defineOperation({
  name: "content_instances.set_values",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: contentInstanceUpdateSchema,
  output: z.object({
    placementCount: z.number().int().nonnegative(),
    /**
     * Content instances (as the caller sees them) that list this one in a
     * `module` / `module-list` field. An instance with no placement of its
     * own still renders wherever those parents render — it is not an
     * orphan.
     */
    nestedParentCount: z.number().int().nonnegative(),
    version: z.number().int().positive(),
  }),
  handler: async (ctx, input, tx) => {
    // Per-instance lock so two chats can't simultaneously rewrite a
    // shared instance. Mirrors modules.update's lock contract.
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "contentInstance",
      entityId: input.id,
      chatBranchId: ctx.chatBranchId,
      holderKey: ctx.chatTaskId,
    });
    if (!lock.permitted) {
      return err(
        await entityWriteBlockedError(
          tx,
          "content_instances.set_values",
          "contentInstance",
          input.id,
          lock,
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

    // Epic #724 — canonicalise internal links (see content_instances.create).
    // Links already in the stored values are grandfathered: an edit must
    // not add a broken link, but need not fix an unrelated old one.
    const linkCanon = await canonicaliseInstanceValues(
      tx,
      ctx,
      prev.moduleId,
      input.values,
      prev.values,
    );
    if (!linkCanon.ok) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "content_instances.set_values",
        input,
        succeeded: false,
        entityId: input.id,
        resultSummary: `link-canonicalisation: ${linkCanon.issues.length} issue(s)`,
      });
      return err({
        kind: "HandlerError",
        operation: "content_instances.set_values",
        message: linkCanon.message,
      });
    }
    Object.assign(input.values, linkCanon.value);

    // v0.12.1 — validate nested-module-ref shapes against the owning
    // module's fields[] so bad refs fail at write time, not render time.
    const refValidation = await validateNestedRefs(tx, branchId, prev.moduleId, input.values);
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
        ...(refValidation.refusal ? { refusal: true as const } : {}),
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
        SET "values" = ${jsonbParam(valuesJson)},
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

    const placementCount =
      (await countPlacementsInView(tx, [input.id], branchId)).get(input.id) ?? 0;
    const nestedParentCount =
      (await nestedParentsInView(tx, branchId, [input.id])).get(input.id)?.length ?? 0;
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

    // #392 — a value edit on a (possibly shared) instance is a content
    // change on EVERY page bound to it. One page.updated per bound page,
    // in this same tx, so staleness workers see the real blast radius —
    // exactly the case the deleted content-hash hooks never covered.
    const boundPages = (await tx.execute(sql`
      SELECT DISTINCT page_id::text AS page_id
      FROM page_modules
      WHERE content_instance_id = ${input.id}::uuid
    `)) as unknown as { page_id: string }[];
    for (const bp of boundPages) {
      await emitDomainEvent(tx, {
        kind: "page.updated",
        entityId: bp.page_id,
        payload: {
          contentInstanceId: input.id,
          ...(branchId ? { chatBranchId: branchId } : {}),
        },
      });
    }

    // Epic #724 — links to pages the chat's import run will still build.
    await recordPendingImportLinks(tx, linkCanon.pending, {
      kind: "content_instance",
      id: input.id,
    });
    return ok({ placementCount, nestedParentCount, version: nextVersion });
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
      holderKey: ctx.chatTaskId,
    });
    if (!lock.permitted) {
      return err(
        await entityWriteBlockedError(
          tx,
          "content_instances.delete",
          "contentInstance",
          input.id,
          lock,
        ),
      );
    }

    // A chat sees (and deletes) the instance through its branch: the live
    // row stays untouched until the chat is staged (PR #947 review — the
    // delete used to soft-delete the live row from inside a chat).
    const branchId = ctx.chatBranchId ?? null;
    const target = branchId
      ? await loadContentInstanceStateWithBranchOverlay(tx, input.id, branchId)
      : await loadContentInstanceState(tx, input.id);
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "content_instances.delete",
        message: "content_instance not found",
      });
    }
    if (target.deletedAt !== null) {
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

    const placements = await listPlacementsInView(tx, [input.id], branchId);
    if (placements.length > 0) {
      // Refuse instead of cascading: the AI detaches each placement via
      // fork_placement_content (content survives as a private copy),
      // then deletes the orphan. #63 — the message must only name tools
      // that exist; it once pointed at a never-built propose tool. It
      // lists the placements themselves (fork_placement_content's exact
      // arguments), so no discovery call is needed (CLAUDE.md §11).
      const shown = placements.slice(0, 10);
      const list = shown
        .map(
          (p) => `${p.path} (pageId ${p.pageId}, blockName ${p.blockName}, position ${p.position})`,
        )
        .join("; ");
      const more =
        placements.length > shown.length ? `; and ${placements.length - shown.length} more` : "";
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "content_instances.delete",
        input,
        succeeded: false,
        entityId: input.id,
        resultSummary: `blocked: placementCount=${placements.length}`,
      });
      return err({
        kind: "HandlerError",
        operation: "content_instances.delete",
        // #1091 — the orphan-only guard working as designed.
        refusal: true,
        message: `cannot delete: ${placements.length} placement(s) reference this content_instance: ${list}${more}. Detach each one with fork_placement_content (those pageId/blockName/position values; the page keeps its content as a private copy), then retry the delete.`,
        nextAction: {
          tool: "fork_placement_content",
          args: {},
          reason:
            "detach each referencing placement into its own private content_instance before deleting",
        },
      });
    }

    // #1067 — an instance with no placement of its own can still render
    // inside a parent's `module` / `module-list` field. Deleting it would
    // leave that parent pointing at a deleted instance (the next write of
    // the parent fails nested-ref validation, the render loses the item).
    const parents = (await nestedParentsInView(tx, branchId, [input.id])).get(input.id) ?? [];
    if (parents.length > 0) {
      const shown = parents.slice(0, 10).join(", ");
      const more = parents.length > 10 ? ` and ${parents.length - 10} more` : "";
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "content_instances.delete",
        input,
        succeeded: false,
        entityId: input.id,
        resultSummary: `blocked: nestedParentCount=${parents.length}`,
      });
      return err({
        kind: "HandlerError",
        operation: "content_instances.delete",
        refusal: true,
        message: `cannot delete: ${parents.length} content_instance(s) show this one inside a module / module-list field: ${shown}${more}. It renders wherever they render, so it is not an orphan. To delete it, first remove it from each parent's field with set_content_instance_values on the parent (get_content_instance shows the parent's values), then retry the delete.`,
        nextAction: {
          tool: "get_content_instance",
          args: { id: parents[0] },
          reason: "read the parent's values, then drop this instance's ref from its field",
        },
      });
    }

    if (branchId === null) {
      await tx.execute(sql`
        UPDATE content_instances
        SET deleted_at = now(),
            updated_by = ${ctx.actorId}::uuid
        WHERE id = ${input.id}::uuid
      `);
    }

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "content_instances.delete",
      input,
      succeeded: true,
      entityId: input.id,
      resultSummary: branchId ? "soft-deleted (branch)" : "soft-deleted",
    });

    const state = branchId
      ? { ...target, deletedAt: new Date().toISOString() }
      : await loadContentInstanceState(tx, input.id);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "content_instances.delete",
        description: `content_instances.delete id=${input.id}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: branchId,
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
      holderKey: ctx.chatTaskId,
    });
    if (!lock.permitted) {
      return err(
        await entityWriteBlockedError(tx, "placement.set_content", "page", input.pageId, lock),
      );
    }

    // Verify the placement exists — via the BRANCH-OVERLAID layout, the
    // same source the branched write below re-emits from. A chat's
    // just-created placements live only in `page_layout_snapshots`, not
    // live `page_modules`; the old live SELECT here 404'd every binding a
    // chat made against its own fresh placement ("no placement at
    // (content, 0)"), forcing a fallback to set_page_module_content
    // (live-edit nested-CTA turn: 4 failed set_placement_content calls).
    const overlaidLayout = await loadPageLayoutStateWithBranchOverlay(
      tx,
      input.pageId,
      ctx.chatBranchId ?? null,
    );
    const overlaidBlock = overlaidLayout.blocks.find((b) => b.blockName === input.blockName);
    const placement = overlaidBlock?.placements?.[input.position];
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
    if (ci.module_id !== placement.moduleId) {
      return err({
        kind: "HandlerError",
        operation: "placement.set_content",
        message: `content_instance ${input.contentInstanceId} is for module ${ci.module_id}, but the placement uses module ${placement.moduleId}. Pick a content_instance for the placement's module.`,
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
      // binding. Read the BRANCH-OVERLAID layout (not live — the page's
      // placements may exist only in this chat's branch), swap this
      // placement's binding, emit. Mirrors pages.set_modules' branched
      // snapshot but limited to one placement.
      const layoutState = await loadPageLayoutStateWithBranchOverlay(
        tx,
        input.pageId,
        ctx.chatBranchId,
      );
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
    await emitDomainEvent(tx, {
      kind: "page.updated",
      entityId: input.pageId,
      payload: { blockName: input.blockName },
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
  // #397 — plugin actors fork too: translating a SYNCED placement must
  // detach it first (a translation is by definition page-private).
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: forkPlacementContentSchema,
  output: z.object({ contentInstanceId: z.string() }),
  handler: async (ctx, input, tx) => {
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "page",
      entityId: input.pageId,
      chatBranchId: ctx.chatBranchId,
      holderKey: ctx.chatTaskId,
    });
    if (!lock.permitted) {
      return err(
        await entityWriteBlockedError(tx, "placement.fork_content", "page", input.pageId, lock),
      );
    }

    // Resolve the placement and the values it shows through the caller's
    // BRANCH-OVERLAID view, like placement.set_content: on a chat branch the
    // placement may exist only in page_layout_snapshots, and the shared
    // instance may carry branch edits the fork must start from.
    const overlaidLayout = await loadPageLayoutStateWithBranchOverlay(
      tx,
      input.pageId,
      ctx.chatBranchId ?? null,
    );
    const placement = overlaidLayout.blocks.find((b) => b.blockName === input.blockName)
      ?.placements?.[input.position];
    if (!placement) {
      return err({
        kind: "HandlerError",
        operation: "placement.fork_content",
        message: `no placement at (${input.blockName}, ${input.position}) on page ${input.pageId}`,
      });
    }

    // Read the source instance's values so the fork starts as a deep copy.
    const source = await loadContentInstanceStateWithBranchOverlay(
      tx,
      placement.contentInstanceId,
      ctx.chatBranchId,
    );
    const valuesJson = JSON.stringify(source?.values ?? {});

    // Mint the new (unsynced) content_instance, copy values, and bind
    // the placement to it.
    const minted = (await tx.execute(sql`
      INSERT INTO content_instances
        (module_id, "values", updated_by, chat_branch_id)
      VALUES (
        ${placement.moduleId}::uuid,
        ${jsonbParam(valuesJson)},
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
    // placement. On a chat branch live page_modules stays as it is, so the
    // rebinding exists only in this snapshot: the branch-overlaid layout
    // with this placement swapped to the new, unsynced instance (the same
    // shape placement.set_content emits).
    const ciState = await loadContentInstanceState(tx, newCiId);
    const layoutState = ctx.chatBranchId
      ? {
          schemaVersion: 1 as const,
          blocks: overlaidLayout.blocks.map((b) =>
            b.blockName !== input.blockName
              ? b
              : {
                  ...b,
                  placements: (b.placements ?? []).map((p, i) =>
                    i === input.position
                      ? { ...p, contentInstanceId: newCiId, syncMode: "unsynced" as const }
                      : p,
                  ),
                },
          ),
        }
      : await loadPageLayoutState(tx, input.pageId);
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

/**
 * Why a nested module reference was refused. #1094 — a correctly shaped
 * `{ moduleId, contentInstanceId }` whose id was one character short read
 * as "expects { moduleId, contentInstanceId }", which sent the AI looking
 * for a structural mistake; name the malformed id instead.
 */
function moduleRefMessage(where: string, value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const ref = value as Record<string, unknown>;
    const keys = Object.keys(ref);
    const shapeOk = keys.length === 2 && "moduleId" in ref && "contentInstanceId" in ref;
    if (shapeOk) {
      for (const key of ["moduleId", "contentInstanceId"] as const) {
        const problem = describeMalformedUuid(ref[key]);
        if (problem) return `${where}: ${key} ${problem}. ${COPY_ID_EXACTLY_HINT}`;
      }
    }
  }
  return `${where} expects { moduleId, contentInstanceId }; got ${JSON.stringify(value)}`;
}
