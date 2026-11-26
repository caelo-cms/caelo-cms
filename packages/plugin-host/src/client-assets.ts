// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin client assets — the channel from a plugin to the visitor's
 * browser (#449), in the model of #1729 (docs/dev/external-plugin-brokers.md
 * §6.7, decision Q4 B), for every plugin, shipped or installed.
 *
 * ## Reviewed files, data per build
 *
 * The JS and CSS are `clientFiles` in the plugin's manifest: the Owner
 * approves their bytes and the artifact's digest binds them, so a build
 * cannot change what runs in visitors' browsers. The one thing a build may
 * change is a JSON object (`buildDataOperation`, the `$buildData` point):
 * core embeds it in each page as a `<script type="application/json">` data
 * block with `<` escaped, refuses `__proto__`, `constructor` and
 * `prototype` keys, and the files read it. The data cannot become markup
 * or code by core's hand.
 *
 * ## Network
 *
 * What the files reach beyond the site's own origins is the grant's
 * `capabilityConstraints.client_assets.origins` (shown on the approval
 * card), plus the gateway's stream origin for a visitor conversation
 * (#1654). They go into the CSP of the build as the plugin's sources. Only
 * the site's consent provider may add sources per build: its tags, each an
 * Owner approval of its own (`add_tracking_tag`).
 *
 * ## Consent
 *
 * A plugin that declares `consentPurposes` has its scripts parked as
 * `type="text/plain"` with `data-caelo-consent="<categories>"`; the
 * consent provider's runtime starts them once every category is granted.
 * Nothing of them loads before.
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
 * site won't have. The static build then minifies the files (inlined and
 * linked alike) and names each by the hash of the minified bytes
 * ({@link withAssetContent}), the same one deliberate divergence the page's
 * own CSS and JS have (static-generator minify-pass.ts).
 */

import { createHash } from "node:crypto";
import {
  BUILD_DATA_MAX_BYTES,
  CLIENT_FILE_NAME_RE,
  CLIENT_FILES_MAX_BYTES,
  CONSENT_PROVIDER_SLUG,
} from "@caelo-cms/plugin-sdk";
import {
  escapeStyleText,
  type PluginCspSources,
  pluginCspSourcesSchema,
  scriptNeedsEncoding,
  visitorAiStreamOrigin,
} from "@caelo-cms/shared";
import { z } from "zod";
import {
  isPluginDisabled,
  type LoadedPlugin,
  loadedPlugins,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";
import { reportPluginRenderFailure } from "./render-failures.js";
import { assertAnswerSize, type RenderPointCall } from "./render-points.js";

/** Public directory every plugin's assets are written under. */
export const PLUGIN_ASSET_DIR = "_caelo/plugin";

/** A single emitted file, already named and ready to write or inline. */
export interface PluginClientAsset {
  readonly pluginSlug: string;
  /** Name as the plugin returned it, e.g. `runtime.js`. */
  readonly fileName: string;
  /**
   * `csp` is {@link PLUGIN_CSP_SOURCES_FILE}: what the site's CSP must
   * allow for the plugin, read by the build, never written or linked.
   * `data` is the plugin's build data ({@link PLUGIN_DATA_FILE}), already
   * serialized for a data block.
   */
  readonly kind: "js" | "css" | "csp" | "data";
  readonly content: string;
  /** Build-dir-relative path, content hash included. */
  readonly relPath: string;
  /** Site-absolute URL to reference from a page. */
  readonly publicPath: string;
  /**
   * JS only: the consent categories the visitor must grant before the
   * consent provider starts it (sorted; empty or absent: it starts at once).
   */
  readonly consent?: ReadonlyArray<string>;
}

/** The name of a plugin's build data among its assets; never a file. */
export const PLUGIN_DATA_FILE = "data.json";

/**
 * The largest `$buildData` answer: the data and, from the consent
 * provider, the CSP sources of its tags (whose inline snippets are in the
 * data too).
 */
const BUILD_DATA_CALL: RenderPointCall = {
  point: "client-assets",
  maxAnswerBytes: 2 * BUILD_DATA_MAX_BYTES + 16 * 1024,
};

const buildDataAnswer = z
  .object({
    data: z.record(z.string(), z.unknown()),
    csp: pluginCspSourcesSchema.optional(),
  })
  .strict();

/** Keys that change what a reading script's objects inherit. */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Why `value` is not plain JSON a page may carry, or null. Plain means
 * what `JSON.parse` gives back: objects, arrays, strings, finite numbers,
 * booleans, null; no prototype key anywhere, at most 32 levels.
 */
export function plainJsonProblem(value: unknown, path = "data", depth = 0): string | null {
  if (depth > 32) return `${path}: nests deeper than 32 levels`;
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number")
    return Number.isFinite(value) ? null : `${path}: not a finite number`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const p = plainJsonProblem(value[i], `${path}[${i}]`, depth + 1);
      if (p) return p;
    }
    return null;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return `${path}: not a plain object`;
    for (const key of Object.keys(value)) {
      if (PROTOTYPE_KEYS.has(key)) {
        return `${path}: the key "${key}" would change what a reading script's objects inherit`;
      }
      const p = plainJsonProblem(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        depth + 1,
      );
      if (p) return p;
    }
    return null;
  }
  return `${path}: a ${typeof value} is not JSON`;
}

