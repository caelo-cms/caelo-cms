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
  contentInstanceCreateSchema,
  contentInstanceDeleteSchema,
  contentInstancesCreateManySchema,
  contentInstanceUpdateSchema,
  describeMalformedUuid,
  type ExecutionContext,
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
import { canonicaliseInstanceValues } from "../../links/canonicalise-writes.js";
import { withHumanisedLinks } from "../../links/humanise.js";
import { recordPendingImportLinks } from "../../links/import-targets.js";
import { normaliseListFieldValues } from "../../lists/field-values.js";
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
import { jsonbParam } from "../../sql-helpers.js";
import { cloneContentInstancesDeep } from "./content-instance-clone.js";
import {
  type ContentInstanceReach,
  isOrphan,
  loadContentInstanceReach,
  parentCountOf,
} from "./content-instance-reach.js";

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
   * field.
   */
  nestedParentCount: z.number().int().nonnegative(),
  /**
   * #627 — every direct parent: the instances above plus modules whose
   * field default lists it and shared lists whose entries embed it.
   * Orphan = no placements AND no parents.
   */
  parentCount: z.number().int().nonnegative(),
  /**
   * #627 — live pages it renders on: its own placements plus everything
   * its parents render on, transitively (the real blast radius of an edit).
   */
  renderedPageCount: z.number().int().nonnegative(),
  /** #627 — it renders in layout chrome or a shared list: site-wide reach. */
  rendersSiteWide: z.boolean(),
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
 * an empty/whitespace-only url is stored as "" (no link, #1095; see the
 * url branch below), so one missing link target can't abort an atomic
 * build. Callers persist `values` after this returns, so the
 * normalisation is durable.
 */
async function validateNestedRefs(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  chatBranchId: string | null,
  moduleId: string,
  values: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; message: string; refusal?: true }> {
  // Read the owning module's fields schema AS THE CALLER SEES IT (#1042):
  // a chat's `update_modules_many` lands only in its branch snapshot, so reading
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
      // An EMPTY or whitespace-only url value is a link the content does
      // not have — valid for an optional link, and stored as "" so an
      // optional `{{#field}}…{{/field}}` section stays hidden (#1095). An
      // earlier version stored a placeholder "#" to keep build_page from
      // rolling back; that made the section truthy and rendered a dead
      // link. The empty value now simply passes, so build_page stays
      // atomic without inventing a target. Mutated in place so the
      // normalised "" persists through the caller's INSERT/UPDATE, the
      // snapshot state and the audit record.
      if (typeof v === "string" && v.trim() === "") {
        values[f.name] = "";
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
            `or, if this module SHOULD be allowed here, add "${m.type}" to the field's allowedModuleTypes via update_modules_many on the parent module. ` +
            `Do not ask the operator to fix this — pick a valid module or widen the allowlist and retry.`,
        };
      }
    }
  }
  return { ok: true };
}

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

/** The module's fields in the caller's view, then {@link normaliseListFieldValues}. */
async function normaliseInstanceListValues(
  tx: Tx,
  ctx: ExecutionContext,
  branchId: string | null,
  moduleId: string,
  values: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const owner = await loadModuleStateWithBranchOverlay(tx, moduleId, branchId);
  if (owner === null) return { ok: true };
  return normaliseListFieldValues(tx, ctx, branchId, owner.fields, values);
}

function rowToContentInstance(
  r: ContentInstanceRowSql,
  reach: ContentInstanceReach,
): z.infer<typeof contentInstanceRowSchema> {
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
    values: r.values as Record<string, unknown>,
    version: typeof r.version === "string" ? Number.parseInt(r.version, 10) : r.version,
    placementCount: reach.placements.length,
    nestedParentCount: reach.parentInstances.length,
    parentCount: parentCountOf(reach),
    renderedPageCount: reach.pages.length,
    rendersSiteWide: reach.chromeLayouts.length > 0 || reach.viaLists.length > 0,
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
    deletedAt: iso(r.deleted_at),
  };
}

