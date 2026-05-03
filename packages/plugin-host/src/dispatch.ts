// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/dispatch — invoke a Tier-1 plugin operation.
 *
 * The route handler / API gateway / chat-runner / scheduler all funnel through
 * `runPluginOperation`. It looks up the plugin's frozen spec, validates that
 * the operation is declared, builds the per-call ctx via `makePluginContext`,
 * and calls the operation handler.
 *
 * Operation results are returned verbatim — no schema validation here (the
 * plugin author is responsible for its own input/output Zod gates inside the
 * operation handler).
 */

import type { PluginContext, PluginContextTier1, PluginDefinition } from "@caelo-cms/plugin-sdk";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { AIProvider } from "./types.js";

/** Runtime registry of loaded Tier-1 plugins. Loader writes here at startup;
 *  dispatch reads. Disable removes the entry; re-enable adds it back. */
class LoadedPluginsRegistry {
  readonly #byId = new Map<string, LoadedPlugin>();
  readonly #bySlug = new Map<string, LoadedPlugin>();

  set(plugin: LoadedPlugin): void {
    this.#byId.set(plugin.pluginId, plugin);
    this.#bySlug.set(plugin.slug, plugin);
  }

  bySlug(slug: string): LoadedPlugin | undefined {
    return this.#bySlug.get(slug);
  }

  byId(id: string): LoadedPlugin | undefined {
    return this.#byId.get(id);
  }

  unload(slug: string): void {
    const p = this.#bySlug.get(slug);
    if (!p) return;
    this.#byId.delete(p.pluginId);
    this.#bySlug.delete(slug);
  }

