// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin client assets — the channel from a plugin to the visitor's
 * browser.
 *
 * Until this existed, a plugin could contribute data, head entries, URL
 * shape and AI tools, but nothing that RUNS on the public site. The SDK
 * had `component.mounted` from the start and every shipped plugin wrote
 * one; nothing ever bundled them, so those handlers were dead code and
 * any plugin needing browser behaviour was blocked (#449).
 *
 * ## Why once per build
 *
 * `staticRender` is per page and `dataListsOperation` returns data, not
 * files. The behaviour this channel exists for — a consent dialog that
 * must work no matter how the site's markup was authored, an embed that
 * must not load before the visitor opts in — needs its configuration
 * BEFORE it can decide anything, and a static site cannot afford a
 * blocking fetch to obtain it. One call per build lets the plugin bake
 * that configuration into the file it ships.
 *
 * ## Why the content hash is in the filename
 *
 * The same asset is referenced from every page, so it wants a long CDN
 * TTL; a long TTL plus a stable name means a deploy that changes plugin
 * behaviour leaves stale code in caches. Hashing the content into the
 * name makes "cache forever" and "the change lands" both true.
 *
 * ## One resolver, two surfaces
 *
 * The static generator LINKS these files; the admin preview INLINES the
 * identical content, because the preview iframe has no build directory
 * to serve from. Delivery differs, content does not — both go through
 * `collectBuildAssets` so the editor cannot show behaviour the deployed
 * site won't have. Two hand-kept head assemblies drifting apart is
 * exactly what produced the historical hreflang bug.
 */

import { createHash } from "node:crypto";
import { isPluginDisabled, loadedPlugins, runPluginBuildAssets } from "./dispatch.js";

/** Public directory every plugin's assets are written under. */
export const PLUGIN_ASSET_DIR = "_caelo/plugin";

/** A single emitted file, already named and ready to write or inline. */
export interface PluginClientAsset {
  readonly pluginSlug: string;
  /** Name as the plugin returned it, e.g. `runtime.js`. */
  readonly fileName: string;
  readonly kind: "js" | "css";
  readonly content: string;
  /** Build-dir-relative path, content hash included. */
  readonly relPath: string;
  /** Site-absolute URL to reference from a page. */
  readonly publicPath: string;
}

/**
 * Total per plugin. Generous for a runtime with baked config, small
 * enough that a plugin accidentally emitting its whole dataset onto
 * every page fails at build instead of at the CDN bill.
 */
const MAX_TOTAL_BYTES = 512 * 1024;

const FILE_NAME_RE = /^[a-z][a-z0-9-]*\.(js|css)$/;

function assetPaths(
  pluginSlug: string,
  fileName: string,
  content: string,
): { relPath: string; publicPath: string } {
  const hash = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
  const dot = fileName.lastIndexOf(".");
  const stem = fileName.slice(0, dot);
  const ext = fileName.slice(dot + 1);
  const rel = `${PLUGIN_ASSET_DIR}/${pluginSlug}/${stem}.${hash}.${ext}`;
  return { relPath: rel, publicPath: `/${rel}` };
}

/**
 * Call every active plugin's `buildAssets` once and return the files to
 * emit, in a deterministic order (plugin slug, then file name) so two
 * builds of the same site produce byte-identical pages.
 *
 * Loud, per CLAUDE.md §2: a failing plugin, a malformed file name and an
 * oversized payload all throw. Shipping a page whose behaviour silently
 * went missing is the failure mode this channel exists to prevent — a
 * consent dialog that quietly stops loading is worse than a build that
 * stops.
 *
 * @param pageIds every page in this build, handed to the plugin so it
 *   can bake per-page data rather than fetch it at runtime.
 */
export async function collectBuildAssets(
  pageIds: ReadonlyArray<string>,
): Promise<PluginClientAsset[]> {
  const out: PluginClientAsset[] = [];
  const contributors = loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.buildAssets === "function")
    .sort((a, b) => a.slug.localeCompare(b.slug));

  for (const lp of contributors) {
    const files = await runPluginBuildAssets({ pluginSlug: lp.slug, pageIds });
    let totalBytes = 0;
    for (const fileName of Object.keys(files).sort()) {
      const content = files[fileName];
      if (typeof content !== "string") {
        throw new Error(
          `client-assets: plugin "${lp.slug}" returned a non-string body for "${fileName}"`,
        );
      }
      if (!FILE_NAME_RE.test(fileName)) {
        throw new Error(
          `client-assets: plugin "${lp.slug}" returned an invalid asset name "${fileName}" — expected lowercase-with-dashes ending in .js or .css`,
        );
      }
      totalBytes += Buffer.byteLength(content, "utf8");
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(
          `client-assets: plugin "${lp.slug}" emitted ${totalBytes} bytes, over the ${MAX_TOTAL_BYTES}-byte budget. These files load on every page — bake less, or fetch the rest from the gateway on demand.`,
        );
      }
      const { relPath, publicPath } = assetPaths(lp.slug, fileName, content);
      out.push({
        pluginSlug: lp.slug,
        fileName,
        kind: fileName.endsWith(".css") ? "css" : "js",
        content,
        relPath,
        publicPath,
      });
    }
  }
  return out;
}

const HEAD_CLOSE_RE = /<\/head\s*>/i;
const BODY_CLOSE_RE = /<\/body\s*>/i;

function escapeAttr(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/**
 * Reference the assets from one page's HTML.
 *
 * CSS goes into `<head>` so a plugin's own surface is styled before
 * first paint; JS goes last in `<body>`, deferred, so it never blocks
 * rendering. `inline` embeds the identical bytes for the admin preview,
 * which has no build directory to serve from.
 *
 * A page with neither `</head>` nor `</body>` is returned untouched —
 * that is a fragment (the preview's module-only render), not a document
 * that could carry a runtime.
 */
export function injectPluginAssets(
  html: string,
  assets: ReadonlyArray<PluginClientAsset>,
  mode: "linked" | "inline",
): string {
  if (assets.length === 0) return html;

  const css = assets.filter((a) => a.kind === "css");
  const js = assets.filter((a) => a.kind === "js");

  let out = html;
  if (css.length > 0 && HEAD_CLOSE_RE.test(out)) {
    const block = css
      .map((a) =>
        mode === "linked"
          ? `<link rel="stylesheet" href="${escapeAttr(a.publicPath)}" data-caelo-plugin="${escapeAttr(a.pluginSlug)}" />`
          : `<style data-caelo-plugin="${escapeAttr(a.pluginSlug)}">\n${a.content}\n</style>`,
      )
      .join("\n");
    out = out.replace(HEAD_CLOSE_RE, `${block}\n</head>`);
  }
  if (js.length > 0 && BODY_CLOSE_RE.test(out)) {
    const block = js
      .map((a) =>
        mode === "linked"
          ? `<script defer src="${escapeAttr(a.publicPath)}" data-caelo-plugin="${escapeAttr(a.pluginSlug)}"></script>`
          : `<script defer data-caelo-plugin="${escapeAttr(a.pluginSlug)}">\n${a.content}\n</script>`,
      )
      .join("\n");
    out = out.replace(BODY_CLOSE_RE, `${block}\n</body>`);
  }
  return out;
}
