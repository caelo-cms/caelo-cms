// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — `list_types.*` ops (docs/lists.md §3, §12).
 *
 * A list type is the shape of a list: node kinds, their fields, what may
 * hang under what, sources. Changing one that has lists is checked
 * against EVERY list of the type in the caller's view — shared lists and
 * the local lists inside module fields and content instances — in the
 * same transaction: a new required field takes its `default` into every
 * existing entry, removing a node kind or field that still holds values
 * is refused (naming the lists) unless the caller passes `dropValues`.
 * Writes need `content.structure`; every write snapshots and is undone
 * like any other draft change.
 */

import { activeListExt } from "@caelo-cms/plugin-host";
import { defineOperation, type ErrorDetail, handlerErrorFromDetails } from "@caelo-cms/query-api";
import {
  checkListTypeDef,
  LIST_TYPE_ROLES,
  type ListItem,
  type ListTypeDef,
  listTypeDefSchema,
  ok,
  validateListItems,
} from "@caelo-cms/shared";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { emitDomainEvent } from "../../domain-events.js";
import { checkDefinitionExt, inertExtPaths } from "../../lists/ext.js";
import {
  describeLocalPlace,
  findLocalLists,
  type LocalListPlace,
  listFieldsOf,
  loadInstancesOfModules,
  loadModulesInView,
} from "../../lists/local.js";
import {
  loadListEntities,
  loadListEntityBySlug,
  loadListEntityForUpsert,
  persistListEntity,
} from "../../lists/store.js";
import { adaptItemsToType, diffListTypeDefs } from "../../lists/type-change.js";
import { checkAndAcquireEntityLock, entityWriteBlockedError } from "../../locks.js";
import { emitSnapshot } from "../../snapshots/index.js";
import type { ListState, ListTypeState } from "../../snapshots/state.js";
import { setContentInstanceValuesOp } from "../content/content-instances.js";
import { updateModuleOp } from "../content/modules.js";
import { structureWriteRefusal } from "./_permission.js";
import {
  branchOf,
  conflictError,
  describeIssues,
  emitListItemsChanged,
  failBatch,
  handlerError,
  listIssuesToDetails,
} from "./_shared.js";

const listTypeRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  purpose: z.string(),
  role: z.enum(LIST_TYPE_ROLES),
  /** Node kinds with their labels, e.g. `entry (Menu entry)`. */
  nodes: z.array(z.string()),
  definition: listTypeDefSchema,
  /** Shared lists of this type the caller sees. */
  listCount: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  updatedAt: z.string(),
  /**
   * The plugin that ships this type (it is available while the plugin
   * runs and is edited only through the plugin's releases), or null for
   * a site type.
   */
  ownerPlugin: z.string().nullable(),
  /**
   * `ext.<plugin>` attributes no running plugin interprets — stored, but
   * doing nothing until that plugin runs again (docs/lists.md §9.2).
   */
  inertExt: z.array(z.string()),
});

type ListTypeRow = z.infer<typeof listTypeRowSchema>;

function listTypeRow(
  t: { id: string; state: ListTypeState; updatedAt: string; ownerPlugin: string | null },
  listCount: number,
): ListTypeRow {
  return {
    id: t.id,
    slug: t.state.slug,
    name: t.state.definition.name,
    purpose: t.state.definition.purpose,
    role: t.state.definition.role,
    nodes: summarizeNodes(t.state.definition),
    definition: t.state.definition,
    listCount,
    version: t.state.version,
    updatedAt: t.updatedAt,
    ownerPlugin: t.ownerPlugin,
    inertExt: inertExtPaths(t.state.definition, activeListExt),
  };
}

/**
 * The refusal for a person's or the AI's write to a type a plugin ships:
 * the plugin's manifest is its definition, refreshed on every load, so an
 * edit here would be overwritten silently.
 */
function pluginOwnedRefusal(
  ctx: { actorKind: string },
  at: string,
  slug: string,
  ownerPlugin: string | null,
): string | null {
  if (ownerPlugin === null || ctx.actorKind === "system") return null;
  return `${at}: list type "${slug}" ships with plugin "${ownerPlugin}" — its definition comes from the plugin and cannot be changed or deleted here. Use it as it is, or create your own type under another slug (list_types.upsert_many).`;
}

function summarizeNodes(def: ListTypeDef): string[] {
  return Object.entries(def.nodes).map(([kind, n]) => `${kind} (${n.label})`);
}