  all(): ReadonlyArray<LoadedPlugin> {
    return [...this.#bySlug.values()];
  }

  reset(): void {
    this.#byId.clear();
    this.#bySlug.clear();
  }
}

export interface LoadedPlugin {
  readonly pluginId: string;
  readonly slug: string;
  readonly version: string;
  readonly tier: 1 | 2;
  readonly definition: PluginDefinition<PluginContext> | PluginDefinition<PluginContextTier1>;
  /** Per-plugin actor row id — set as caelo.actor_id when the plugin's
   *  operations write through the Query API. */
  readonly pluginActorId: string;
}

export const loadedPlugins = new LoadedPluginsRegistry();

/**
 * Audit fix #2 — soft-disabled set. Disable doesn't unload the plugin's
 * spec from the host (so re-enable is fast), but tools / workers /
 * dispatch all respect this set. The `plugins.disable` op writes the
 * DB row + calls `setPluginDisabled(slug, true)`; `plugins.activate`
 * after disabled clears the flag. No process restart needed.
 */
const disabledSlugs = new Set<string>();

export function setPluginDisabled(slug: string, disabled: boolean): void {
  if (disabled) disabledSlugs.add(slug);
  else disabledSlugs.delete(slug);
}

export function isPluginDisabled(slug: string): boolean {
  return disabledSlugs.has(slug);
}

export function resetDisabledSet(): void {
  disabledSlugs.clear();
}

/** Bag of host machinery passed to the capability factory. Bootstrap
 *  injects these from the host process (apps/admin) so plugin-host stays
 *  free of upward circular imports on @caelo-cms/admin-core. */
export interface PluginHostInfra {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /** Optional — only required if any active plugin requested `ai_provider`. */
  readonly aiProvider?: AIProvider;
  /** Optional — only required if any active plugin requested `snapshots`.
   *  The host calls this from inside `adapter.withAdminTransaction(...)`,
   *  so the supplied function gets the live tx. Mirrors admin-core's
   *  `emitSnapshot` signature; bootstrap passes that fn here. */
  readonly emitSnapshot?: SnapshotEmitter;
  /** P12 PR1.3 — optional outbound email transport. When omitted,
   *  ctx.email.send falls back to a no-op stderr stub. */
  readonly emailTransport?: EmailTransport;
}

/** Outbound email transport. Implementations live in the host process
 *  (apps/admin) and may wrap nodemailer / Resend / SES. */
export interface EmailTransport {
  send(args: {
    to: string;
    subject: string;
    html: string;
    replyTo?: string;
  }): Promise<{ messageId: string }>;
}

export interface SnapshotEmitterInput {
  readonly actorId: string;
  readonly opKind: string;
  readonly description: string;
  readonly entities: ReadonlyArray<{
    readonly kind: string;
    readonly id: string;
    readonly payload: unknown;
  }>;
  readonly chatBranchId?: string | null;
  readonly chatTaskId?: string | null;
  readonly revertOf?: string | null;
}

export type SnapshotEmitter = (
  tx: unknown,
  input: SnapshotEmitterInput,
) => Promise<{ siteSnapshotId: string }>;

/** The capability factory is injected to break a circular import between
 *  dispatch + capabilities (capabilities call dispatch.runPluginOperation
 *  for `ctx.cms.call`-style cases). The loader sets this once at boot. */
let makeContext: ((opts: MakeContextOpts) => Promise<PluginContext | PluginContextTier1>) | null =
  null;

interface MakeContextOpts {
  readonly plugin: LoadedPlugin;
  readonly infra: PluginHostInfra;
  /** Visitor-facing context if dispatched from the API gateway. */
  readonly visitorContext?: VisitorDispatchContext;
}

/**
 * Per-request visitor context populated by the gateway. Optional
 * `sessionMutation` lets the auth plugin's `setSession()` mark the
 * response so the gateway emits a Set-Cookie. Mutated in-place; the
 * gateway reads it post-dispatch.
 */
export interface VisitorDispatchContext {
  readonly visitorId: string;
  readonly locale: string;
  readonly sessionToken: string | null;
  readonly sessionMutation?: {
    current:
      | { kind: "none" }
      | { kind: "set"; sessionToken: string; expiresAt: string }
      | { kind: "clear" };
  };
}

export function setContextFactory(
  fn: (opts: MakeContextOpts) => Promise<PluginContext | PluginContextTier1>,
): void {
  makeContext = fn;
}

export interface RunPluginOperationOpts {
  readonly pluginSlug: string;
  readonly operationName: string;
  readonly args: unknown;
  /** Override the plugin's own actor when needed (e.g. test fixtures).
   *  Production callers omit this — dispatch uses `loadedPlugins.bySlug(...).pluginActorId`. */
  readonly pluginActorId?: string;
  readonly visitorContext?: VisitorDispatchContext;
}

export type RunPluginOperationResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind:
          | "PluginNotFound"
          | "PluginDisabled"
          | "OperationNotDeclared"
          | "OperationFailed";
        readonly message: string;
      };
    };

/**
 * Dispatch a plugin operation. Returns a Result; never throws.
 *
 * Caller must ensure the host's `bootstrap()` ran first (or, in tests,
 * `setHostInfra(...)` + `setContextFactory(...)` were both invoked).
 */
let cachedInfra: PluginHostInfra | null = null;
export function setHostInfra(infra: PluginHostInfra): void {
  cachedInfra = infra;
}

export async function runPluginOperation(
  opts: RunPluginOperationOpts,
): Promise<RunPluginOperationResult> {
  const plugin = loadedPlugins.bySlug(opts.pluginSlug);
  if (!plugin) {
    return {
      ok: false,
      error: {
        kind: "PluginNotFound",
        message: `no loaded plugin with slug "${opts.pluginSlug}"`,
      },
    };
  }
  if (isPluginDisabled(opts.pluginSlug)) {
    return {
      ok: false,
      error: {
        kind: "PluginDisabled",
        message: `plugin "${opts.pluginSlug}" is disabled — re-enable via /security/plugins`,
      },
    };
  }
  const handler = plugin.definition.operations[opts.operationName];
  if (!handler) {
    return {
      ok: false,
      error: {
        kind: "OperationNotDeclared",
        message: `plugin "${opts.pluginSlug}" does not declare operation "${opts.operationName}"`,
      },
    };
  }
  if (!cachedInfra || !makeContext) {
    return {
      ok: false,
      error: {
        kind: "OperationFailed",
        message: "plugin host not bootstrapped — call bootstrap() before dispatch",
      },
    };
  }
  let ctx: PluginContext | PluginContextTier1;
  try {
    ctx = await makeContext({
      plugin,
      infra: cachedInfra,
      visitorContext: opts.visitorContext,
    });
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: "OperationFailed",
        message: `failed to build plugin context: ${(e as Error).message}`,
      },
    };
  }
  try {
    const value = await handler(ctx as PluginContext, opts.args);
    return { ok: true, value };
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: "OperationFailed",
        message: `plugin "${opts.pluginSlug}" operation "${opts.operationName}" threw: ${(e as Error).message}`,
      },
    };
  }
}