/**
 * JSON safe inside a data block: `<` escaped, so no `</script` or `<!--`
 * in the data can end or change the element, and the two line separators
 * JavaScript treats as line breaks escaped too.
 */
export function dataBlockJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/**
 * #1454 — the name of what a plugin's client code reaches at runtime, among
 * its assets (`pluginCspSourcesSchema`): a build reads pages, and a script
 * started after consent is in none of them. From the grant's origins, the
 * gateway's stream origin and the consent provider's tags (#1729). Shown
 * to the Owner by plugin beside the site's policy (`get_security_headers`).
 */
export const PLUGIN_CSP_SOURCES_FILE = "csp-sources.json";

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
 * `asset` with a new body and the path that body's hash names. The
 * static build uses it for the minified file it ships, so the immutable
 * URL always names the bytes served — a minifier change cannot leave a
 * cached old file under an unchanged name.
 */
export function withAssetContent(asset: PluginClientAsset, content: string): PluginClientAsset {
  return { ...asset, content, ...assetPaths(asset.pluginSlug, asset.fileName, content) };
}

let streamOrigin: { readonly key: string; readonly origin: Promise<string | null> } | null = null;

/**
 * The live gateway's stream origin as the admin sees it (`CAELO_GATEWAY_SERVICE`,
 * `CAELO_GATEWAY_REGION`, the metadata server), learned once per process: a
 * service's address does not change. A build renders the live site; the
 * staging gateway adds its own origin when it serves the staged pages.
 */
function liveStreamOrigin(): Promise<string | null> {
  const env = process.env;
  const key = [
    env.CAELO_VISITOR_AI_STREAM_ORIGIN ?? "\u0000",
    env.CAELO_PROVIDER,
    env.CAELO_GATEWAY_SERVICE,
    env.CAELO_GATEWAY_REGION,
  ].join("|");
  if (streamOrigin?.key !== key) {
    const origin = visitorAiStreamOrigin(env, {
      service: env.CAELO_GATEWAY_SERVICE,
      region: env.CAELO_GATEWAY_REGION,
    });
    origin.catch(() => {
      if (streamOrigin?.origin === origin) streamOrigin = null;
    });
    streamOrigin = { key, origin };
  }
  return streamOrigin.origin;
}

/** The consent categories a plugin's scripts wait for: every category its purposes name. */
function consentCategoriesOf(lp: LoadedPlugin): string[] {
  if (lp.slug === CONSENT_PROVIDER_SLUG) return [];
  return [...new Set((lp.definition.consentPurposes ?? []).map((p) => p.category))].sort();
}