/** The reach {@link loadContentInstanceReach} computed for `id` (it returns every id asked for). */
function reachOf(
  reach: ReadonlyMap<string, ContentInstanceReach>,
  id: string,
): ContentInstanceReach {
  const r = reach.get(id);
  if (!r) throw new Error(`content_instances: no reach computed for ${id}`);
  return r;
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
        /** #1214 — the instances of any of these modules (a plugin
         *  re-reading just the modules a write touched). */
        moduleIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
        /** #1223 — exactly these instances (a plugin reading what one
         *  page renders instead of every instance of the site). */
        ids: z.array(z.string().uuid()).min(1).max(1000).optional(),
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
      const moduleIdsFilter = input.moduleIds
        ? sql`AND ci.module_id IN (${sql.join(
            input.moduleIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql``;
      const idsFilter = input.ids
        ? sql`AND ci.id IN (${sql.join(
            input.ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql``;
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
        ${moduleIdsFilter}
        ${idsFilter}
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
      const reach = await loadContentInstanceReach(tx, ctx.chatBranchId ?? null, ids);

      return ok({
        instances: visible.map((r) => rowToContentInstance(r, reachOf(reach, r.id))),
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
      /** #627 — modules whose field default shows it (layout chrome has only defaults). */
      parentModules: z.array(
        z.object({
          moduleId: z.string(),
          slug: z.string(),
          displayName: z.string(),
          field: z.string(),
        }),
      ),
      /** #627 — shared lists whose entries embed it. */
      parentLists: z.array(z.object({ listId: z.string(), slug: z.string(), name: z.string() })),
      /** #627 — the live pages it renders on, directly or through its parents (by path). */
      renderedOn: z.array(z.object({ pageId: z.string(), path: z.string(), title: z.string() })),
      /** #627 — layouts whose chrome shows it: it renders on every page of each. */
      chromeLayouts: z.array(z.object({ layoutId: z.string(), slug: z.string() })),
      /** #627 — shared lists that show it (or a parent): it renders wherever they render. */
      viaLists: z.array(z.object({ listId: z.string(), slug: z.string(), name: z.string() })),
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
      const reach = reachOf(
        await loadContentInstanceReach(tx, ctx.chatBranchId ?? null, [input.id]),
        input.id,
      );
      return ok({
        instance: rowToContentInstance(r, reach),
        placements: reach.placements
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
        nestedParents: [...reach.parentInstances],
        parentModules: [...reach.parentModules],
        parentLists: [...reach.parentLists],
        renderedOn: [...reach.pages],
        chromeLayouts: [...reach.chromeLayouts],
        viaLists: [...reach.viaLists],
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
        // A link to a page that does not exist: the guard working, not a
        // Caelo defect — not auto-filed as a bug (#1097).
        refusal: true,
      });
    }
    Object.assign(input.values, linkCanon.value);
    // Epic #1107 — `list` field values: entries validated, ids assigned.
    const listValues = await normaliseInstanceListValues(
      tx,
      ctx,
      ctx.chatBranchId ?? null,
      input.moduleId,
      input.values,
    );
    if (!listValues.ok) {
      return err({
        kind: "HandlerError",
        operation: "content_instances.create",
        message: listValues.message,
      });
    }

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
        const inner = r.error as { message?: string; refusal?: true };
        const queryError = {
          kind: "HandlerError" as const,
          operation: "content_instances.create_many",
          message: `instances[${i}] (moduleId=${item.moduleId}${item.slug ? `, slug=${item.slug}` : ""}): ${
            inner.message ?? r.error.kind
          }. The whole batch was rolled back — fix this item and resend all ${input.instances.length}.`,
          // #1091 — an item's guard refusal stays a refusal for the batch
          // (the guard-refusal capture keys on it), as in `defineBulkOp`.
          ...(r.error.kind === "HandlerError" && inner.refusal ? { refusal: true as const } : {}),
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
    /** #627 — direct parents of any kind (instances, module defaults, shared lists). */
    parentCount: z.number().int().nonnegative(),
    /** #627 — live pages the edit shows on, directly or through its parents. */
    renderedPageCount: z.number().int().nonnegative(),
    /** #627 — it also renders in layout chrome or a shared list (site-wide). */
    rendersSiteWide: z.boolean(),
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
        // A link to a page that does not exist: the guard working, not a
        // Caelo defect — not auto-filed as a bug (#1097).
        refusal: true,
      });
    }
    Object.assign(input.values, linkCanon.value);
    // Epic #1107 — `list` field values: entries validated, ids assigned.
    const listValues = await normaliseInstanceListValues(
      tx,
      ctx,
      branchId,
      prev.moduleId,
      input.values,
    );
    if (!listValues.ok) {
      return err({
        kind: "HandlerError",
        operation: "content_instances.set_values",
        message: listValues.message,
      });
    }

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

    const reach = reachOf(await loadContentInstanceReach(tx, branchId, [input.id]), input.id);
    const placementCount = reach.placements.length;
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
    // change on EVERY page it renders on. One page.updated per page, in
    // this same tx, so staleness workers see the real blast radius. #627 —
    // that includes the pages of its parents: a child with no placement
    // of its own changes every page its parent renders on. Layout chrome
    // reach is a layout change, not a per-page one: no event per page of
    // the site.
    for (const page of reach.pages) {
      await emitDomainEvent(tx, {
        kind: "page.updated",
        entityId: page.pageId,
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
    return ok({
      placementCount,
      nestedParentCount: reach.parentInstances.length,
      parentCount: parentCountOf(reach),
      renderedPageCount: reach.pages.length,
      rendersSiteWide: reach.chromeLayouts.length > 0 || reach.viaLists.length > 0,
      version: nextVersion,
    });
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

    const reach = reachOf(await loadContentInstanceReach(tx, branchId, [input.id]), input.id);
    const placements = reach.placements;
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

    // #1067 / #627 — an instance with no placement of its own can still
    // render inside a parent: another instance's `module` / `module-list`
    // field, a module's field default (layout chrome) or a shared list's
    // entries. Deleting it would leave that parent pointing at a deleted
    // instance (the next write of the parent fails nested-ref validation,
    // the render loses the item, the Stage fails on the missing ref).
    if (!isOrphan(reach)) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "content_instances.delete",
        input,
        succeeded: false,
        entityId: input.id,
        resultSummary: `blocked: parentCount=${parentCountOf(reach)}`,
      });
      return err({
        kind: "HandlerError",
        operation: "content_instances.delete",
        refusal: true,
        message: describeParentRefusal(reach),
        nextAction: reach.parentInstances[0]
          ? {
              tool: "get_content_instance",
              args: { id: reach.parentInstances[0] },
              reason: "read the parent's values, then drop this instance's ref from its field",
            }
          : reach.parentModules[0]
            ? {
                tool: "update_modules_many",
                args: {},
                reason: `remove this instance from the default of field "${reach.parentModules[0].field}" of module ${reach.parentModules[0].moduleId}`,
              }
            : {
                tool: "patch_list_items_many",
                args: {},
                reason: "remove the entry that embeds this instance from the shared list",
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

/**
 * The refusal text for deleting an instance something still shows: names
 * every parent, the pages that would lose it and the exact way to detach
 * it from each kind of parent (CLAUDE.md §11 — the AI acts without asking).
 */
function describeParentRefusal(reach: ContentInstanceReach): string {
  const parts: string[] = [];
  if (reach.parentInstances.length > 0) {
    const shown = reach.parentInstances.slice(0, 10).join(", ");
    const more =
      reach.parentInstances.length > 10 ? ` and ${reach.parentInstances.length - 10} more` : "";
    parts.push(
      `content_instance(s) ${shown}${more} show it in a module / module-list field — remove its ref from each parent's field with set_content_instance_values_many (get_content_instance shows the parent's values; when you delete the parent too, delete the parent first in the same delete_content_instances call)`,
    );
  }
  if (reach.parentModules.length > 0) {
    const shown = reach.parentModules
      .slice(0, 10)
      .map((m) => `${m.slug} (${m.moduleId}) field "${m.field}"`)
      .join(", ");
    parts.push(
      `module default(s) ${shown} show it — remove it from that field's default with update_modules_many`,
    );
  }
  if (reach.parentLists.length > 0) {
    const shown = reach.parentLists
      .slice(0, 10)
      .map((l) => `${l.slug} (${l.listId})`)
      .join(", ");
    parts.push(
      `shared list(s) ${shown} embed it in an entry — remove that entry (or its module value) with patch_list_items_many`,
    );
  }
  const pages = reach.pages.slice(0, 10).map((p) => p.path);
  const where =
    pages.length > 0
      ? ` It renders on ${reach.pages.length} page(s): ${pages.join(", ")}${reach.pages.length > pages.length ? ", ..." : ""}.`
      : "";
  const siteWide =
    reach.chromeLayouts.length > 0
      ? ` It is part of the layout chrome of ${reach.chromeLayouts.map((l) => l.slug).join(", ")} (every page of those layouts).`
      : "";
  return `cannot delete: it is not an orphan — ${parts.join("; ")}.${where}${siteWide} Detach it from every parent, then retry the delete.`;
}

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

    // The fork starts as a deep copy of what the placement shows on the
    // caller's branch — nested module / module-list content included, so
    // editing the fork's nested sections never edits the shared source's.
    const forked = await cloneContentInstancesDeep(tx, ctx, [placement.contentInstanceId]);
    if (!forked.ok) {
      return err({
        kind: "HandlerError",
        operation: "placement.fork_content",
        message: forked.message,
      });
    }
    const newCiId = forked.ids[0];
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

    // Emit a content_instance snapshot for every row the fork minted —
    // the root copy and its nested copies (#1126), so revert + audit see
    // the fork — plus a pageLayout snapshot reflecting the rebound
    // placement. On a chat branch live page_modules stays as it is, so the
    // rebinding exists only in this snapshot: the branch-overlaid layout
    // with this placement swapped to the new, unsynced instance (the same
    // shape placement.set_content emits).
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
        ...forked.snapshotEntities,
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