/**
 * P13 — invoke the plugin's `staticRender(ctx, {pageId, locale})`
 * function via the same context factory used by ordinary ops. Returns
 * `null` when the plugin doesn't declare a staticRender. Used by the
 * static generator's plugin pass to bake plugin-emitted HTML at deploy.
 */
export async function runPluginStaticRender(opts: {
  pluginSlug: string;
  pageId: string;
  locale: string;
}): Promise<string | null> {
  const plugin = loadedPlugins.bySlug(opts.pluginSlug);
  if (!plugin) return null;
  const render = plugin.definition.staticRender;
  if (typeof render !== "function") return null;
  if (!cachedInfra || !makeContext) {
    throw new Error("plugin host not bootstrapped");
  }
  const ctx = await makeContext({ plugin, infra: cachedInfra });
  const out = await render(ctx as PluginContext, {
    pageId: opts.pageId,
    locale: opts.locale,
  });
  return typeof out === "string" ? out : "";
}

/**
 * P13 perf-pass — invoke the plugin's `metaSignatureBatch(...)` to
 * resolve N (page, locale) signatures in ONE call. Returns a Map keyed
 * by pageId. Empty Map when the plugin doesn't declare the batch
 * variant — caller falls back to per-page `runPluginMetaSignature`.
 */
export async function runPluginMetaSignatureBatch(opts: {
  pluginSlug: string;
  locale: string;
  pageIds: ReadonlyArray<string>;
}): Promise<ReadonlyMap<string, string>> {
  const plugin = loadedPlugins.bySlug(opts.pluginSlug);
  if (!plugin) return new Map();
  const sig = (plugin.definition as { metaSignatureBatch?: unknown }).metaSignatureBatch;
  if (typeof sig !== "function") return new Map();
  if (!cachedInfra || !makeContext) {
    throw new Error("plugin host not bootstrapped");
  }
  const ctx = await makeContext({ plugin, infra: cachedInfra });
  const out = await (
    sig as (
      c: unknown,
      a: { locale: string; pageIds: ReadonlyArray<string> },
    ) => Promise<ReadonlyMap<string, string>> | ReadonlyMap<string, string>
  )(ctx, { locale: opts.locale, pageIds: opts.pageIds });
  return out instanceof Map ? out : new Map();
}

/**
 * P13 audit fix #4 — invoke the plugin's `metaSignature(...)` to fold
 * its data-change signal into the static_bakes cache key. Returns the
 * plugin's own signature string (any shape — opaque to the cache).
 * Returns "" when the plugin doesn't declare metaSignature.
 */
export async function runPluginMetaSignature(opts: {
  pluginSlug: string;
  pageId: string;
  locale: string;
}): Promise<string> {
  const plugin = loadedPlugins.bySlug(opts.pluginSlug);
  if (!plugin) return "";
  const sig = (plugin.definition as { metaSignature?: unknown }).metaSignature;
  if (typeof sig !== "function") return "";
  if (!cachedInfra || !makeContext) {
    throw new Error("plugin host not bootstrapped");
  }
  const ctx = await makeContext({ plugin, infra: cachedInfra });
  const out = await (
    sig as (c: unknown, a: { pageId: string; locale: string }) => Promise<string> | string
  )(ctx, { pageId: opts.pageId, locale: opts.locale });
  return typeof out === "string" ? out : "";
}
