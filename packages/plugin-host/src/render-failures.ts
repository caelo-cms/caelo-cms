// SPDX-License-Identifier: MPL-2.0

/**
 * #1087 — a plugin that fails while the editor preview renders must not
 * take the preview down with it.
 *
 * Every render-time composition point (link resolve, data lists, content
 * variants, head contributions, module deferrals, client assets) calls the
 * contributing plugins in turn and throws when one of them fails: loud, per
 * CLAUDE.md §2. For a build that is right — Publish live must never ship a
 * page that lacks a plugin's contribution. For the editor preview it was
 * not: one plugin whose operation threw on this server (on 2026-10-22,
 * international-site's `link_resolve` refusing with "the plugin is not
 * active") aborted EVERY page preview, so editors could not see any page,
 * although the rule is that a plugin's errors block only Publish live.
 *
 * A render that can show a degraded page passes a {@link RenderScope} with
 * `onPluginFailure`: a plugin whose operation fails is then reported there
 * and its contribution left out, while every other plugin and core still
 * render. The preview turns each report into a `plugin-render-failed:<slug>`
 * marker on its missing-content surface and a banner on the preview
 * document — loud, never a silent fallback. Builds pass no sink and keep
 * throwing. Answers that break the point's contract (an ill-formed or
 * conflicting answer) still throw everywhere: those are bugs in a plugin
 * that otherwise runs, not a plugin that is not working here.
 */

import type { RenderScope } from "./dispatch.js";

/** One plugin whose contribution a render left out because it failed. */
export interface PluginRenderFailure {
  readonly slug: string;
  /** The composition point that called it, e.g. `link-resolve`. */
  readonly point: string;
  /** The failure as the point would have thrown it. */
  readonly reason: string;
}

/**
 * Report a failed plugin call of a composition point. Returns true when
 * the render accepts a degraded result (the caller skips this plugin's
 * contribution), false when it does not (the caller throws as before).
 */
export function reportPluginRenderFailure(
  scope: RenderScope,
  failure: PluginRenderFailure,
): boolean {
  if (!scope.onPluginFailure) return false;
  scope.onPluginFailure(failure);
  return true;
}

/**
 * Missing-content marker for a plugin that failed during this render —
 * `plugin-render-failed:<slug>`, the same convention as
 * `plugin-not-running:<slug>` for a plugin that did not load here.
 */
export function pluginRenderFailedMarker(slug: string): string {
  return `plugin-render-failed:${slug}`;
}

/** The slug of a {@link pluginRenderFailedMarker}, or null for any other marker. */
export function pluginRenderFailedSlug(marker: string): string | null {
  const m = /^plugin-render-failed:([a-z][a-z0-9-]*)$/.exec(marker);
  return m?.[1] ?? null;
}

/**
 * A sink for one render: collects the failures, one per plugin and point
 * (a plugin failing in two points is reported for both, each with its
 * own reason).
 */
export function createPluginRenderFailureSink(): {
  readonly onPluginFailure: (failure: PluginRenderFailure) => void;
  readonly failures: () => ReadonlyArray<PluginRenderFailure>;
} {
  const seen = new Map<string, PluginRenderFailure>();
  return {
    onPluginFailure: (f) => {
      const key = `${f.slug}|${f.point}`;
      if (!seen.has(key)) seen.set(key, f);
    },
    failures: () => [...seen.values()],
  };
}
