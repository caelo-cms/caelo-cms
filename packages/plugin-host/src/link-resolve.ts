// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout D) — the link-resolve composition point: where an
 * internal page link goes on the page being rendered.
 *
 * Internal links are stored as page references (`caelo:page/<id>`) and
 * resolved per rendering page by the shared `SiteLinkIndex`. A plugin
 * that splits the site into page variants — international-site: one per
 * language — tells core which variant every page belongs to and which
 * pages are versions of each other. The index then maps a reference on
 * a German page to the German version of the target, in module HTML,
 * rich text, link fields, link lists, nav-menu sets and chrome alike,
 * without the plugin rewriting a single value.
 *
 * The answer is a page partition, not a per-link mapping, on purpose:
 * the template engine resolves synchronously while it renders, so the
 * whole relation has to be in hand before the first page renders, and
 * it is O(pages) where a (rendering page × target) matrix would be
 * O(pages²) for a build.
 *
 * Without an active contributor nothing changes and no plugin is called.
 * The editor preview (and live-edit, which renders through it) and the
 * static generator both resolve through here — one batched call per
 * contributing plugin — and feed the same `createSiteLinkIndex`, so the
 * surfaces cannot disagree.
 *
 * Loud (CLAUDE.md §2): a failing plugin op, an ill-formed answer, an
 * answer for a page that was not asked about, and two plugins answering
 * for the same page all throw.
 *
 * #1269 — a plugin that declares what its answer is computed from
 * (`linkResolveReads`: its own tables, and the columns that matter) has
 * the answer kept per render scope, with the change-journal mark it was
 * read at, like the site view. A render asks the plugin only about pages
 * it has not answered for yet, and asks again from scratch after a
 * journaled change to those tables: a live row whose declared columns
 * changed, a pending row on the render's branch, or a Stage / undo /
 * takeover of a pending change. Without it every preview asked about
 * every page of the site, and international-site read its whole variant
 * table for each. With `pageColumns` declared too, a changed row re-asks
 * only the pages it names (`link-resolve-delta.ts`), not every page.
 */