/** Ask a plugin for its build data, checked; null when a preview skips the plugin (#1087). */
async function buildDataOf(
  lp: LoadedPlugin,
  scope: RenderScope,
): Promise<{ data: Record<string, unknown>; csp: PluginCspSources | undefined } | null> {
  const operationName = lp.definition.buildDataOperation as string;
  const label = `client-assets: ${lp.slug}.${operationName}`;
  const r = await runPluginOperation({
    invocation: renderInvocation(scope),
    pluginSlug: lp.slug,
    operationName,
    args: {},
    maxAnswerBytes: BUILD_DATA_CALL.maxAnswerBytes,
  });
  if (!r.ok) {
    const reason = `${label} failed: ${r.error.kind}: ${r.error.message}`;
    // #1087 — a preview renders without this plugin's assets and flags
    // it; a build throws.
    if (reportPluginRenderFailure(scope, { slug: lp.slug, point: "client-assets", reason })) {
      return null;
    }
    throw new Error(reason);
  }
  assertAnswerSize(BUILD_DATA_CALL, label, r.value);
  // Before Zod: a parse copies keys into a new object, where `__proto__`
  // would set the copy's prototype instead of naming the key that tried.
  const raw = (r.value as { data?: unknown } | null)?.data;
  const problem = plainJsonProblem(raw);
  if (problem) throw new Error(`${label}: the build data is refused: ${problem}`);
  const parsed = buildDataAnswer.safeParse(r.value);
  if (!parsed.success) {
    throw new Error(
      `${label}: expected { data: object, csp? }: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const bytes = Buffer.byteLength(JSON.stringify(parsed.data.data));
  if (bytes > BUILD_DATA_MAX_BYTES) {
    throw new Error(
      `${label}: the build data is ${bytes} bytes, over the ${BUILD_DATA_MAX_BYTES} every page can carry. Bake less; fetch the rest from the gateway on demand.`,
    );
  }
  if (parsed.data.csp && lp.slug !== CONSENT_PROVIDER_SLUG) {
    throw new Error(
      `${label}: only the site's consent provider may widen the CSP per build (its tags are Owner approvals). Name the origins your client files reach in capabilityConstraints.client_assets.origins, which the Owner approves with the plugin.`,
    );
  }
  return { data: parsed.data.data, csp: parsed.data.csp };
}

/** Merge CSP sources of one plugin into one entry, the way the Owner sees them. */
function mergeCsp(parts: ReadonlyArray<PluginCspSources | undefined>): PluginCspSources | null {
  const origins: Record<string, Set<string>> = {};
  const inline = new Set<string>();
  for (const part of parts) {
    for (const [kind, list] of Object.entries(part?.origins ?? {})) {
      const set = origins[kind] ?? new Set<string>();
      for (const o of list ?? []) set.add(o);
      origins[kind] = set;
    }
    for (const body of part?.inlineScripts ?? []) inline.add(body);
  }
  if (Object.keys(origins).length === 0 && inline.size === 0) return null;
  return {
    origins: Object.fromEntries(
      Object.entries(origins)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, set]) => [k, [...set].sort()]),
    ),
    ...(inline.size > 0 ? { inlineScripts: [...inline].sort() } : {}),
  };
}

/**
 * Every active plugin's client assets for one render scope, in a
 * deterministic order (plugin slug, then file name) so two builds of the
 * same site produce byte-identical pages: its reviewed files, its build
 * data (one `$buildData` call per build) and what the site's CSP must
 * allow for it.
 *
 * Loud, per CLAUDE.md §2: a failing plugin, a refused answer and an
 * oversized payload all throw in a build. Shipping a page whose behaviour
 * silently went missing is the failure mode this channel exists to
 * prevent — a consent dialog that quietly stops loading is worse than a
 * build that stops.
 */
