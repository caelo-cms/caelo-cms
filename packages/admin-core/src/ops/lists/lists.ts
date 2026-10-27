// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — `lists.*` ops (docs/lists.md §4, §12): shared lists — a
 * site's menus, footer links, categories, tags and any other repeated
 * data that more than one place shows.
 *
 * Every read is the caller's draft view (`lists/store.ts`); every write
 * validates the entries against the list type (`validateListItems` plus
 * the DB-backed checks on embedded modules and terms), stores internal
 * links as references, takes the entity lock (a stale draft write is an
 * AI-actionable conflict), snapshots, audits and emits
 * `list.items_changed`. Bulk variants run in one transaction; a failure
 * rolls the whole batch back and names the item.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  applyListItemPatches,
  LIST_TYPE_ROLES,
  type ListItem,
  ListPatchError,
  listItemInputSchema,
  ok,
  validateListItems,
} from "@caelo-cms/shared";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { emitDomainEvent } from "../../domain-events.js";
import { withHumanisedLinks } from "../../links/humanise.js";
import { recordPendingImportLinks } from "../../links/import-targets.js";
import {
  type ListEntityView,
  loadListEntities,
  loadListEntity,
  loadListEntityBySlug,
  loadListEntityForUpsert,
  persistListEntity,
} from "../../lists/store.js";
import { isBound, loadListUsage } from "../../lists/usage.js";
import { checkAndAcquireEntityLock, entityWriteBlockedError } from "../../locks.js";
import { emitSnapshot } from "../../snapshots/index.js";
import type { ListState } from "../../snapshots/state.js";
import {
  branchOf,
  canonicaliseItemsForWrite,
  checkEntryRefs,
  describeIssues,
  emitListItemsChanged,
  failBatch,
  handlerError,
  listTypesBySlug,
  sourceEntriesOf,
  type Tx,
} from "./_shared.js";

const slugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, "list slug: lowercase letters, digits, hyphens");

const usageSchema = z.object({
  modules: z.array(
    z.object({
      moduleId: z.string(),
      slug: z.string(),
      displayName: z.string(),
      field: z.string(),
    }),
  ),
  placementCount: z.number().int().nonnegative(),
  samplePages: z.array(z.object({ pageId: z.string(), path: z.string(), title: z.string() })),
  pageTypes: z.array(z.string()),
  taggedPageCount: z.number().int().nonnegative(),
});

const listSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  purpose: z.string(),
  /** List type slug. */
  type: z.string(),
  role: z.enum(LIST_TYPE_ROLES),
  itemCount: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  updatedAt: z.string(),
  usage: usageSchema,
  /** The entries, only with `includeItems` (one read for a plugin that plans over every list). */
  items: z.array(z.unknown()).optional(),
});

function countItems(items: readonly ListItem[]): number {
  return items.reduce((n, it) => n + 1 + countItems(it.children ?? []), 0);
}

function textOf(items: readonly ListItem[]): string {
  return JSON.stringify(items).toLowerCase();
}

// ─── lists.list ──────────────────────────────────────────────────────