// ─── list_types.list ─────────────────────────────────────────────────

export const listListTypesOp = defineOperation({
  name: "list_types.list",
  // Why plugin: the `lists` read grant (docs/lists.md §9) — a translation
  // plugin reads the definitions (and its `ext` attributes) through named
  // ops of the domain, never through a table.
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      role: z.enum(LIST_TYPE_ROLES).optional(),
      /** Free-text match on slug, name and purpose. */
      query: z.string().min(1).max(128).optional(),
    })
    .strict(),
  output: z.object({ listTypes: z.array(listTypeRowSchema) }),
  handler: async (ctx, input, tx) => {
    const branchId = branchOf(ctx);
    const types = await loadListEntities(tx, "listType", branchId);
    const lists = await loadListEntities(tx, "list", branchId);
    const counts = new Map<string, number>();
    for (const l of lists)
      counts.set(l.state.listTypeId, (counts.get(l.state.listTypeId) ?? 0) + 1);
    const q = input.query?.toLowerCase();
    return ok({
      listTypes: types
        .filter((t) => input.role === undefined || t.state.definition.role === input.role)
        .filter(
          (t) =>
            q === undefined ||
            `${t.state.slug} ${t.state.definition.name} ${t.state.definition.purpose}`
              .toLowerCase()
              .includes(q),
        )
        .map((t) => listTypeRow(t, counts.get(t.id) ?? 0)),
    });
  },
});

// ─── list_types.get ──────────────────────────────────────────────────

export const getListTypeOp = defineOperation({
  name: "list_types.get",
  // Why plugin: the `lists` read grant (see list_types.list).
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z.object({ slug: z.string().min(1).max(64) }).strict(),
  output: z.object({
    listType: listTypeRowSchema,
    lists: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() })),
    /** Local lists of this type inside module fields / content instances. */
    localLists: z.array(z.string()),
  }),
  handler: async (ctx, input, tx) => {
    const branchId = branchOf(ctx);
    const t = await loadListEntityBySlug(tx, "listType", branchId, input.slug);
    if (!t) {
      const known = (await loadListEntities(tx, "listType", branchId)).map((x) => x.state.slug);
      return {
        ok: false,
        error: handlerError(
          "list_types.get",
          `no list type "${input.slug}" — the site has ${known.join(", ") || "none"}. Use one of those, or create it with list_types.upsert_many.`,
        ),
      };
    }
    const lists = (await loadListEntities(tx, "list", branchId)).filter(
      (l) => l.state.listTypeId === t.id,
    );
    const local = await findLocalLists(tx, branchId, t.state.slug);
    return ok({
      listType: listTypeRow(t, lists.length),
      lists: lists.map((l) => ({ id: l.id, slug: l.state.slug, name: l.state.name })),
      localLists: local.map((l) => describeLocalPlace(l.place)),
    });
  },
});

// ─── list_types.upsert_many ──────────────────────────────────────────

const upsertItemSchema = listTypeDefSchema.extend({
  /** Optimistic write token from list_types.get / list; a stale value is a conflict. */
  expectedVersion: z.number().int().positive().optional(),
});

/**
 * Create or replace list types, one transaction. A replaced definition is
 * checked against every list of the type (see the file header).
 */