import { linkResolvePageVariant } from "@caelo-cms/plugin-sdk";
import type { JournalFilter, JournalMark } from "@caelo-cms/query-api";
import type { LinkPageVariant } from "@caelo-cms/shared";
import { checkPluginJournalMark } from "./change-consumers.js";
import {
  hostInfra,
  isPluginDisabled,
  type LoadedPlugin,
  loadedPlugins,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";
import { readLinkResolveDelta } from "./link-resolve-delta.js";
import { reportPluginRenderFailure } from "./render-failures.js";

/** pageId → its variant and variant group. A missing page maps nothing. */
export type ResolvedLinkVariants = ReadonlyMap<string, LinkPageVariant>;

/** True when an active plugin answers the link-resolve point — callers
 *  skip the call entirely otherwise. */
export function hasLinkResolveContributors(): boolean {
  return contributors().length > 0;
}

/** A plugin's answers in one render scope (null: no opinion), valid as of `mark`. */
interface CachedAnswers {
  readonly mark: JournalMark;
  readonly answers: Map<string, LinkPageVariant | null>;
}

/** Per loaded plugin (a reload is a new one), per branch ("" = main). */
const cachedAnswers = new WeakMap<LoadedPlugin, Map<string, CachedAnswers>>();
/** Render scopes kept per plugin, least recently used dropped first. */
const MAX_CACHED_SCOPES = 16;

/**
 * The journal rows that change a plugin's answer in `branchId`'s scope:
 * its declared tables' live rows (an update only when it changed a
 * declared column), its pending rows on that branch, and the Stage /
 * undo / takeover of a pending change (header updates).
 */
export function linkResolveJournalFilter(
  plugin: LoadedPlugin,
  reads: NonNullable<LoadedPlugin["definition"]["linkResolveReads"]>,
  branchId: string | null,
): JournalFilter {
  return {
    kinds: ["plugin_storage", "plugin_row", "snapshot"],
    branchId,
    pluginIds: [plugin.pluginId],
    pluginTables: [...reads.tables],
    kindOps: { snapshot: ["update", "delete", "truncate"] },
    unscopedOps: ["update", "delete", "truncate"],
    branchOnlyKinds: ["plugin_row"],
    // The host's own columns change what a row means however the plugin
    // declared it: a storage delete is an UPDATE of caelo_deleted_at, and a
    // row's branch moves with caelo_chat_branch_id.
    // A page column always counts: a row that moves to another page changes
    // two pages' answers, whatever `columns` lists.
    ...(reads.columns
      ? {
          columns: {
            plugin_storage: [
              ...new Set([
                ...reads.columns,
                ...Object.values(reads.pageColumns ?? {}),
                ...HOST_VISIBILITY_COLUMNS,
              ]),
            ],
          },
        }
      : {}),
  };
}

/** Host-managed storage columns that make a row appear or disappear. */
const HOST_VISIBILITY_COLUMNS = ["caelo_deleted_at", "caelo_chat_branch_id"] as const;

/** Test seam: forget every kept answer. */
export function clearLinkResolveCache(): void {
  for (const lp of loadedPlugins.all()) cachedAnswers.delete(lp);
}

function contributors() {
  return loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.linkResolveOperation === "string")
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Ask every contributing plugin for the page-variant partition.
 *
 * @param pageIds every page the render can link to (the link index's
 *   pages: the whole site in the render's scope, drafts included).
 */
export async function resolveLinkVariants(
  pageIds: ReadonlyArray<string>,
  scope: RenderScope,
  opts: {
    /**
     * #1269 — serve a plugin's kept answers (it declares `linkResolveReads`)
     * when nothing they derive from changed. Checks the change journal on
     * its own connection, so pass it only with no transaction held — the
     * editor preview, which asks about the whole site on every render.
     */
    readonly keep?: boolean;
  } = {},
): Promise<ResolvedLinkVariants> {
  const out = new Map<string, LinkPageVariant>();
  if (pageIds.length === 0) return out;
  const plugins = contributors();
  if (plugins.length === 0) return out;
  const answeredBy = new Map<string, string>();

  for (const lp of plugins) {
    const operationName = lp.definition.linkResolveOperation as string;
    const reads = opts.keep ? lp.definition.linkResolveReads : undefined;
    const scopeKey = scope.chatBranchId ?? "";
    let kept: CachedAnswers | null = null;
    let toAsk: readonly string[] = pageIds;
    if (reads) {
      const scopes = cachedAnswers.get(lp) ?? new Map<string, CachedAnswers>();
      cachedAnswers.set(lp, scopes);
      const hit = scopes.get(scopeKey);
      const infra = hostInfra();
      // Taken before the plugin reads, so a change committing meanwhile
      // is unseen by the mark and invalidates once.
      const filter = linkResolveJournalFilter(lp, reads, scope.chatBranchId ?? null);
      const { fresh, mark } = await checkPluginJournalMark(
        infra.adapter,
        infra.registry,
        hit?.mark ?? null,
        filter,
      );
      let answers = new Map<string, LinkPageVariant | null>();
      if (hit && fresh) answers = hit.answers;
      else if (hit && reads.pageColumns) {
        // Carry the kept answers forward: drop only the pages a changed row
        // names; those are asked again below with the pages never asked.
        const delta = await readLinkResolveDelta(infra.adapter, infra.registry, {
          pluginId: lp.pluginId,
          schema: `plugin_${lp.slug.replace(/-/g, "_")}`,
          pageColumns: reads.pageColumns,
          from: hit.mark,
          to: mark,
          filter,
        });
        if ("pages" in delta) {
          answers = new Map(hit.answers);
          for (const id of delta.pages) answers.delete(id);
        } else {
          // One line per whole re-ask, with why: the scale gate counts them.
          console.info(`[link-resolve] ${lp.slug} asked about every page again: ${delta.whole}`);
        }
      }
      kept = { mark, answers };
      toAsk = pageIds.filter((id) => !kept?.answers.has(id));
    }
    // A refill that is kept must be read after its mark: the render pass's
    // memo (renderId) may hold the plugin's rows from an earlier hook of
    // this pass, read before the mark — so a kept read gets a pass of its own.
    const askScope = kept ? { ...scope, renderId: crypto.randomUUID() } : scope;
    const fromPlugin = toAsk.length > 0 ? await askPlugin(lp, operationName, toAsk, askScope) : {};
    if (fromPlugin === null) continue; // reported as a render failure (#1087)
    const askedNow = new Set(toAsk);
    const answers = new Map<string, LinkPageVariant | null>(kept?.answers ?? []);
    for (const id of toAsk) answers.set(id, null);
    for (const [pageId, raw] of Object.entries(fromPlugin)) {
      if (!askedNow.has(pageId)) {
        throw new Error(
          `link-resolve: plugin "${lp.slug}" answered for page ${pageId}, which is not part of this render`,
        );
      }
      const parsed = linkResolvePageVariant.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `link-resolve: plugin "${lp.slug}" returned an invalid answer for page ${pageId}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      answers.set(pageId, { variant: parsed.data.variant, group: parsed.data.group });
    }
    if (kept && !kept.mark.dirty) {
      const scopes = cachedAnswers.get(lp) as Map<string, CachedAnswers>;
      scopes.delete(scopeKey);
      scopes.set(scopeKey, { mark: kept.mark, answers });
      while (scopes.size > MAX_CACHED_SCOPES) {
        const oldest = scopes.keys().next().value;
        if (oldest === undefined) break;
        scopes.delete(oldest);
      }
    }
    // Each page once: a repeated id is one page, not a second contributor.
    for (const pageId of new Set(pageIds)) {
      const answer = answers.get(pageId);
      if (!answer) continue;
      const other = answeredBy.get(pageId);
      if (other !== undefined) {
        // Two partitions of one page cannot both decide where its links
        // go; whichever won would silently override the other.
        throw new Error(
          `link-resolve: page ${pageId} is placed in a variant by both "${other}" and "${lp.slug}". A page can have at most one link resolver.`,
        );
      }
      answeredBy.set(pageId, lp.slug);
      out.set(pageId, answer);
    }
  }
  return out;
}

/**
 * One call of the plugin's link-resolve operation for `pageIds`: its raw
 * answers by page, or null when it failed and the render goes on without
 * it (reported, #1087). Any other failure throws.
 */
async function askPlugin(
  lp: LoadedPlugin,
  operationName: string,
  pageIds: readonly string[],
  scope: RenderScope,
): Promise<Record<string, unknown> | null> {
  const r = await runPluginOperation({
    invocation: renderInvocation(scope),
    pluginSlug: lp.slug,
    operationName,
    args: { pageIds: [...pageIds] },
  });
  if (!r.ok) {
    const reason = `link-resolve: ${lp.slug}.${operationName} failed: ${r.error.kind}: ${r.error.message}`;
    // #1087 — a preview renders without this plugin's partition (links
    // then resolve as on a single-variant site) and flags it.
    if (reportPluginRenderFailure(scope, { slug: lp.slug, point: "link-resolve", reason })) {
      return null;
    }
    throw new Error(reason);
  }
  return (r.value as { pages?: Record<string, unknown> } | null)?.pages ?? {};
}