export const listListsOp = withHumanisedLinks(
  defineOperation({
    name: "lists.list",
    // Why plugin: the `lists` read grant (docs/lists.md §9) — a plugin
    // reaches list data only through named ops of the domain.
    actorScope: ["human", "ai", "plugin", "system"],
    database: "cms_admin",
    input: z
      .object({
        /** List type slug. */
        type: z.string().min(1).max(64).optional().describe("List type slug."),
        role: z.enum(LIST_TYPE_ROLES).optional(),
        /** Free-text match on slug, name, purpose and entry text. */
        query: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe("Free text over slug, name, purpose, entry text."),
        /**
         * Return every list's entries too. For a translation plugin that
         * resolves every list of a render in one read (docs/lists.md §9);
         * the AI reads one list's entries with lists.get.
         */
        includeItems: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ lists: z.array(listSummarySchema) }),
    handler: async (ctx, input, tx) => {
      const branchId = branchOf(ctx);
      const types = await listTypesBySlug(tx, branchId);
      const typeById = new Map([...types.values()].map((t) => [t.id, t.def]));
      const q = input.query?.toLowerCase();
      const lists = (await loadListEntities(tx, "list", branchId)).filter((l) => {
        const def = typeById.get(l.state.listTypeId);
        if (!def) return false;
        if (input.type !== undefined && def.slug !== input.type) return false;
        if (input.role !== undefined && def.role !== input.role) return false;
        if (q !== undefined) {
          const hay = `${l.state.slug} ${l.state.name} ${l.state.purpose}`.toLowerCase();
          if (!hay.includes(q) && !textOf(l.state.items).includes(q)) return false;
        }
        return true;
      });
      const usage = await loadListUsage(
        tx,
        branchId,
        lists.map((l) => l.id),
      );
      return ok({
        lists: lists.map((l) => {
          const def = typeById.get(l.state.listTypeId);
          const u = usage.get(l.id);
          return {
            id: l.id,
            slug: l.state.slug,
            name: l.state.name,
            purpose: l.state.purpose,
            type: def?.slug ?? "",
            role: def?.role ?? "content",
            itemCount: countItems(l.state.items),
            version: l.state.version,
            updatedAt: l.updatedAt,
            usage: {
              modules: [...(u?.modules ?? [])],
              placementCount: u?.placementCount ?? 0,
              samplePages: [...(u?.samplePages ?? [])],
              pageTypes: [...(u?.pageTypes ?? [])],
              taggedPageCount: u?.taggedPageCount ?? 0,
            },
            ...(input.includeItems ? { items: [...l.state.items] } : {}),
          };
        }),
      });
    },
  }),
);

// ─── lists.get ───────────────────────────────────────────────────────

export const getListOp = withHumanisedLinks(
  defineOperation({
    name: "lists.get",
    // Why plugin: the `lists` read grant (see lists.list).
    actorScope: ["human", "ai", "plugin", "system"],
    database: "cms_admin",
    input: z
      .object({ slug: z.string().min(1).max(64).optional(), id: z.string().uuid().optional() })
      .strict()
      .refine((v) => (v.slug === undefined) !== (v.id === undefined), {
        message: "pass exactly one of slug, id",
      }),
    output: z.object({
      list: listSummarySchema.extend({ items: z.array(listItemInputSchema) }),
    }),
    handler: async (ctx, input, tx) => {
      const branchId = branchOf(ctx);
      const l = input.id
        ? await loadListEntity(tx, "list", branchId, input.id)
        : await loadListEntityBySlug(tx, "list", branchId, input.slug ?? "");
      if (!l || l.state.deletedAt !== null) {
        const known = (await loadListEntities(tx, "list", branchId)).map((x) => x.state.slug);
        return {
          ok: false,
          error: handlerError(
            "lists.get",
            `no list ${input.slug ? `"${input.slug}"` : input.id} — the site has ${known.slice(0, 30).join(", ") || "none"}. Use one of those, or create it with lists.upsert_many.`,
          ),
        };
      }
      const types = await listTypesBySlug(tx, branchId);
      const def = [...types.values()].find((t) => t.id === l.state.listTypeId)?.def;
      const u = (await loadListUsage(tx, branchId, [l.id])).get(l.id);
      return ok({
        list: {
          id: l.id,
          slug: l.state.slug,
          name: l.state.name,
          purpose: l.state.purpose,
          type: def?.slug ?? "",
          role: def?.role ?? "content",
          itemCount: countItems(l.state.items),
          version: l.state.version,
          updatedAt: l.updatedAt,
          usage: {
            modules: [...(u?.modules ?? [])],
            placementCount: u?.placementCount ?? 0,
            samplePages: [...(u?.samplePages ?? [])],
            pageTypes: [...(u?.pageTypes ?? [])],
            taggedPageCount: u?.taggedPageCount ?? 0,
          },
          items: structuredClone(l.state.items) as z.infer<typeof listItemInputSchema>[],
        },
      });
    },
  }),
);

// ─── shared write step ───────────────────────────────────────────────

/**
 * Validate `items` for list `listId` (null = new) of type `typeSlug`,
 * store links as references, persist for the caller and return the new
 * state. Errors are AI-actionable and prefixed with `at`.
 */
