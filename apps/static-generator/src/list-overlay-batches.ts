// SPDX-License-Identifier: MPL-2.0

/**
 * #1307 — the build's `list-resolve` overlays, asked per page batch
 * instead of once for the whole site.
 *
 * The whole-site call made international-site read every content
 * instance with its values, every module and every page in one answer: it
 * timed out under contention and grew with the site. A batch asks with
 * the union of its pages' scopes (`pageListOverlayScope`, the same scope
 * the editor preview sends for one page), per output variant of its
 * pages, so the answer costs what the batch costs.
 *
 * Two parts of a scope do not grow with the batch: every shared list
 * (each scope names them all) and, when a page generates page entries (a
 * query, children, breadcrumbs), every page of its variant with
 * properties. Those are asked once per variant and kept for the rest of
 * the build — their overlay values do not depend on which batch asks (the
 * overlay of a source depends only on that source, its stored rows and
 * the variants of the pages its links point at, list-resolve.ts in
 * international-site). Everything else — the batch's content instances
 * and the batch's own pages — is asked per batch and dropped with it, so
 * the build's memory does not grow with the site (#1271, #1301).
 *
 * All calls of one build share one pass id (`RenderScope.renderId`): a
 * plugin reads what no scope changes (its list types, every list, the
 * page types) once per build, not once per batch.
 */

import type {
  BuildPluginServices,
  PluginListOverlays,
  ResolvedListOverlays,
} from "@caelo-cms/plugin-host";
import { overlayIssueOwner } from "@caelo-cms/plugin-host";
import {
  type ListOverlayIssue,
  type ListOverlayScope,
  type ListRenderData,
  pageListOverlayScope,
  type ScopedModule,
} from "@caelo-cms/shared";

/** One page of a batch, as far as its overlay scope goes. */
export interface OverlayBatchPage {
  readonly pageId: string;
  /** Every module the page renders: placed, chrome, nested, content variants. */
  readonly modules: readonly ScopedModule[];
  /** The template's and the layout's HTML. */
  readonly markup: readonly string[];
  /** The stored content instances the page renders (variant content excluded). */
  readonly contentInstanceIds: readonly string[];
}

/**
 * Pages outside the batch one call asks for, at most: the generated-page
 * set of a large site goes in slices, so no single call carries the site.
 */
export const KEPT_PAGES_PER_CALL = 1_000;

/** One variant's overlay as plain JSON (the shape `PluginListOverlays` carries). */
interface VariantOverlay {
  values: Record<string, unknown>;
  hidden: string[];
}

/** What one variant asks in this batch. */
interface VariantAsk {
  listIds: Set<string>;
  contentInstanceIds: Set<string>;
  /** The batch's own pages of this variant. */
  ownPageIds: Set<string>;
  /** Other pages whose props the batch's pages can show (generated entries). */
  otherPageIds: Set<string>;
}

const PAGE_PROPS_RE = /^page\/([^/]+)\/props\//;

/** The build's per-batch `list-resolve` overlays (see the file header). */
export class BuildListOverlays {
  readonly #plugins: BuildPluginServices;
  readonly #data: ListRenderData;
  readonly #passId: string;
  /** Per variant: whether the shared lists were answered. */
  readonly #listsAsked = new Set<string>();
  /** Per variant: the pages outside a batch whose props were answered (kept). */
  readonly #keptPages = new Map<string, Set<string>>();
  /** Per plugin, per variant: the kept part of its answers. */
  readonly #kept = new Map<string, Map<string, VariantOverlay>>();
  /** The answers of the batch being rendered (issue attribution). */
  #current: ResolvedListOverlays | undefined;
  readonly #issues: ListOverlayIssue[] = [];
  /** Per plugin, per variant: the refused addresses (what `reportListOverlayIssues` attributes by). */
  readonly #issueOwners = new Map<string, Map<string, VariantOverlay>>();

  /**
   * @param data the build's list render data without overlays.
   * @param passId one id for every call of this build.
   */
  constructor(plugins: BuildPluginServices, data: ListRenderData, passId: string) {
    this.#plugins = plugins;
    this.#data = data;
    this.#passId = passId;
  }

  /**
   * The overlays the batch's pages need, or undefined when none of them
   * shows anything an overlay can change (no plugin is asked then).
   */
  async forBatch(pages: readonly OverlayBatchPage[]): Promise<ResolvedListOverlays | undefined> {
    const asks = this.#asksOf(pages);
    if (asks.size === 0) {
      this.#current = undefined;
      return undefined;
    }
    const batch = new Map<string, Map<string, VariantOverlay>>();
    // In variant order, so a build asks the same calls every time.
    for (const [variant, ask] of [...asks].sort(([a], [b]) => a.localeCompare(b))) {
      for (const call of this.#callsOf(variant, ask)) {
        const answer = await this.#plugins.resolveListOverlays([variant], call.scope, this.#passId);
        this.#take(variant, answer, call.keep, batch);
      }
      this.#listsAsked.add(variant);
    }
    this.#current = this.#merge(new Set(asks.keys()), batch);
    return this.#current;
  }

  /**
   * Note overlay entries the render of the current batch refused, for
   * {@link issueReport}. Repeats (every batch re-prepares the kept list
   * overlays) are folded.
   */
  noteIssues(issues: readonly ListOverlayIssue[]): void {
    for (const issue of issues) {
      if (this.#issues.some((i) => i.address === issue.address && i.variant === issue.variant)) {
        continue;
      }
      this.#issues.push(issue);
      const owner = this.#current ? overlayIssueOwner(this.#current, issue) : null;
      if (owner === null) continue;
      const byVariant = this.#issueOwners.get(owner) ?? new Map<string, VariantOverlay>();
      const o = byVariant.get(issue.variant) ?? { values: {}, hidden: [] };
      o.hidden.push(issue.address);
      byVariant.set(issue.variant, o);
      this.#issueOwners.set(owner, byVariant);
    }
  }

