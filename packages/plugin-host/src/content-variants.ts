// SPDX-License-Identifier: MPL-2.0

/**
 * #592 — the content-variants composition point: which content a
 * placement shows on the page being rendered.
 *
 * Site chrome — header, footer, menus — is placed once in a layout (or
 * as a content instance synced across pages), so without help every page
 * shows the same chrome in the same language. A plugin that knows more
 * about the page (international-site knows its locale) can answer, per
 * placement: render these values instead, or (layout placements only)
 * render this other module, or — loudly — this placement has a problem
 * (no variant for the page's language; a menu link whose target has no
 * page in that language).
 *
 * Without an active contributor nothing changes and no plugin is called.
 * The editor preview and the static generator both resolve through here
 * in one batched call per contributing plugin, so the two surfaces show
 * the same chrome by construction.
 *
 * Loud (CLAUDE.md §2): a failing plugin op, an ill-formed answer, a
 * module override on a page placement, and two plugins answering for the
 * same placement all throw. Problems are not errors here — the caller
 * decides: the preview flags them, the build refuses to ship.
 */

import {
  type ContentVariantPage,
  type ContentVariantResolution,
  contentVariantResolution,
} from "@caelo-cms/plugin-sdk";
import type { PageUrlStyle } from "@caelo-cms/shared";
import {
  isPluginDisabled,
  loadedPlugins,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";

/** One placement's resolved answer; `problems` always present (maybe empty). */
export interface ResolvedContentVariant {
  readonly pluginSlug: string;
  readonly moduleId?: string;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly problems: readonly string[];
}

/** pageId → placementKey → answer. A missing entry renders as stored. */
export type ResolvedContentVariants = ReadonlyMap<
  string,
  ReadonlyMap<string, ResolvedContentVariant>
>;

/** True when an active plugin resolves content variants — callers skip
 *  building the placement payload entirely otherwise. */
export function hasContentVariantContributors(): boolean {
  return contributors().length > 0;
}

function contributors() {
  return loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.contentVariantsOperation === "string")
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Ask every contributing plugin which content each placement shows.
 *
 * @param pages every page of the render pass with its placements.
 * @param pageUrlStyle the serving target's style, so page links a plugin
 *   rewrites come from core's URL builder (pages.resolve_public_urls).
 */
export async function resolveContentVariants(
  pages: ReadonlyArray<ContentVariantPage>,
  scope: RenderScope,
  pageUrlStyle: PageUrlStyle,
): Promise<ResolvedContentVariants> {
  const out = new Map<string, Map<string, ResolvedContentVariant>>();
  if (pages.length === 0) return out;
  const plugins = contributors();
  if (plugins.length === 0) return out;

  const scopeByKey = new Map<string, "layout" | "page">();
  for (const p of pages) {
    for (const pl of p.placements) scopeByKey.set(`${p.pageId}|${pl.key}`, pl.scope);
  }

  for (const lp of plugins) {
    const operationName = lp.definition.contentVariantsOperation as string;
    const r = await runPluginOperation({
      invocation: renderInvocation(scope),
      pluginSlug: lp.slug,
      operationName,
      args: { pages: [...pages], pageUrlStyle },
    });
    if (!r.ok) {
      throw new Error(
        `content-variants: ${lp.slug}.${operationName} failed: ${r.error.kind}: ${r.error.message}`,
      );
    }
    const resolutions =
      (r.value as { resolutions?: Record<string, Record<string, unknown>> }).resolutions ?? {};
    for (const [pageId, byKey] of Object.entries(resolutions)) {
      const perPage = out.get(pageId) ?? new Map<string, ResolvedContentVariant>();
      for (const [key, raw] of Object.entries(byKey)) {
        const placementScope = scopeByKey.get(`${pageId}|${key}`);
        if (placementScope === undefined) {
          throw new Error(
            `content-variants: plugin "${lp.slug}" answered for placement "${key}" on page ${pageId}, which is not part of this render pass`,
          );
        }
        const parsed = contentVariantResolution.safeParse(raw);
        if (!parsed.success) {
          throw new Error(
            `content-variants: plugin "${lp.slug}" returned an invalid resolution for placement "${key}" on page ${pageId}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          );
        }
        const res: ContentVariantResolution = parsed.data;
        if (res.moduleId !== undefined && placementScope !== "layout") {
          throw new Error(
            `content-variants: plugin "${lp.slug}" swapped the module of page placement "${key}" on page ${pageId}; only layout placements may render a different module`,
          );
        }
        const existing = perPage.get(key);
        if (existing) {
          // Two plugins rewriting one placement cannot both win; whichever
          // did would silently drop the other's content.
          throw new Error(
            `content-variants: placement "${key}" on page ${pageId} is resolved by both "${existing.pluginSlug}" and "${lp.slug}". A placement can have at most one resolver.`,
          );
        }
        perPage.set(key, {
          pluginSlug: lp.slug,
          ...(res.moduleId !== undefined ? { moduleId: res.moduleId } : {}),
          ...(res.values !== undefined ? { values: res.values } : {}),
          problems: res.problems ?? [],
        });
      }
      out.set(pageId, perPage);
    }
  }
  return out;
}

/**
 * The marker the preview's missing-content surface shows for a problem,
 * and the build names in its refusal — one wording for both surfaces.
 */
export function contentVariantProblemMarker(pluginSlug: string, problem: string): string {
  return `content-variant:${pluginSlug}:${problem}`;
}