async function writeList(
  ctx: Parameters<typeof upsertListsManyOp.handler>[0],
  tx: Tx,
  args: {
    readonly at: string;
    /** The entity written (a deleted one is revived), or null for a new list. */
    readonly found: ListEntityView<"list"> | null;
    readonly slug: string;
    readonly name: string;
    readonly purpose: string;
    readonly typeSlug: string;
    readonly items: unknown;
  },
): Promise<{ ok: true; id: string; state: ListState } | { ok: false; message: string }> {
  const branchId = branchOf(ctx);
  const types = await listTypesBySlug(tx, branchId);
  const type = types.get(args.typeSlug);
  if (!type) {
    return {
      ok: false,
      message: `${args.at}: no list type "${args.typeSlug}" — the site has ${[...types.keys()].join(", ")}. Pick one (menu for navigation, links for a flat link group, categories / tags for vocabularies) or create the type with list_types.upsert_many.`,
    };
  }
  const id = args.found?.id ?? crypto.randomUUID();
  const live = args.found && args.found.state.deletedAt === null ? args.found : null;
  // Reads humanise references (lists.get shows `/about`, `/_caelo/media/hero`),
  // but a media value and a query's `parent` validate only as references.
  // So links become references BEFORE validation, which keeps a
  // read-modify-write round trip of lists.get lossless (epic #724) for the
  // AI and the editor alike. Input that is not even entry-shaped skips this
  // and gets validation's own message.
  let input: unknown = args.items;
  let pending: Extract<
    Awaited<ReturnType<typeof canonicaliseItemsForWrite>>,
    { ok: true }
  >["pending"] = null;
  const shaped = z.array(listItemInputSchema).safeParse(args.items);
  if (shaped.success) {
    const canon = await canonicaliseItemsForWrite(
      tx,
      ctx,
      type.def,
      shaped.data as ListItem[],
      live?.state.items,
    );
    if (!canon.ok) return { ok: false, message: `${args.at}: ${canon.message}` };
    input = canon.items;
    pending = canon.pending;
  }
  const validated = validateListItems(type.def, input);
  if (validated.issues.length > 0) {
    return {
      ok: false,
      message: `${args.at}: ${describeIssues(validated.issues)}. Fix those entries and resend (list_types.get "${args.typeSlug}" shows the fields each node kind takes).`,
    };
  }
  const refIssues = await checkEntryRefs(tx, branchId, type.def, validated.items, id);
  if (refIssues.length > 0) {
    return { ok: false, message: `${args.at}: ${describeIssues(refIssues)}.` };
  }
  const state: ListState = {
    schemaVersion: 1,
    slug: args.slug,
    name: args.name,
    purpose: args.purpose,
    listTypeId: type.id,
    items: validated.items,
    version: (args.found?.state.version ?? 0) + 1,
    deletedAt: null,
  };
  await persistListEntity(
    tx,
    ctx.actorId,
    branchId,
    { kind: "list", entityId: id, state },
    args.found === null,
  );
  // Links to pages the chat's import run will still build stay literal;
  // the run's finalisation (imports.resolve_links) rewrites this list.
  await recordPendingImportLinks(tx, pending, { kind: "list", id });
  return { ok: true, id, state };
}

async function lockList(
  ctx: Parameters<typeof upsertListsManyOp.handler>[0],
  tx: Tx,
  operation: string,
  id: string,
): Promise<
  { ok: true } | { ok: false; error: Awaited<ReturnType<typeof entityWriteBlockedError>> }
> {
  const lock = await checkAndAcquireEntityLock(tx, {
    kind: "list",
    entityId: id,
    chatBranchId: ctx.chatBranchId,
    holderKey: ctx.chatTaskId,
  });
  if (lock.permitted) return { ok: true };
  return { ok: false, error: await entityWriteBlockedError(tx, operation, "list", id, lock) };
}

function conflictMessage(at: string, found: number | null, expected: number): string {
  return `Conflict: ${at} is at version ${found ?? "none (it does not exist)"}, not ${expected} — it changed since you read it. Read it again (lists.get) and redo your change on top of it; do not resend the old entries.`;
}

// ─── lists.upsert_many ───────────────────────────────────────────────