export async function collectBuildAssets(scope: RenderScope): Promise<PluginClientAsset[]> {
  const out: PluginClientAsset[] = [];
  const contributors = loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  for (const lp of contributors) {
    const def = lp.definition;
    const files = def.clientFiles ?? {};
    const chat = (def.aiChatOperations ?? []).length > 0;
    if (Object.keys(files).length === 0 && !def.buildDataOperation && !chat) continue;

    let buildData: Awaited<ReturnType<typeof buildDataOf>> = { data: {}, csp: undefined };
    if (def.buildDataOperation) {
      buildData = await buildDataOf(lp, scope);
      if (buildData === null) continue;
    }

    let totalBytes = 0;
    const consent = consentCategoriesOf(lp);
    for (const fileName of Object.keys(files).sort()) {
      const content = files[fileName] as string;
      // Reviewed already (plugin-sandbox validate.ts); checked again here,
      // where the names become paths.
      if (!CLIENT_FILE_NAME_RE.test(fileName)) {
        throw new Error(
          `client-assets: plugin "${lp.slug}" ships an invalid client file name "${fileName}" — expected lowercase-with-dashes ending in .js or .css`,
        );
      }
      totalBytes += Buffer.byteLength(content, "utf8");
      if (totalBytes > CLIENT_FILES_MAX_BYTES) {
        throw new Error(
          `client-assets: plugin "${lp.slug}" ships ${totalBytes} bytes of client files, over the ${CLIENT_FILES_MAX_BYTES}-byte budget. These files load on every page — ship less, or fetch the rest from the gateway on demand.`,
        );
      }
      const kind = fileName.endsWith(".css") ? "css" : "js";
      out.push({
        pluginSlug: lp.slug,
        fileName,
        kind,
        content,
        ...assetPaths(lp.slug, fileName, content),
        ...(kind === "js" && consent.length > 0 ? { consent } : {}),
      });
    }
    if (def.buildDataOperation) {
      out.push({
        pluginSlug: lp.slug,
        fileName: PLUGIN_DATA_FILE,
        kind: "data",
        content: dataBlockJson(buildData.data),
        relPath: "",
        publicPath: "",
      });
    }
    // #1654 — a visitor conversation streams from the gateway's own origin
    // where /api/* is buffered (gcp-firebase): the pages may connect to it.
    // Core's contribution, attributed to the plugin whose conversation needs it.
    const stream = chat ? await liveStreamOrigin() : null;
    const csp = mergeCsp([
      def.capabilityConstraints?.client_assets?.origins
        ? { origins: def.capabilityConstraints.client_assets.origins }
        : undefined,
      buildData.csp,
      stream ? { origins: { connect: [stream] } } : undefined,
    ]);
    if (csp) {
      out.push({
        pluginSlug: lp.slug,
        fileName: PLUGIN_CSP_SOURCES_FILE,
        kind: "csp",
        content: JSON.stringify(csp),
        relPath: "",
        publicPath: "",
      });
    }
  }
  return out;
}

const HEAD_CLOSE_RE = /<\/head\s*>/i;
const BODY_CLOSE_RE = /<\/body\s*>/i;

/**
 * CSS files up to this size are inlined as `<style>` even on a deployed
 * page (#1124). A linked stylesheet in `<head>` blocks first paint until
 * it arrives, and Lighthouse flags it: a round-trip for a few hundred
 * bytes of rules (the consent runtime's show/hide rule) is the slowest
 * way to ship them. Above the limit the file is big enough that caching
 * it once across pages beats repeating it in every page's HTML. The
 * site's CSP keeps `'unsafe-inline'` in `style-src` (@caelo-cms/shared
 * site-security-headers.ts), so an inline block is allowed wherever the
 * link was.
 */
export const INLINE_CSS_MAX_BYTES = 2 * 1024;