export const upsertListTypesManyOp = defineOperation({
  name: "list_types.upsert_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      listTypes: z.array(upsertItemSchema).min(1).max(50),
      /**
       * Allow the change to delete values the new definition no longer
       * has a place for (removed node kinds, fields, children). Without
       * it such a change is refused and the affected lists are named.
       */
      dropValues: z.boolean().default(false),
    })
    .strict(),
  output: z.object({
    listTypes: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        version: z.number().int().positive(),
        created: z.boolean(),
        /** Shared and local lists rewritten to fit the new definition. */
        listsRewritten: z.number().int().nonnegative(),
      }),
    ),
  }),
  handler: async (ctx, input, tx) => {
    const op = "list_types.upsert_many";
    const refusal = await structureWriteRefusal(tx, ctx, op);
    if (refusal) return { ok: false, error: handlerError(op, refusal, true) };
    const branchId = branchOf(ctx);
    const out: {
      id: string;
      slug: string;
      version: number;
      created: boolean;
      listsRewritten: number;
    }[] = [];
    let wrote = false;
    const seen = new Set<string>();

    // #1277 — every definition problem of every list type, before the first write.
    const definitionProblems = input.listTypes.flatMap((item, i): ErrorDetail[] => {
      const { expectedVersion: _v, ...def } = item;
      const twice = input.listTypes.findIndex((t) => t.slug === def.slug) !== i;
      return [
        ...(twice
          ? [
              {
                path: ["listTypes", i, "slug"],
                message: `slug "${def.slug}" appears twice in this call — send each list type once`,
              },
            ]
          : []),
        ...listIssuesToDetails(["listTypes", i], checkListTypeDef(def)),
      ];
    });
    if (definitionProblems.length > 0) {
      return {
        ok: false,
        error: handlerErrorFromDetails(op, definitionProblems, {
          lead: "No list type was written.",
        }),
      };
    }

    for (const [i, item] of input.listTypes.entries()) {
      const { expectedVersion, ...def } = item;
      const at = `listTypes[${i}] ("${def.slug}")`;
      seen.add(def.slug);
      const found = await loadListEntityForUpsert(tx, "listType", branchId, def.slug);
      const existing = found && found.state.deletedAt === null ? found : null;
      const owned = pluginOwnedRefusal(ctx, at, def.slug, found?.ownerPlugin ?? null);
      if (owned) return failBatch(wrote, handlerError(op, owned, true));
      const extIssues = checkDefinitionExt(def, existing?.state.definition ?? null, activeListExt);
      if (extIssues.length > 0) {
        return failBatch(
          wrote,
          handlerError(op, `${at}: ${extIssues.join(" ")} Nothing was written.`, true),
        );
      }
      if (expectedVersion !== undefined && (existing?.state.version ?? 0) !== expectedVersion) {
        return failBatch(
          wrote,
          conflictError(
            op,
            `Conflict: ${at} is at version ${existing?.state.version ?? "none (it does not exist)"}, not ${expectedVersion} — someone changed it since you read it. Read it again (list_types.get) and redo your change on top of it.`,
          ),
        );
      }
      const id = found?.id ?? crypto.randomUUID();
      if (found) {
        const lock = await checkAndAcquireEntityLock(tx, {
          kind: "listType",
          entityId: id,
          chatBranchId: branchId,
          holderKey: ctx.chatTaskId,
        });
        if (!lock.permitted) {
          return failBatch(wrote, await entityWriteBlockedError(tx, op, "listType", id, lock));
        }
      }

      // Impact on existing lists: shared lists of the type + local lists.
      const shared = existing
        ? (await loadListEntities(tx, "list", branchId)).filter((l) => l.state.listTypeId === id)
        : [];
      const local = existing ? await findLocalLists(tx, branchId, def.slug) : [];
      type Target =
        | { kind: "shared"; label: string; listId: string; state: ListState }
        | { kind: "local"; label: string; place: LocalListPlace; items: ListItem[] };
      const targets: Target[] = [
        ...shared.map(
          (l): Target => ({
            kind: "shared",
            label: `list "${l.state.slug}"`,
            listId: l.id,
            state: l.state,
          }),
        ),
        ...local
          .filter((l) => Array.isArray(l.items))
          .map(
            (l): Target => ({
              kind: "local",
              label: describeLocalPlace(l.place),
              place: l.place,
              items: l.items as ListItem[],
            }),
          ),
      ];
      const removals: string[] = [];
      const invalid: string[] = [];
      const rewrites: { target: Target; items: ListItem[] }[] = [];
      for (const target of targets) {
        const before = target.kind === "shared" ? target.state.items : target.items;
        const adapted = adaptItemsToType(before, def, input.dropValues);
        if (!input.dropValues && adapted.removals.length > 0) {
          removals.push(
            `${target.label}: ${adapted.removals.map((r) => `${r.count} × ${r.what}`).join(", ")}`,
          );
          continue;
        }
        const validated = validateListItems(def, adapted.items);
        if (validated.issues.length > 0) {
          invalid.push(`${target.label}: ${describeIssues(validated.issues, 4)}`);
          continue;
        }
        if (JSON.stringify(validated.items) !== JSON.stringify(before)) {
          rewrites.push({ target, items: validated.items });
        }
      }
      if (removals.length > 0) {
        return failBatch(
          wrote,
          handlerError(
            op,
            `${at}: the new definition removes data that lists still hold — ${removals.slice(0, 8).join("; ")}${removals.length > 8 ? `; and ${removals.length - 8} more` : ""}. ` +
              "Keep those node kinds / fields, or set dropValues: true to delete the values (undoable like any change).",
            true,
          ),
        );
      }
      if (invalid.length > 0) {
        return failBatch(
          wrote,
          handlerError(
            op,
            `${at}: existing entries would not fit the new definition — ${invalid.slice(0, 6).join("; ")}${invalid.length > 6 ? `; and ${invalid.length - 6} more` : ""}. ` +
              "Give a new required field a default, keep the old value shape, or fix those entries first (lists.patch_items_many).",
            true,
          ),
        );
      }

      const state: ListTypeState = {
        schemaVersion: 1,
        slug: def.slug,
        definition: def,
        version: (found?.state.version ?? 0) + 1,
        deletedAt: null,
      };
      const entity = await persistListEntity(
        tx,
        ctx.actorId,
        branchId,
        { kind: "listType", entityId: id, state },
        found === null,
      );
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "list_types.upsert_many",
        description: `list_types.upsert_many ${def.slug}${existing ? "" : " (new)"}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: branchId,
        entities: [entity],
      });
      wrote = true;

      // Rewrite the lists the change touched (new defaults, dropped values).
      const listEntities: { kind: "list"; entityId: string; state: ListState }[] = [];
      for (const rw of rewrites) {
        if (rw.target.kind === "shared") {
          const target = rw.target;
          const lock = await checkAndAcquireEntityLock(tx, {
            kind: "list",
            entityId: target.listId,
            chatBranchId: branchId,
            holderKey: ctx.chatTaskId,
          });
          if (!lock.permitted) {
            return failBatch(
              wrote,
              await entityWriteBlockedError(tx, op, "list", target.listId, lock),
            );
          }
          const next: ListState = {
            ...target.state,
            items: rw.items,
            version: target.state.version + 1,
          };
          await persistListEntity(
            tx,
            ctx.actorId,
            branchId,
            { kind: "list", entityId: target.listId, state: next },
            false,
          );
          listEntities.push({ kind: "list", entityId: target.listId, state: next });
          await emitListItemsChanged(
            tx,
            target.listId,
            next.slug,
            target.state.items,
            rw.items,
            branchId,
          );
        } else {
          const r = await rewriteLocalList(ctx, tx, rw.target.place, rw.items);
          if (!r.ok) {
            return failBatch(
              wrote,
              handlerError(op, `${at}: rewriting ${rw.target.label} failed: ${r.message}`),
            );
          }
        }
      }
      if (listEntities.length > 0) {
        await emitSnapshot(tx, {
          actorId: ctx.actorId,
          opKind: "list_types.upsert_many",
          description: `list_types.upsert_many ${def.slug} rewrote ${listEntities.length} list(s)`,
          chatTaskId: ctx.chatTaskId ?? null,
          chatBranchId: branchId,
          entities: listEntities,
        });
      }
      const diff = diffListTypeDefs(existing?.state.definition ?? null, def);
      await emitDomainEvent(tx, {
        kind: "list_type.changed",
        entityId: id,
        payload: {
          slug: def.slug,
          created: existing === null,
          ...diff,
          ...(branchId ? { chatBranchId: branchId } : {}),
        },
      });
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: op,
        input: item,
        succeeded: true,
        entityId: id,
        resultSummary: `${def.slug} v${state.version} rewrote=${rewrites.length}${branchId ? " (branch)" : ""}`,
      });
      out.push({
        id,
        slug: def.slug,
        version: state.version,
        created: existing === null,
        listsRewritten: rewrites.length,
      });
    }
    return ok({ listTypes: out });
  },
});

/**
 * Write a local list back where it lives: a module field default through
 * modules.update, a content instance value through
 * content_instances.set_values — the same ops (locks, snapshot, audit) a
 * direct edit runs.
 */
async function rewriteLocalList(
  ctx: Parameters<typeof updateModuleOp.handler>[0],
  tx: Parameters<typeof updateModuleOp.handler>[2],
  place: LocalListPlace,
  items: ListItem[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (place.kind === "moduleDefault") {
    const module = (await loadModulesInView(tx, ctx.chatBranchId ?? null)).find(
      (m) => m.id === place.moduleId,
    );
    if (!module) return { ok: false, message: `module ${place.moduleId} is gone` };
    const fields = module.fields.map((f) =>
      listFieldsOf([f]).some((lf) => lf.name === place.field)
        ? { ...(f as object), default: items }
        : f,
    );
    const r = await updateModuleOp.handler(
      ctx,
      { moduleId: place.moduleId, fields } as Parameters<typeof updateModuleOp.handler>[1],
      tx,
    );
    return r.ok ? { ok: true } : { ok: false, message: errorText(r.error) };
  }
  const [ci] = (
    await loadInstancesOfModules(tx, ctx.chatBranchId ?? null, [place.moduleId])
  ).filter((c) => c.id === place.contentInstanceId);
  if (!ci) return { ok: false, message: `content instance ${place.contentInstanceId} is gone` };
  const r = await setContentInstanceValuesOp.handler(
    ctx,
    { id: ci.id, values: { ...ci.values, [place.field]: items } },
    tx,
  );
  return r.ok ? { ok: true } : { ok: false, message: errorText(r.error) };
}

function errorText(e: { kind: string; message?: string }): string {
  return e.message ?? e.kind;
}

// ─── list_types.delete_many ──────────────────────────────────────────

export const deleteListTypesManyOp = defineOperation({
  name: "list_types.delete_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ slugs: z.array(z.string().min(1).max(64)).min(1).max(50) }).strict(),
  output: z.object({ deleted: z.array(z.string()) }),
  handler: async (ctx, input, tx) => {
    const op = "list_types.delete_many";
    const refusal = await structureWriteRefusal(tx, ctx, op);
    if (refusal) return { ok: false, error: handlerError(op, refusal, true) };
    const branchId = branchOf(ctx);
    const lists = await loadListEntities(tx, "list", branchId);
    const modules = await loadModulesInView(tx, branchId);
    const deleted: string[] = [];
    let wrote = false;
    for (const slug of [...new Set(input.slugs)]) {
      const t = await loadListEntityBySlug(tx, "listType", branchId, slug);
      if (!t) {
        return failBatch(
          wrote,
          handlerError(op, `no list type "${slug}" — list_types.list shows the ones that exist.`),
        );
      }
      const owned = pluginOwnedRefusal(ctx, `"${slug}"`, slug, t.ownerPlugin);
      if (owned) return failBatch(wrote, handlerError(op, owned, true));
      const using = lists.filter((l) => l.state.listTypeId === t.id).map((l) => l.state.slug);
      const fields = modules.flatMap((m) =>
        listFieldsOf(m.fields)
          .filter((f) => f.listType === slug)
          .map((f) => `module "${m.slug}" field "${f.name}"`),
      );
      if (using.length > 0 || fields.length > 0) {
        await recordAudit(tx, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: op,
          input,
          succeeded: false,
          entityId: t.id,
          resultSummary: `in use lists=${using.length} fields=${fields.length}`,
        });
        return failBatch(
          wrote,
          handlerError(
            op,
            `list type "${slug}" is still in use — ${[
              using.length > 0 ? `lists: ${using.slice(0, 10).join(", ")}` : "",
              fields.length > 0 ? `module fields: ${fields.slice(0, 10).join(", ")}` : "",
            ]
              .filter(Boolean)
              .join(
                "; ",
              )}. Delete those lists (lists.delete_many) and change those fields to another listType first, then retry.`,
            true,
          ),
        );
      }
      const lock = await checkAndAcquireEntityLock(tx, {
        kind: "listType",
        entityId: t.id,
        chatBranchId: branchId,
        holderKey: ctx.chatTaskId,
      });
      if (!lock.permitted) {
        return failBatch(wrote, await entityWriteBlockedError(tx, op, "listType", t.id, lock));
      }
      const state: ListTypeState = {
        ...t.state,
        version: t.state.version + 1,
        deletedAt: new Date().toISOString(),
      };
      const entity = await persistListEntity(
        tx,
        ctx.actorId,
        branchId,
        { kind: "listType", entityId: t.id, state },
        false,
      );
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "list_types.delete_many",
        description: `list_types.delete_many ${slug}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: branchId,
        entities: [entity],
      });
      wrote = true;
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: op,
        input: { slug },
        succeeded: true,
        entityId: t.id,
        resultSummary: `deleted ${slug}${branchId ? " (branch)" : ""}`,
      });
      deleted.push(slug);
    }
    return ok({ deleted });
  },
});
