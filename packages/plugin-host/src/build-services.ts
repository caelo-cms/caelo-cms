// SPDX-License-Identifier: MPL-2.0

/**
 * #605 — every plugin answer a static build needs, behind one interface.
 *
 * The plugin host lives in the admin process: loaded plugins, their data
 * list declarations, head contributions, staticRender, client assets. A
 * real deploy runs the static generator as a SUBPROCESS (process
 * isolation, apps/static-generator/src/cli.ts) where none of that exists;
 * before #605 the subprocess consulted its own, empty registries, so every
 * published page silently lacked plugin output — raw `{{#…}}` data-list
 * markers, no hreflang, no language switcher, no consent runtime, no
 * withheld embeds.
 *
 * The generator therefore never calls a plugin-host resolver directly; it
 * calls a `BuildPluginServices`:
 *
 *   - in the admin process (the editor preview, in-process tests) the
 *     LOCAL services call the plugin-host resolvers;
 *   - in the generator subprocess the REMOTE services forward each call
 *     over the generator's stdio to the admin, which answers it with the
 *     same local services (`serveBuildPluginCall`).
 *
 * Both paths end in the same resolver function with the same arguments,
 * so preview and published output agree by construction. Every call is a
 * main-line render (MAIN_RENDER): builds never render a chat branch.
 */

import type { ListOverlayIssue, PageUrlStyle } from "@caelo-cms/shared";
import { collectBuildAssets, type PluginClientAsset } from "./client-assets.js";
import {
  hasContentVariantContributors,
  type ResolvedContentVariants,
  resolveContentVariants,
} from "./content-variants.js";
import {
  hasDeferralContributors,
  type ResolvedDeferrals,
  resolveModuleDeferrals,
} from "./deferrals.js";
import {
  isPluginDisabled,
  loadedPlugins,
  MAIN_RENDER,
  renderInvocation,
  runPluginMetaSignature,
  runPluginMetaSignatureBatch,
  runPluginStaticRender,
} from "./dispatch.js";
import { type CollectedContributions, collectContributions } from "./head-composition.js";
import {
  hasLinkResolveContributors,
  type ResolvedLinkVariants,
  resolveLinkVariants,
} from "./link-resolve.js";
import {
  hasListResolveContributors,
  type ResolvedListOverlays,
  reportListOverlayIssues,
  resolveListOverlays,
} from "./list-resolve.js";
import {
  dormantListSourceNames,
  type ResolvedListSources,
  resolveListSources,
} from "./list-source-resolution.js";
import { pluginListSourcesRegistry } from "./list-sources.js";
import { type PublicUrlContext, type PublicUrlPage, resolvePublicPageUrls } from "./public-urls.js";

type ContentVariantPages = Parameters<typeof resolveContentVariants>[0];
type DeferralCandidates = Parameters<typeof resolveModuleDeferrals>[0];

/** A plugin whose `staticRender` fills `data-caelo-plugin` placeholders. */
export interface StaticRenderPlugin {
  readonly id: string;
  readonly slug: string;
  readonly version: string;
}

