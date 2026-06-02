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

import { createHash } from "node:crypto";
import type { PluginContext, PluginContextTier1, PluginDefinition } from "@caelo-cms/plugin-sdk";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
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
  /** v0.2.16 — true when a Tier-2 plugin's row + schema survived an
   *  upgrade and was registered from the DB at bootstrap, but the
   *  Deno-subprocess execution runtime is not yet wired. The plugin
   *  is visible in `/security/plugins`; runOperation returns
   *  Tier2RuntimePending. Defaults to undefined for Tier-1 + active
   *  Tier-2 plugins (when the runtime ships, this flag stops being
   *  set). */
  readonly executionStub?: boolean;
  /** Operation names from the plugin's manifest. Used only when
   *  `executionStub` is true to distinguish "operation declared but
   *  runtime missing" (Tier2RuntimePending) from "operation not
   *  declared at all" (OperationNotDeclared). Real Tier-1 plugins
   *  read their declared operations from `definition.operations`. */
  readonly declaredOperationNames?: ReadonlyArray<string>;
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
          | "OperationFailed"
          | "Tier2RuntimePending";
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
  // v0.2.16 — Tier-2 plugin survived upgrade (DB-loaded by loader) but
  // execution runtime isn't wired yet. Honest error rather than the
  // stale-feeling OperationNotDeclared (the operation IS declared in
  // the manifest; we just can't run it).
  if (plugin.executionStub) {
    const declared = plugin.declaredOperationNames?.includes(opts.operationName) ?? false;
    if (!declared) {
      return {
        ok: false,
        error: {
          kind: "OperationNotDeclared",
          message: `plugin "${opts.pluginSlug}" does not declare operation "${opts.operationName}"`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "Tier2RuntimePending",
        message:
          `Tier-2 plugin "${opts.pluginSlug}" is registered (source + schema survived the upgrade) ` +
          `but the Deno-subprocess execution runtime is not yet shipped. ` +
          `Use Tier-1 (PR-shipped) plugins for runtime functionality, or wait for the runtime ship.`,
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
    // v0.2.16 — emit an audit_events row so plugin write ops (e.g.
    // `comments.moderate`) are visible to the redeploy orchestrator's
    // poll, allowing per-page incremental rebuild on plugin data
    // change. Best-effort: failure to audit doesn't fail the op.
    try {
      await emitPluginAuditRow(cachedInfra.adapter, {
        actorId: plugin.pluginActorId,
        operation: `${plugin.slug}.${opts.operationName}`,
        inputArgs: opts.args,
        entityId: extractEntityId(value),
        succeeded: true,
      });
    } catch {
      // Audit failure shouldn't surface to the visitor / caller.
    }
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

/** Field names whose values are redacted before the audit digest is taken. */
const SENSITIVE_KEY_RE = /pass(word|wd|phrase)?|secret|token|api[-_]?key|credential|private[-_]?key/i;

/**
 * Deep-copy `value`, replacing the value of any sensitive-named field with
 * a fixed placeholder. Prototype-polluting keys are dropped (never assigned)
 * so this helper introduces no pollution of its own. Object key order is
 * preserved, so the resulting JSON — and therefore the digest — is
 * deterministic for equal inputs.
 */
function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redactSensitive(v);
    }
    return out;
  }
  return value;
}

/**
 * Audit integrity digest of a plugin op's input arguments. This is NOT a
 * password hash — it is a one-way fingerprint stored in
 * `audit_events.input_hash` so the operator can correlate and tamper-check
 * op calls. Sensitive-named fields (`*password*`, `*secret*`, tokens, …)
 * are redacted first, so the digest can never act as an offline oracle for
 * a secret and its input carries no credential-shaped data
 * (CodeQL js/insufficient-password-hash). SHA-256 is the correct primitive
 * for a deterministic integrity fingerprint; a slow salted password KDF
 * would be wrong here (non-deterministic, defeats correlation).
 */
export function auditInputDigest(inputArgs: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(redactSensitive(inputArgs ?? null)))
    .digest("hex");
}

/**
 * v0.2.16 — write an audit_events row for a plugin op. Mirrors the
 * shape `recordAudit` in admin-core uses, but runs raw SQL because
 * plugin-host is a peer of admin-core (no upward import). The row
 * lets the redeploy orchestrator + the operator's own audit trail
 * see plugin write activity without each plugin author needing to
 * call recordAudit explicitly.
 */
async function emitPluginAuditRow(
  adapter: DatabaseAdapter,
  args: {
    actorId: string;
    operation: string;
    inputArgs: unknown;
    entityId: string | null;
    succeeded: boolean;
  },
): Promise<void> {
  const hash = auditInputDigest(args.inputArgs);
  await adapter.withAdminTransaction(
    {
      actorId: args.actorId,
      actorKind: "plugin",
      requestId: `plugin-op-audit-${args.operation}`,
    },
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO audit_events (actor_id, operation, input_hash, succeeded, entity_id)
        VALUES (
          ${args.actorId}::uuid,
          ${args.operation},
          ${hash},
          ${args.succeeded},
          ${args.entityId === null ? null : sql`${args.entityId}::uuid`}
        )
      `);
    },
  );
}

/**
 * Extract a plausible entity id from a plugin op's return value. The
 * convention: handlers that affect a specific row return an object
 * with a field matching the table's primary key (`commentId`,
 * `ratingId`, `formSubmissionId`, …) OR a generic `id`. The audit
 * row's entity_id then unblocks per-page redeploy resolution in the
 * orchestrator (which queries the plugin's own table by id to find
 * the bound page_id). Falls back to null when the result doesn't
 * look like one of these shapes.
 */
function extractEntityId(result: unknown): string | null {
  if (result === null || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  // Common per-table conventions first.
  for (const key of ["commentId", "ratingId", "formSubmissionId", "subscriberId", "campaignId"]) {
    const v = r[key];
    if (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)) return v;
  }
  // Generic fallback.
  if (typeof r.id === "string" && /^[0-9a-f-]{36}$/i.test(r.id)) return r.id;
  return null;
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
