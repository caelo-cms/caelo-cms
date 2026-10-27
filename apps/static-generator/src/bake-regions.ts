// SPDX-License-Identifier: MPL-2.0

/**
 * #1155 — the exact bytes a plugin's `staticRender` owns in a built page.
 *
 * Every bake the plugin pass splices into a page is wrapped in a start and
 * an end marker:
 *
 *   <!--caelo-bake:<slug>:<pageId>:<pluginVersion>-->
 *   <div data-caelo-plugin="<slug>" data-page-id="<pageId>" data-baked-at="<iso>">…</div>
 *   <!--/caelo-bake:<slug>:<pageId>-->
 *
 * A plugin-data build (admin-core `plugin-data/build.ts`) re-renders only
 * what lies between those markers, in the files of the build that is live,
 * and leaves every other byte as the human published it. That is the whole
 * guarantee "a plugin-data build publishes nothing else", so the markers
 * must be unforgeable from inside the page: before splicing, the plugin
 * pass neutralises every marker-shaped comment already in the page (module
 * HTML an editor or the AI wrote) and in the plugin's own output. The first
 * end marker after a start marker is therefore always the real one.
 *
 * The plugin version rides on the start marker: a plugin-data build only
 * refreshes a region the running plugin version rendered. A new version's
 * markup reaches visitors with the next Publish live, never on a data tick.
 */

/** Plugin slugs as the SDK allows them (`pluginManifest.slug`). */
const SLUG = "[a-z][a-z0-9-]{0,54}";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Semver as the SDK allows it (`pluginManifest.version`). */
const VERSION = "\\d+\\.\\d+\\.\\d+(?:-[a-z0-9.]+)?";

const START_RE = new RegExp(`<!--caelo-bake:(${SLUG}):(${UUID}):(${VERSION})-->`, "g");
const BAKED_AT_RE = /^<div data-caelo-plugin="[^"]*" data-page-id="[^"]*" data-baked-at="([^"]*)">/;

/** Any comment that begins like a bake marker (start or end). */
const MARKER_LIKE_RE = /<!--(\/?)caelo-bake:/g;

/** One plugin bake inside a built page. */
export interface BakeRegion {
  readonly slug: string;
  readonly pageId: string;
  /** The plugin version that rendered it. */
  readonly version: string;
  /** `data-baked-at` of the wrapper: the delta feed's `since` (§6.1). */
  readonly bakedAt: string | null;
  /** Offset of the start marker. */
  readonly start: number;
  /** Offset just past the end marker. */
  readonly end: number;
  /** The whole region, markers included. */
  readonly text: string;
}

function endMarker(slug: string, pageId: string): string {
  return `<!--/caelo-bake:${slug}:${pageId}-->`;
}

/**
 * Make marker-shaped comments inert (`<!--caelo-bake:` → `<!-- caelo-bake:`),
 * so text that did not come from the plugin pass can never open or close a
 * region. Browsers ignore comments either way.
 */
export function neutralizeBakeMarkers(html: string): string {
  return html.replace(MARKER_LIKE_RE, "<!-- $1caelo-bake:");
}

/**
 * The marked region for one bake: the wrapper the Web Component reads its
 * `since` from (`data-baked-at`, plugin-component-kit `readBakeTimestamp`),
 * around the plugin's output with any marker in it neutralised.
 */
export function bakeRegion(args: {
  readonly slug: string;
  readonly pageId: string;
  readonly version: string;
  readonly bakedAt: string;
  readonly html: string;
}): string {
  return (
    `<!--caelo-bake:${args.slug}:${args.pageId}:${args.version}-->` +
    `<div data-caelo-plugin="${args.slug}" data-page-id="${args.pageId}" data-baked-at="${args.bakedAt}">` +
    `${neutralizeBakeMarkers(args.html)}</div>` +
    endMarker(args.slug, args.pageId)
  );
}

/**
 * Every complete bake region in `html`, in document order. A start marker
 * without its end marker is not a region (a truncated or hand-edited file):
 * nothing is replaced there.
 */
export function findBakeRegions(html: string): BakeRegion[] {
  const out: BakeRegion[] = [];
  START_RE.lastIndex = 0;
  for (let m = START_RE.exec(html); m !== null; m = START_RE.exec(html)) {
    const [startText, slug, pageId, version] = m as unknown as [string, string, string, string];
    const close = endMarker(slug, pageId);
    const endAt = html.indexOf(close, m.index + startText.length);
    if (endAt === -1) continue;
    const end = endAt + close.length;
    const inner = html.slice(m.index + startText.length, endAt);
    out.push({
      slug,
      pageId,
      version,
      bakedAt: BAKED_AT_RE.exec(inner)?.[1] ?? null,
      start: m.index,
      end,
      text: html.slice(m.index, end),
    });
    START_RE.lastIndex = end;
  }
  return out;
}

/**
 * Replace bake regions. `replace` returns the new region text, or null to
 * keep the region as it is. Every byte outside the regions is kept.
 */
export function replaceBakeRegions(
  html: string,
  replace: (region: BakeRegion) => string | null,
): string {
  let out = "";
  let at = 0;
  for (const region of findBakeRegions(html)) {
    out += html.slice(at, region.start);
    out += replace(region) ?? region.text;
    at = region.end;
  }
  return out + html.slice(at);
}