/** The plugin answers a static build consumes. All main-line renders. */
export interface BuildPluginServices {
  /** Plugin list-source entries per page (epic #1107). */
  resolveListSources(pageIds: string[], pageUrlStyle: PageUrlStyle): Promise<ResolvedListSources>;
  /** Declared list-source names whose plugin is not running (name → plugin). */
  dormantListSourceNames(): Promise<Record<string, string>>;
  /** Every declared list-source name, running or not. */
  declaredListSourceNames(): Promise<string[]>;
  hasListResolveContributors(): Promise<boolean>;
  /** The list-resolve point's overlays for these variants (epic #1107). */
  resolveListOverlays(variants: string[]): Promise<ResolvedListOverlays>;
  /** Hand refused overlay entries to the plugins' error channel. */
  reportListOverlayIssues(
    resolved: ResolvedListOverlays,
    issues: ListOverlayIssue[],
  ): Promise<void>;
  /** #1271 — whether any running plugin withholds modules (else no candidates are sent). */
  hasDeferralContributors(): Promise<boolean>;
  resolveModuleDeferrals(modules: DeferralCandidates): Promise<ResolvedDeferrals>;
  hasContentVariantContributors(): Promise<boolean>;
  resolveContentVariants(pages: ContentVariantPages): Promise<ResolvedContentVariants>;
  hasLinkResolveContributors(): Promise<boolean>;
  /** The link-resolve point's page-variant partition (#724, rollout D). */
  resolveLinkVariants(pageIds: string[]): Promise<ResolvedLinkVariants>;
  collectContributions(
    pageIds: string[],
    urlContext: PublicUrlContext,
  ): Promise<CollectedContributions>;
  resolvePublicPageUrls(
    pages: PublicUrlPage[],
    urlContext: PublicUrlContext,
  ): Promise<Map<string, string>>;
  collectBuildAssets(pageIds: string[]): Promise<PluginClientAsset[]>;
  staticRenderPlugins(): Promise<StaticRenderPlugin[]>;
  metaSignatureBatch(pluginSlug: string, pageIds: string[]): Promise<ReadonlyMap<string, string>>;
  metaSignature(pluginSlug: string, pageId: string): Promise<string>;
  staticRender(pluginSlug: string, pageId: string, pageUrlStyle: PageUrlStyle): Promise<string>;
}

/** The plugin host of THIS process — the admin's, where plugins run. */
export const localBuildPluginServices: BuildPluginServices = {
  resolveListSources: (pageIds, pageUrlStyle) =>
    resolveListSources(pageIds, MAIN_RENDER, pageUrlStyle),
  dormantListSourceNames: async () => dormantListSourceNames(),
  declaredListSourceNames: async () => pluginListSourcesRegistry.catalogue().map((c) => c.name),
  hasListResolveContributors: async () => hasListResolveContributors(),
  resolveListOverlays: (variants) => resolveListOverlays(variants, MAIN_RENDER),
  reportListOverlayIssues: (resolved, issues) => reportListOverlayIssues(resolved, issues),
  hasDeferralContributors: async () => hasDeferralContributors(),
  resolveModuleDeferrals: (modules) => resolveModuleDeferrals(modules, MAIN_RENDER),
  hasContentVariantContributors: async () => hasContentVariantContributors(),
  resolveContentVariants: (pages) => resolveContentVariants(pages, MAIN_RENDER),
  hasLinkResolveContributors: async () => hasLinkResolveContributors(),
  resolveLinkVariants: (pageIds) => resolveLinkVariants(pageIds, MAIN_RENDER),
  collectContributions: (pageIds, urlContext) =>
    collectContributions(pageIds, { ...MAIN_RENDER, ...urlContext }),
  resolvePublicPageUrls: (pages, urlContext) =>
    resolvePublicPageUrls(pages, urlContext, MAIN_RENDER),
  collectBuildAssets: (pageIds) => collectBuildAssets(pageIds, MAIN_RENDER),
  staticRenderPlugins: async () =>
    loadedPlugins
      .all()
      // A hot-disabled plugin stays loaded until restart; it must not
      // keep rendering into published pages.
      .filter((lp) => !isPluginDisabled(lp.slug))
      .filter((lp) => lp.tier === 1 && typeof lp.definition.staticRender === "function")
      .map((lp) => ({ id: lp.pluginId, slug: lp.slug, version: lp.version })),
  metaSignatureBatch: (pluginSlug, pageIds) =>
    runPluginMetaSignatureBatch({ invocation: renderInvocation(MAIN_RENDER), pluginSlug, pageIds }),
  metaSignature: (pluginSlug, pageId) =>
    runPluginMetaSignature({ invocation: renderInvocation(MAIN_RENDER), pluginSlug, pageId }),
  staticRender: async (pluginSlug, pageId, pageUrlStyle) =>
    (await runPluginStaticRender({
      invocation: renderInvocation(MAIN_RENDER),
      pluginSlug,
      pageId,
      pageUrlStyle,
    })) ?? "",
};