const upsertListSchema = z
  .object({
    slug: slugSchema,
    name: z.string().min(1).max(200),
    /** Why this list exists and where it shows (CLAUDE.md §1A). */
    purpose: z
      .string()
      .min(1)
      .max(1000)
      .describe("Why + where it shows, e.g. 'Main navigation in the site header'."),
    /** List type slug (`menu`, `links`, `categories`, …). */
    type: z.string().min(1).max(64).describe("List type slug (`list_list_types`)."),
    /** The whole entry tree; ids of existing entries keep their identity. */
    items: z
      .array(listItemInputSchema)
      .max(500)
      .describe(
        "WHOLE entry tree. Keep `id` of existing entries, omit for new. `values` keyed by the node's fields; terms `caelo:term/<listId>/<itemId>`. `children` only under nodes allowing them. `query` only on source nodes, only the knobs its source lists in `editable` (e.g. {limit:5}); omit = type `defaults`. " +
          "Links `{href}`: internal path (`/about`) of an EXISTING page (`list_pages`; else build an empty shell first: `build_page` with `modules: []`); `/` and `/#section` always valid; pages of an import run rebuilt in this chat are kept for `resolve_import_links`; external = full `https://` URL. " +
          'E.g. (menu): [{"node":"entry","values":{"label":"Company","link":{"href":"/about"}},"children":[{"node":"entry","values":{"label":"Team","link":{"href":"/about/team"}}}]}]',
      ),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

/** Create or replace shared lists (whole entry tree), one transaction. */
export const upsertListsManyOp = defineOperation({
  name: "lists.upsert_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ lists: z.array(upsertListSchema).min(1).max(50) }).strict(),
  output: z.object({
    lists: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        version: z.number().int().positive(),
        created: z.boolean(),
        itemCount: z.number().int().nonnegative(),
        /** Entries filled from a source — the ids preview_list_source takes. */
        sourceEntries: z.array(z.object({ id: z.string(), node: z.string() })),
      }),
    ),
  }),
  handler: async (ctx, input, tx) => {
    const op = "lists.upsert_many";
    const branchId = branchOf(ctx);
    const out: {
      id: string;
      slug: string;
      version: number;
      created: boolean;
      itemCount: number;
      sourceEntries: { id: string; node: string }[];
    }[] = [];
    const entities: { kind: "list"; entityId: string; state: ListState }[] = [];
    const typesById = new Map(
      [...(await listTypesBySlug(tx, branchId)).values()].map((t) => [t.id, t.def]),
    );
    let wrote = false;
    const seen = new Set<string>();
    for (const [i, item] of input.lists.entries()) {
      const at = `lists[${i}] ("${item.slug}")`;
      if (seen.has(item.slug)) {
        return failBatch(
          wrote,
          handlerError(op, `${at}: slug appears twice in this call — send each list once.`),
        );
      }
      seen.add(item.slug);
      const found = await loadListEntityForUpsert(tx, "list", branchId, item.slug);
      const existing = found && found.state.deletedAt === null ? found : null;
      if (
        item.expectedVersion !== undefined &&
        (existing?.state.version ?? null) !== item.expectedVersion
      ) {
        return failBatch(
          wrote,
          handlerError(
            op,
            conflictMessage(at, existing?.state.version ?? null, item.expectedVersion),
          ),
        );
      }
      if (found) {
        const lock = await lockList(ctx, tx, op, found.id);
        if (!lock.ok) return failBatch(wrote, lock.error);
      }
      const r = await writeList(ctx, tx, {
        at,
        found,
        slug: item.slug,
        name: item.name,
        purpose: item.purpose,
        typeSlug: item.type,
        items: item.items,
      });
      if (!r.ok)
        return failBatch(wrote, handlerError(op, `${r.message} The whole batch was rolled back.`));
      wrote = true;
      entities.push({ kind: "list", entityId: r.id, state: r.state });
      await emitListItemsChanged(
        tx,
        r.id,
        item.slug,
        existing?.state.items ?? [],
        r.state.items,
        branchId,
      );
      out.push({
        id: r.id,
        slug: item.slug,
        version: r.state.version,
        created: existing === null,
        itemCount: countItems(r.state.items),
        sourceEntries: (() => {
          const def = typesById.get(r.state.listTypeId);
          return def ? sourceEntriesOf(def, r.state.items) : [];
        })(),
      });
    }
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "lists.upsert_many",
      description: `lists.upsert_many ${out.map((o) => o.slug).join(", ")}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: branchId,
      entities,
    });
    // One audit row per list, naming it: the redeploy trigger reads the
    // entity id to rebuild exactly the pages that show the list.
    for (const o of out) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: op,
        input,
        succeeded: true,
        entityId: o.id,
        resultSummary: `${o.slug} v${o.version}${branchId ? " (branch)" : ""}`,
      });
    }
    return ok({ lists: out });
  },
});

// ─── lists.patch_items_many ──────────────────────────────────────────

const patchSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("add"),
      /** Parent entry id; omit for the top level. */
      parentId: z.string().uuid().nullable().optional(),
      /** 0-based; omit to append. */
      position: z.number().int().nonnegative().optional(),
      item: listItemInputSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("update"),
      itemId: z.string().uuid(),
      /** Merged into the entry's values; `null` removes a value. */
      values: z.record(z.string(), z.unknown()).optional(),
      query: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("move"),
      itemId: z.string().uuid(),
      parentId: z.string().uuid().nullable().optional(),
      position: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ op: z.literal("remove"), itemId: z.string().uuid() }).strict(),
]);

/**
 * Item-level edits by entry id — add, update, move, remove — without
 * resending the whole tree. Preferred for "add Careers under Company".
 */
export const patchListItemsManyOp = defineOperation({
  name: "lists.patch_items_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      lists: z
        .array(
          z
            .object({
              slug: z.string().min(1).max(64),
              expectedVersion: z.number().int().positive().optional(),
              patches: z.array(patchSchema).min(1).max(200),
            })
            .strict(),
        )
        .min(1)
        .max(50),
    })
    .strict(),
  output: z.object({
    lists: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        version: z.number().int().positive(),
        /** Ids of the entries `add` patches created, in patch order. */
        addedItemIds: z.array(z.string()),
      }),
    ),
  }),
  handler: async (ctx, input, tx) => {
    const op = "lists.patch_items_many";
    const branchId = branchOf(ctx);
    const out: { id: string; slug: string; version: number; addedItemIds: string[] }[] = [];
    const entities: { kind: "list"; entityId: string; state: ListState }[] = [];
    let wrote = false;
    for (const [i, entry] of input.lists.entries()) {
      const at = `lists[${i}] ("${entry.slug}")`;
      const existing = await loadListEntityBySlug(tx, "list", branchId, entry.slug);
      if (!existing) {
        return failBatch(
          wrote,
          handlerError(
            op,
            `${at}: no list "${entry.slug}" — lists.list shows the lists that exist; create a new one with lists.upsert_many.`,
          ),
        );
      }
      if (entry.expectedVersion !== undefined && existing.state.version !== entry.expectedVersion) {
        return failBatch(
          wrote,
          handlerError(op, conflictMessage(at, existing.state.version, entry.expectedVersion)),
        );
      }
      const lock = await lockList(ctx, tx, op, existing.id);
      if (!lock.ok) return failBatch(wrote, lock.error);
      // Mint ids for added entries up front so the caller learns them.
      const addedItemIds: string[] = [];
      const patches = entry.patches.map((p) => {
        if (p.op !== "add") return p;
        const id = p.item.id ?? crypto.randomUUID();
        addedItemIds.push(id);
        return { ...p, item: { ...p.item, id } };
      });
      let next: unknown;
      try {
        next = applyListItemPatches(existing.state.items, patches);
      } catch (e) {
        if (e instanceof ListPatchError) {
          return failBatch(
            wrote,
            handlerError(
              op,
              `${at}: ${e.message} Read the list (lists.get) for the current entry ids and retry.`,
            ),
          );
        }
        throw e;
      }
      const types = await listTypesBySlug(tx, branchId);
      const typeSlug = [...types.values()].find((t) => t.id === existing.state.listTypeId)?.def
        .slug;
      if (!typeSlug) {
        return failBatch(
          wrote,
          handlerError(
            op,
            `${at}: the list's type no longer exists — recreate it or move the list to another type with lists.upsert_many.`,
          ),
        );
      }
      const r = await writeList(ctx, tx, {
        at,
        found: existing,
        slug: existing.state.slug,
        name: existing.state.name,
        purpose: existing.state.purpose,
        typeSlug,
        items: next,
      });
      if (!r.ok)
        return failBatch(wrote, handlerError(op, `${r.message} The whole batch was rolled back.`));
      wrote = true;
      entities.push({ kind: "list", entityId: r.id, state: r.state });
      await emitListItemsChanged(
        tx,
        r.id,
        existing.state.slug,
        existing.state.items,
        r.state.items,
        branchId,
      );
      out.push({ id: r.id, slug: existing.state.slug, version: r.state.version, addedItemIds });
    }
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "lists.patch_items_many",
      description: `lists.patch_items_many ${out.map((o) => o.slug).join(", ")}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: branchId,
      entities,
    });
    // One audit row per list, naming it: the redeploy trigger reads the
    // entity id to rebuild exactly the pages that show the list.
    for (const o of out) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: op,
        input,
        succeeded: true,
        entityId: o.id,
        resultSummary: `${o.slug} v${o.version}${branchId ? " (branch)" : ""}`,
      });
    }
    return ok({ lists: out });
  },
});

// ─── lists.delete_many ───────────────────────────────────────────────

/** Delete shared lists nothing uses any more. Refused while bound (names who binds it). */
export const deleteListsManyOp = defineOperation({
  name: "lists.delete_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ slugs: z.array(z.string().min(1).max(64)).min(1).max(50) }).strict(),
  output: z.object({ deleted: z.array(z.string()) }),
  handler: async (ctx, input, tx) => {
    const op = "lists.delete_many";
    const branchId = branchOf(ctx);
    const deleted: string[] = [];
    const entities: { kind: "list"; entityId: string; state: ListState }[] = [];
    let wrote = false;
    for (const slug of [...new Set(input.slugs)]) {
      const l = await loadListEntityBySlug(tx, "list", branchId, slug);
      if (!l) {
        return failBatch(
          wrote,
          handlerError(op, `no list "${slug}" — lists.list shows the lists that exist.`),
        );
      }
      const usage = (await loadListUsage(tx, branchId, [l.id])).get(l.id);
      if (usage && isBound(usage)) {
        const parts = [
          usage.modules.length > 0
            ? `modules binding it: ${usage.modules.map((m) => `"${m.slug}" (field ${m.field})`).join(", ")}`
            : "",
          usage.contentInstanceIds.length > 0
            ? `content instances pointing at it: ${usage.contentInstanceIds.slice(0, 10).join(", ")}`
            : "",
          usage.pageTypes.length > 0
            ? `page types using it as a vocabulary: ${usage.pageTypes.join(", ")}`
            : "",
          usage.taggedPageCount > 0 ? `${usage.taggedPageCount} page(s) carry its terms` : "",
        ].filter(Boolean);
        await recordAudit(tx, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: op,
          input,
          succeeded: false,
          entityId: l.id,
          resultSummary: "blocked: bound",
        });
        return failBatch(
          wrote,
          handlerError(
            op,
            `list "${slug}" is still in use — ${parts.join("; ")}. Bind those module fields to another list (or make them local), remove it from the page types' vocabularies and the pages' terms, then retry the delete.`,
            true,
          ),
        );
      }
      const lock = await lockList(ctx, tx, op, l.id);
      if (!lock.ok) return failBatch(wrote, lock.error);
      const state: ListState = {
        ...l.state,
        version: l.state.version + 1,
        deletedAt: new Date().toISOString(),
      };
      await persistListEntity(
        tx,
        ctx.actorId,
        branchId,
        { kind: "list", entityId: l.id, state },
        false,
      );
      wrote = true;
      entities.push({ kind: "list", entityId: l.id, state });
      await emitDomainEvent(tx, {
        kind: "list.deleted",
        entityId: l.id,
        payload: { slug, ...(branchId ? { chatBranchId: branchId } : {}) },
      });
      deleted.push(slug);
    }
    await emitSnapshot(tx, {
      actorId: ctx.actorId,
      opKind: "lists.delete_many",
      description: `lists.delete_many ${deleted.join(", ")}`,
      chatTaskId: ctx.chatTaskId ?? null,
      chatBranchId: branchId,
      entities,
    });
    for (const e of entities) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: op,
        input,
        succeeded: true,
        entityId: e.entityId,
        resultSummary: `deleted ${e.state.slug}${branchId ? " (branch)" : ""}`,
      });
    }
    return ok({ deleted });
  },
});

export { writeList as writeListForOps };