  /**
   * Every refused entry of the build, with sources naming the plugin that
   * sent each one (for `reportListOverlayIssues`).
   */
  issueReport(): { issues: ListOverlayIssue[]; sources: ResolvedListOverlays } {
    return {
      issues: [...this.#issues],
      sources: { plugins: toPlugins(this.#issueOwners) },
    };
  }

  /** Per variant, what the batch's pages can show from lists. */
  #asksOf(pages: readonly OverlayBatchPage[]): Map<string, VariantAsk> {
    const asks = new Map<string, VariantAsk>();
    for (const page of pages) {
      const variant = this.#data.pageVariants?.get(page.pageId)?.variant;
      if (variant === undefined) continue;
      const scope: ListOverlayScope | null = pageListOverlayScope({
        pageId: page.pageId,
        data: this.#data,
        modules: page.modules,
        markup: page.markup,
        contentInstanceIds: page.contentInstanceIds,
      });
      if (scope === null) continue;
      const ask = asks.get(variant) ?? {
        listIds: new Set<string>(),
        contentInstanceIds: new Set<string>(),
        ownPageIds: new Set<string>(),
        otherPageIds: new Set<string>(),
      };
      for (const id of scope.listIds) ask.listIds.add(id);
      for (const id of scope.contentInstanceIds) ask.contentInstanceIds.add(id);
      for (const id of scope.pageIds) {
        if (id === page.pageId) ask.ownPageIds.add(id);
        else ask.otherPageIds.add(id);
      }
      asks.set(variant, ask);
    }
    return asks;
  }

  /**
   * The calls one variant makes for a batch: the batch's sources (and,
   * the first time, the shared lists), then the not yet kept pages
   * outside the batch in slices of {@link KEPT_PAGES_PER_CALL}.
   */
  #callsOf(
    variant: string,
    ask: VariantAsk,
  ): { scope: ListOverlayScope; keep: ReadonlySet<string> }[] {
    const kept = this.#keptPages.get(variant) ?? new Set<string>();
    this.#keptPages.set(variant, kept);
    const own = [...ask.ownPageIds].filter((id) => !kept.has(id) && !ask.otherPageIds.has(id));
    const others = [...ask.otherPageIds].filter((id) => !kept.has(id)).sort();
    const listIds = this.#listsAsked.has(variant) ? [] : [...ask.listIds].sort();
    const calls: { scope: ListOverlayScope; keep: ReadonlySet<string> }[] = [];
    const first = others.slice(0, KEPT_PAGES_PER_CALL);
    calls.push({
      scope: {
        listIds,
        contentInstanceIds: [...ask.contentInstanceIds].sort(),
        pageIds: [...own, ...first].sort(),
      },
      keep: new Set(first),
    });
    for (let at = KEPT_PAGES_PER_CALL; at < others.length; at += KEPT_PAGES_PER_CALL) {
      const slice = others.slice(at, at + KEPT_PAGES_PER_CALL);
      calls.push({
        scope: { listIds: [], contentInstanceIds: [], pageIds: slice },
        keep: new Set(slice),
      });
    }
    for (const id of others) kept.add(id);
    return calls.filter(
      (c) =>
        c.scope.listIds.length + c.scope.contentInstanceIds.length + c.scope.pageIds.length > 0,
    );
  }

  /** Split one answer into the part kept for the build and the batch's part. */
  #take(
    variant: string,
    answer: ResolvedListOverlays,
    keepPages: ReadonlySet<string>,
    batch: Map<string, Map<string, VariantOverlay>>,
  ): void {
    for (const plugin of answer.plugins) {
      const overlay = plugin.overlays[variant];
      if (!overlay) continue;
      const kept = slot(this.#kept, plugin.slug, variant);
      const mine = slot(batch, plugin.slug, variant);
      for (const [address, value] of Object.entries(overlay.values)) {
        const page = PAGE_PROPS_RE.exec(address)?.[1];
        const keep = address.startsWith("list/") || (page !== undefined && keepPages.has(page));
        (keep ? kept : mine).values[address] = value;
      }
      for (const address of overlay.hidden) {
        (address.startsWith("list/") ? kept : mine).hidden.push(address);
      }
    }
  }

  /** The kept and the batch's answers of `variants`, per plugin. */
  #merge(
    variants: ReadonlySet<string>,
    batch: Map<string, Map<string, VariantOverlay>>,
  ): ResolvedListOverlays {
    const merged = new Map<string, Map<string, VariantOverlay>>();
    for (const source of [this.#kept, batch]) {
      for (const [slug, byVariant] of source) {
        for (const [variant, o] of byVariant) {
          if (!variants.has(variant)) continue;
          const into = slot(merged, slug, variant);
          Object.assign(into.values, o.values);
          into.hidden.push(...o.hidden);
        }
      }
    }
    return { plugins: toPlugins(merged) };
  }
}

function slot(
  m: Map<string, Map<string, VariantOverlay>>,
  slug: string,
  variant: string,
): VariantOverlay {
  const byVariant = m.get(slug) ?? new Map<string, VariantOverlay>();
  m.set(slug, byVariant);
  const o = byVariant.get(variant) ?? { values: {}, hidden: [] };
  byVariant.set(variant, o);
  return o;
}

function toPlugins(m: Map<string, Map<string, VariantOverlay>>): PluginListOverlays[] {
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slug, byVariant]) => ({ slug, overlays: Object.fromEntries(byVariant) }));
}