/** The method names a build may call — the RPC's whole surface. */
export const BUILD_PLUGIN_METHODS = [
  "resolveListSources",
  "dormantListSourceNames",
  "declaredListSourceNames",
  "hasListResolveContributors",
  "resolveListOverlays",
  "reportListOverlayIssues",
  "hasDeferralContributors",
  "resolveModuleDeferrals",
  "hasContentVariantContributors",
  "resolveContentVariants",
  "hasLinkResolveContributors",
  "resolveLinkVariants",
  "collectContributions",
  "resolvePublicPageUrls",
  "collectBuildAssets",
  "staticRenderPlugins",
  "metaSignatureBatch",
  "metaSignature",
  "staticRender",
] as const satisfies ReadonlyArray<keyof BuildPluginServices>;

export type BuildPluginMethod = (typeof BUILD_PLUGIN_METHODS)[number];

export function isBuildPluginMethod(name: unknown): name is BuildPluginMethod {
  return typeof name === "string" && (BUILD_PLUGIN_METHODS as readonly string[]).includes(name);
}

// JSON cannot carry a Map; several answers are Maps (keyed by page id).
// Encode them as tagged entry lists so the subprocess gets the same shape.
// Payloads carry arbitrary module/plugin content, so an ordinary object
// that happens to use a tag key is escaped too: every object whose keys
// include a tag travels as ESC_TAG entries and comes back unchanged.
const MAP_TAG = "__caeloMap";
const ESC_TAG = "__caeloObject";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map);
}

/** JSON text for an RPC payload, Maps included. */
export function encodeBuildPayload(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Map) return { [MAP_TAG]: [...v.entries()] };
    if (isPlainObject(v) && (MAP_TAG in v || ESC_TAG in v)) {
      return { [ESC_TAG]: Object.entries(v) };
    }
    return v;
  });
}

/** Inverse of `encodeBuildPayload`. */
export function decodeBuildPayload(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    // Only the exact envelopes the encoder writes: one key, an entry list.
    if (!isPlainObject(v)) return v;
    const keys = Object.keys(v);
    if (keys.length !== 1 || !Array.isArray(v[keys[0] as string])) return v;
    if (keys[0] === MAP_TAG) return new Map(v[MAP_TAG] as [unknown, unknown][]);
    if (keys[0] === ESC_TAG) return Object.fromEntries(v[ESC_TAG] as [string, unknown][]);
    return v;
  });
}

/**
 * Answer one call from a generator subprocess with this process's plugin
 * host. The method name is checked against `BUILD_PLUGIN_METHODS`; the
 * arguments come from our own generator, built from the same database.
 */
export async function serveBuildPluginCall(
  method: unknown,
  args: unknown,
  services: BuildPluginServices = localBuildPluginServices,
): Promise<unknown> {
  if (!isBuildPluginMethod(method)) {
    throw new Error(`build plugin call: unknown method ${JSON.stringify(method)}`);
  }
  if (!Array.isArray(args)) {
    throw new Error(`build plugin call ${method}: arguments must be an array`);
  }
  const fn = services[method] as (...a: unknown[]) => Promise<unknown>;
  return await fn(...args);
}

/**
 * Services that forward every call through `call` — the generator
 * subprocess's side of the RPC (cli.ts wires `call` to its stdio).
 */
export function remoteBuildPluginServices(
  call: (method: BuildPluginMethod, args: unknown[]) => Promise<unknown>,
): BuildPluginServices {
  const out: Partial<Record<BuildPluginMethod, (...a: unknown[]) => Promise<unknown>>> = {};
  for (const method of BUILD_PLUGIN_METHODS) {
    out[method] = (...args: unknown[]) => call(method, args);
  }
  return out as unknown as BuildPluginServices;
}
