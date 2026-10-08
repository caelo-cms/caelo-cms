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

import type { PageUrlStyle } from "@caelo-cms/shared";
import { collectBuildAssets, type PluginClientAsset } from "./client-assets.js";
import {
  hasContentVariantContributors,
  type ResolvedContentVariants,
  resolveContentVariants,
} from "./content-variants.js";
import { type ResolvedDataLists, resolveDataLists } from "./data-list-resolution.js";
import { pluginDataListsRegistry } from "./data-lists.js";
import { type ResolvedDeferrals, resolveModuleDeferrals } from "./deferrals.js";
import {
  loadedPlugins,
  MAIN_RENDER,
  renderInvocation,
  runPluginMetaSignature,
  runPluginMetaSignatureBatch,
  runPluginStaticRender,
} from "./dispatch.js";
import { type CollectedContributions, collectContributions } from "./head-composition.js";
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
  resolveDataLists(pageIds: string[], pageUrlStyle: PageUrlStyle): Promise<ResolvedDataLists>;
  /** Declared list names whose plugin is not running (name → plugin). */
  dormantDataListNames(): Promise<Record<string, string>>;
  /** Every declared list name, running or not. */
  declaredDataListNames(): Promise<string[]>;
  resolveModuleDeferrals(modules: DeferralCandidates): Promise<ResolvedDeferrals>;
  hasContentVariantContributors(): Promise<boolean>;
  resolveContentVariants(
    pages: ContentVariantPages,
    pageUrlStyle: PageUrlStyle,
  ): Promise<ResolvedContentVariants>;
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
  resolveDataLists: (pageIds, pageUrlStyle) => resolveDataLists(pageIds, MAIN_RENDER, pageUrlStyle),
  dormantDataListNames: async () => Object.fromEntries(pluginDataListsRegistry.dormantNames()),
  declaredDataListNames: async () => pluginDataListsRegistry.catalogue().map((c) => c.name),
  resolveModuleDeferrals: (modules) => resolveModuleDeferrals(modules, MAIN_RENDER),
  hasContentVariantContributors: async () => hasContentVariantContributors(),
  resolveContentVariants: (pages, pageUrlStyle) =>
    resolveContentVariants(pages, MAIN_RENDER, pageUrlStyle),
  collectContributions: (pageIds, urlContext) =>
    collectContributions(pageIds, { ...MAIN_RENDER, ...urlContext }),
  resolvePublicPageUrls: (pages, urlContext) =>
    resolvePublicPageUrls(pages, urlContext, MAIN_RENDER),
  collectBuildAssets: (pageIds) => collectBuildAssets(pageIds, MAIN_RENDER),
  staticRenderPlugins: async () =>
    loadedPlugins
      .all()
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
  "resolveDataLists",
  "dormantDataListNames",
  "declaredDataListNames",
  "resolveModuleDeferrals",
  "hasContentVariantContributors",
  "resolveContentVariants",
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
const MAP_TAG = "__caeloMap";

/** JSON text for an RPC payload, Maps included. */
export function encodeBuildPayload(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v instanceof Map ? { [MAP_TAG]: [...v.entries()] } : v,
  );
}

/** Inverse of `encodeBuildPayload`. */
export function decodeBuildPayload(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v !== null && typeof v === "object" && MAP_TAG in v) {
      return new Map((v as Record<string, [unknown, unknown][]>)[MAP_TAG]);
    }
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