function styleTag(asset: PluginClientAsset): string {
  // `<\/style` means what `</style` means wherever CSS can hold it
  // (strings, url(), comments), so this escape keeps the CSS intact.
  return `<style data-caelo-plugin="${escapeAttr(asset.pluginSlug)}">\n${escapeStyleText(asset.content)}\n</style>`;
}

function escapeAttr(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/**
 * Reference the assets from one page's HTML.
 *
 * CSS goes into `<head>` so a plugin's own surface is styled before
 * first paint — inlined when small (`INLINE_CSS_MAX_BYTES`), linked
 * otherwise; JS goes last in `<body>`, deferred, so it never blocks
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
  const data = assets.filter((a) => a.kind === "data");
  const js = assets.filter((a) => a.kind === "js");

  let out = html;
  if (css.length > 0 && HEAD_CLOSE_RE.test(out)) {
    const block = css
      .map((a) =>
        mode === "linked" && Buffer.byteLength(a.content, "utf8") > INLINE_CSS_MAX_BYTES
          ? `<link rel="stylesheet" href="${escapeAttr(a.publicPath)}" data-caelo-plugin="${escapeAttr(a.pluginSlug)}" />`
          : styleTag(a),
      )
      .join("\n");
    // A function replacer: a string one would expand `$&` / `$'` inside
    // plugin content as replacement patterns.
    out = out.replace(HEAD_CLOSE_RE, () => `${block}\n</head>`);
  }
  if ((js.length > 0 || data.length > 0) && BODY_CLOSE_RE.test(out)) {
    // Data blocks first: a deferred script runs after parsing, when every
    // block is in the document.
    const block = [
      ...data.map(
        (a) =>
          `<script type="application/json" data-caelo-plugin-data="${escapeAttr(a.pluginSlug)}">${a.content}</script>`,
      ),
      ...js.map((a) => scriptTag(a, mode)),
    ].join("\n");
    out = out.replace(BODY_CLOSE_RE, () => `${block}\n</body>`);
  }
  return out;
}

/**
 * One JS asset's element. A script that waits for consent is parked:
 * `type="text/plain"` with its address in `data-caelo-src`, which no
 * browser fetches; the consent provider's runtime starts it once the
 * visitor granted every category in `data-caelo-consent`. The preview's
 * parked form carries a `data:` URL, so the runtime starts it the same way.
 */
function scriptTag(asset: PluginClientAsset, mode: "linked" | "inline"): string {
  const slug = escapeAttr(asset.pluginSlug);
  if (asset.consent && asset.consent.length > 0) {
    const src = mode === "linked" ? asset.publicPath : dataScriptUrl(asset.content);
    return `<script type="text/plain" data-caelo-consent="${escapeAttr(asset.consent.join(" "))}" data-caelo-src="${escapeAttr(src)}" data-caelo-plugin="${slug}"></script>`;
  }
  return mode === "linked"
    ? `<script defer src="${escapeAttr(asset.publicPath)}" data-caelo-plugin="${slug}"></script>`
    : inlineScriptTag(asset);
}

function dataScriptUrl(content: string): string {
  return `data:text/javascript;charset=utf-8;base64,${Buffer.from(content, "utf8").toString("base64")}`;
}

/**
 * The preview's inline form of a JS asset. Verbatim when the source cannot
 * close the element (no `</script`, no `<!--` script-data escape);
 * otherwise a base64 `data:` URL, because no textual
 * rewrite of `</script` keeps every JavaScript program's meaning (a regex
 * literal or `String.raw` observes an inserted backslash). Both forms run
 * the identical bytes the deploy links.
 */
function inlineScriptTag(asset: PluginClientAsset): string {
  const slug = escapeAttr(asset.pluginSlug);
  if (!scriptNeedsEncoding(asset.content)) {
    return `<script defer data-caelo-plugin="${slug}">\n${asset.content}\n</script>`;
  }
  return `<script defer src="${dataScriptUrl(asset.content)}" data-caelo-plugin="${slug}"></script>`;
}
