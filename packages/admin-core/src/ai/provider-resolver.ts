// SPDX-License-Identifier: MPL-2.0

/**
 * ProviderResolver — single source of truth for "give me an AIProvider
 * instance to call right now."
 *
 * Resolution order per provider name:
 *   1. The active row in `ai_providers` (decrypts api_key_encrypted via
 *      secret-box if present).
 *   2. process.env[envNameFor(name)] — preserves Compose installs that
 *      already wired ANTHROPIC_API_KEY before this refactor.
 *   3. null — caller surfaces "AI provider not configured" through
 *      degraded-mode behaviour (translation worker errors per unit; chat
 *      stream emits SSE error; MCP bridge returns structured error).
 *
 * Cache: in-process Map keyed by (name, model, baseUrl, sha256(key)[0..8])
 * with 60s TTL so we don't re-decrypt on every chat turn. `pg_notify`
 * from `ai_providers.set` / `clear_key` invalidates the per-name slot
 * via the `invalidateProviderCache(name?)` export. Cross-process LISTEN
 * consumer is a P18 follow-up; TTL covers the multi-replica case.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { decryptSecret } from "../security/secret-box.js";
import type { AIProvider, ProviderName } from "./provider.js";
import { makeProvider } from "./providers/index.js";

const PROVIDER_NAMES = ["anthropic", "openai", "google", "local-openai-compat"] as const;

const DEFAULT_MODEL: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o",
  google: "gemini-1.5-pro",
  "local-openai-compat": "qwen2.5",
};

/** Map provider name → legacy env var the resolver falls back to. */
function envNameFor(name: ProviderName): string {
  switch (name) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_API_KEY";
    case "local-openai-compat":
      return "LOCAL_OPENAI_API_KEY";
  }
}

interface ResolverDeps {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
}

interface ResolvedProvider {
  readonly provider: AIProvider;
  readonly source: "db" | "env";
  readonly providerName: ProviderName;
  readonly model: string;
  /** Per-decrypted-key fingerprint (sha256[0..8]) — used as cache key + audit. */
  readonly keyFingerprint: string;
  /**
   * v0.2.53 — Per-provider output ceiling sourced from
   * `ai_providers.config.maxOutputTokens`. Undefined when the operator
   * hasn't tuned it; chat-runner falls back to its own
   * `MAX_OUTPUT_TOKENS_DEFAULT` (16384) which then hits the per-provider
   * default in `buildRequestBody`. Validated as positive integer in
   * [1024, 200000] at config-write time.
   */
  readonly maxOutputTokens?: number;
  /**
   * Per-call temperature override sourced from `CAELO_CHAT_TEMPERATURE`.
   * Only populated when `NODE_ENV !== "production"` and the env var is
   * set + finite — guarded so a test-only knob can never alter
   * production resolution. The chat-runner threads this into
   * `provider.generate({ temperature })`; chat-stream callers can
   * override per-request via `ChatRunnerOptions.temperature`.
   */
  readonly temperature?: number;
}

/**
 * `NODE_ENV !== "production"` guard for the test-only env hooks below.
 * Centralised so the test for AC #16 can prove no production code path
 * touches these reads when `NODE_ENV=production`.
 */
function isTestEnvHookActive(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Test-only model override (e2e-livedit pins Sonnet 4.6 dated id).
 * Restricted to the Anthropic provider so it cannot accidentally point
 * an OpenAI / Gemini install at a Claude id.
 */
function readModelOverride(name: ProviderName): string | undefined {
  if (!isTestEnvHookActive()) return undefined;
  if (name !== "anthropic") return undefined;
  const v = process.env.CAELO_CHAT_MODEL_OVERRIDE;
  if (typeof v !== "string" || v.length === 0) return undefined;
  return v;
}

/**
 * Test-only temperature override (e2e-livedit pins `0` for determinism).
 * Same anthropic-only + non-production guards as `readModelOverride`.
 * Fails loudly per CLAUDE.md §2 when the env var is set to a
 * non-finite value — never silently falls back to the model default.
 */
function readTemperatureOverride(name: ProviderName): number | undefined {
  if (!isTestEnvHookActive()) return undefined;
  if (name !== "anthropic") return undefined;
  const raw = process.env.CAELO_CHAT_TEMPERATURE;
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `[provider-resolver] CAELO_CHAT_TEMPERATURE is not a valid finite number: ${JSON.stringify(raw)}. Expected a float (e.g. "0", "0.7"). Unset the env var or set NODE_ENV=production to disable.`,
    );
  }
  return parsed;
}

/**
 * One-shot boot-time warning: if production has been deployed with the
 * test-only env hooks still set in its environment (env-file copy from
 * a test env, leftover container env, etc.), the hooks are silently
 * ignored — but the operator likely thinks they configured something.
 * Surface it loudly per CLAUDE.md §2 so the misconfiguration shows up
 * in production logs at boot instead of being invisible.
 *
 * Module-level so it runs exactly once at admin bootstrap. No effect
 * outside production: the test environment expects these vars to be
 * honoured and shouldn't see the warn.
 */
function warnOnProductionEnvHookLeak(): void {
  if (process.env.NODE_ENV !== "production") return;
  const leaked: string[] = [];
  if (
    typeof process.env.CAELO_CHAT_MODEL_OVERRIDE === "string" &&
    process.env.CAELO_CHAT_MODEL_OVERRIDE.length > 0
  ) {
    leaked.push("CAELO_CHAT_MODEL_OVERRIDE");
  }
  if (
    typeof process.env.CAELO_CHAT_TEMPERATURE === "string" &&
    process.env.CAELO_CHAT_TEMPERATURE.length > 0
  ) {
    leaked.push("CAELO_CHAT_TEMPERATURE");
  }
  if (leaked.length > 0) {
    console.warn(
      `[provider-resolver] test-only env hook(s) set under NODE_ENV=production: ${leaked.join(", ")}. These are IGNORED in production by design; unset them in this environment to silence this warning.`,
    );
  }
}
warnOnProductionEnvHookLeak();

interface CacheEntry {
  readonly resolved: ResolvedProvider;
  /** Wall-clock ms when this entry expires. */
  readonly expiresAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<ProviderName, CacheEntry>();
let deps: ResolverDeps | null = null;

/**
 * Wire the resolver to the live adapter + registry. Called once at
 * SvelteKit hooks bootstrap; tests can re-call to reset.
 */
export function configureProviderResolver(d: ResolverDeps): void {
  deps = d;
  cache.clear();
  tierCache.clear();
}

/**
 * Drop a cached provider so the next `getActiveProvider` / `getProviderByName`
 * call re-reads from the DB. Called by `ai_providers.set` / `clear_key`
 * via in-process pg_notify (commit 2 emits the notify; commit 3 wires the
 * subscriber inside this resolver via a periodic poll for now —
 * cross-process LISTEN ships as a P18 follow-up).
 */
export function invalidateProviderCache(name?: ProviderName): void {
  // issue #306 — tier-resolved providers derive from the same rows;
  // any provider-config change invalidates them wholesale (they are
  // few and cheap to re-resolve).
  tierCache.clear();
  if (!name) {
    cache.clear();
    return;
  }
  cache.delete(name);
}

/**
 * Compute a short fingerprint of the API key so the cache key + audit can
 * detect "key changed under us" without persisting the plaintext.
 */
async function fingerprintKey(key: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key) as BufferSource);
  return Array.from(new Uint8Array(hash).slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Run a callback inside a transaction with system-context RLS vars set.
 * `ai_providers` requires `caelo.actor_kind` to be non-empty; the resolver
 * is purely server-internal so 'system' is the natural identity.
 *
 * `tx` is untyped here on purpose — bun's `TransactionSQL` shape is a
 * tagged-template callable; the existing rate-limit + integration-test
 * code uses the same untyped pattern.
 */
async function withSystemTx<T>(
  d: ResolverDeps,
  // biome-ignore lint/suspicious/noExplicitAny: bun TransactionSQL is callable; see comment above
  fn: (tx: any) => Promise<T>,
): Promise<T> {
  return d.adapter.rawAdmin().begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    return fn(tx);
  }) as Promise<T>;
}

function bytesFrom(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v && typeof v === "object" && "buffer" in v && "byteOffset" in v && "byteLength" in v) {
    const b = v as { buffer: ArrayBufferLike; byteOffset: number; byteLength: number };
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  throw new Error("provider-resolver: expected Uint8Array/Buffer for bytea column");
}

/** Read one provider row's encrypted bytes (system context). */
async function loadEncryptedKeyFromDb(
  d: ResolverDeps,
  name: ProviderName,
): Promise<{
  ciphertext: Uint8Array;
  iv: Uint8Array;
  kekFingerprint: string;
} | null> {
  // SECURITY: the regular `ai_providers.list` op deliberately omits the
  // ciphertext columns (its projection contract guarantees AI/human
  // requests never see them). The resolver runs as system context and
  // reads the raw bytes here.
  const rows = (await withSystemTx(
    d,
    (tx) => tx`
      SELECT api_key_encrypted, api_key_iv, api_key_kek_fp
      FROM ai_providers
      WHERE name = ${name}
        AND is_active = true
        AND api_key_encrypted IS NOT NULL
      LIMIT 1
    `,
  )) as unknown as {
    api_key_encrypted: unknown;
    api_key_iv: unknown;
    api_key_kek_fp: string;
  }[];
  const row = rows[0];
  if (!row) return null;
  return {
    ciphertext: bytesFrom(row.api_key_encrypted),
    iv: bytesFrom(row.api_key_iv),
    kekFingerprint: row.api_key_kek_fp,
  };
}

/**
 * v0.2.53 — Validated extractor for `ai_providers.config.maxOutputTokens`.
 * Returns undefined for any non-numeric / out-of-range value so the chat-
 * runner's default kicks in. Range chosen to span every current model's
 * supported max (Haiku 4.5 ~32k, Sonnet 4.6 ~64k, GPT-4o ~16k, Gemini 2.5
 * ~64k) without letting an operator paste a typo like "1000000".
 */
function readMaxOutputTokens(config: Record<string, unknown>): number | undefined {
  const v = config.maxOutputTokens;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  if (!Number.isInteger(v)) return undefined;
  if (v < 1024 || v > 200000) return undefined;
  return v;
}

/** Read the active provider's name + config (model + baseUrl + maxOutputTokens). */
async function loadActiveProviderMeta(d: ResolverDeps): Promise<{
  name: ProviderName;
  model: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  /** issue #306 — raw `config.modelTiers` value; validated by
   *  `parseModelTierMap` in model-tiers.ts at the call site. */
  modelTiersRaw?: unknown;
} | null> {
  const rows = (await withSystemTx(
    d,
    (tx) => tx`
      SELECT name, config
      FROM ai_providers
      WHERE is_active = true
      ORDER BY created_at ASC
      LIMIT 1
    `,
  )) as unknown as {
    name: ProviderName;
    config: Record<string, unknown> | string;
  }[];
  const row = rows[0];
  if (!row) return null;
  const config = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
  const model = typeof config.model === "string" ? config.model : DEFAULT_MODEL[row.name];
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : undefined;
  const maxOutputTokens = readMaxOutputTokens(config);
  return {
    name: row.name,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(config.modelTiers !== undefined ? { modelTiersRaw: config.modelTiers } : {}),
  };
}

/** Read one specific provider's name + config. */
async function loadProviderMeta(
  d: ResolverDeps,
  name: ProviderName,
): Promise<{ model: string; baseUrl?: string; maxOutputTokens?: number } | null> {
  const rows = (await withSystemTx(
    d,
    (tx) => tx`
      SELECT config FROM ai_providers WHERE name = ${name} LIMIT 1
    `,
  )) as unknown as { config: Record<string, unknown> | string }[];
  const row = rows[0];
  if (!row) return null;
  const config = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
  const model = typeof config.model === "string" ? config.model : DEFAULT_MODEL[name];
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : undefined;
  const maxOutputTokens = readMaxOutputTokens(config);
  return {
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

/**
 * Load a provider's API key: DB-stored encrypted key first, then the
 * legacy env-var fallback. Extracted from `resolveProvider` (issue #306)
 * so tier-model resolution (`getActiveProviderForModel`) shares the exact
 * same key path instead of duplicating the KEK-recovery behaviour.
 */
async function loadApiKey(
  d: ResolverDeps,
  name: ProviderName,
): Promise<{ apiKey: string; source: "db" | "env" } | null> {
  const encrypted = await loadEncryptedKeyFromDb(d, name);
  if (encrypted) {
    try {
      const apiKey = await decryptSecret({
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        kekFingerprint: encrypted.kekFingerprint,
      });
      return { apiKey, source: "db" };
    } catch (e) {
      // v0.2.81 — KEK rotation orphaned the stored ciphertext.
      // Treat as "no key" so the chat handler routes the operator
      // to /security/ai with a clear "re-enter your API key" UX
      // instead of crashing the SSE stream with a 500. The
      // /security/ai page detects the same condition and shows a
      // recovery affordance. Pre-v0.2.81 the Pulumi stack
      // regenerated the KEK on every `pulumi up` (random.RandomBytes
      // resource fixes that going forward); for installs that
      // already lost their KEK, this catch is the recovery on-ramp.
      const message = e instanceof Error ? e.message : String(e);
      console.warn(
        `[provider-resolver] DB-stored key for ${name} unreadable (${message}). Falling back to env / surfacing as not-configured.`,
      );
    }
  }
  const envKey = process.env[envNameFor(name)];
  if (envKey) return { apiKey: envKey, source: "env" };
  return null;
}

/**
 * Resolve `name` → ResolvedProvider | null. Hits cache first, then DB,
 * then env-var fallback.
 */
async function resolveProvider(
  name: ProviderName,
  meta: { model: string; baseUrl?: string; maxOutputTokens?: number },
): Promise<ResolvedProvider | null> {
  if (!deps) {
    throw new Error("provider-resolver not configured — call configureProviderResolver() at boot");
  }
  // Test-only overrides (anthropic + NODE_ENV != production). Read once
  // per call so the unit test for AC #16 can flip env vars in-process.
  const effectiveModel = readModelOverride(name) ?? meta.model;
  const temperature = readTemperatureOverride(name);
  const cached = cache.get(name);
  const now = Date.now();
  if (
    cached &&
    cached.expiresAt > now &&
    cached.resolved.model === effectiveModel &&
    cached.resolved.maxOutputTokens === meta.maxOutputTokens &&
    cached.resolved.temperature === temperature
  ) {
    return cached.resolved;
  }

  const key = await loadApiKey(deps, name);
  if (!key) return null;
  const { apiKey, source } = key;

  const provider = makeProvider({
    name,
    model: effectiveModel,
    apiKey,
    ...(meta.baseUrl ? { baseUrl: meta.baseUrl } : {}),
  });
  const keyFingerprint = await fingerprintKey(apiKey);
  const resolved: ResolvedProvider = {
    provider,
    source,
    providerName: name,
    model: effectiveModel,
    keyFingerprint,
    ...(meta.maxOutputTokens !== undefined ? { maxOutputTokens: meta.maxOutputTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };
  cache.set(name, { resolved, expiresAt: now + TTL_MS });
  return resolved;
}

/**
 * Get the currently-active provider (the one with `is_active = true`).
 * Returns null when no provider is configured anywhere — chat / translation
 * / plugin host all surface this as "configure your AI provider."
 */
/**
 * v0.2.82 — diagnostic probe for the /security/ai UI. Distinguishes
 * the three "key isn't usable" reasons so the page can show a
 * specific banner (vs the generic "Encrypted key set" which was
 * misleading after the v0.2.81 KEK-rotation incident — operators
 * saw "configured" but chat said "not configured").
 *
 *   'ok'                    — DB row present + decrypts successfully
 *   'env_only'              — no DB row, env var fallback in play
 *   'no_key'                — no DB row + no env var
 *   'unreadable_kek_mismatch' — DB row present BUT sealed under a
 *                              different KEK; operator must re-paste
 *                              the API key to recover (the cipher
 *                              under the old KEK is unrecoverable)
 *
 * Read-only; no side-effects on the resolver cache. Safe to call
 * for every provider on page load.
 */
export type ProviderKeyHealth = "ok" | "env_only" | "no_key" | "unreadable_kek_mismatch";

export async function checkProviderKeyHealth(name: ProviderName): Promise<ProviderKeyHealth> {
  if (!deps) {
    throw new Error("provider-resolver not configured — call configureProviderResolver() at boot");
  }
  const encrypted = await loadEncryptedKeyFromDb(deps, name);
  if (encrypted) {
    try {
      await decryptSecret({
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        kekFingerprint: encrypted.kekFingerprint,
      });
      return "ok";
    } catch {
      return "unreadable_kek_mismatch";
    }
  }
  if (process.env[envNameFor(name)]) return "env_only";
  return "no_key";
}

export async function getActiveProvider(): Promise<ResolvedProvider | null> {
  if (!deps) return null;
  const meta = await loadActiveProviderMeta(deps);
  if (!meta) {
    // No active row at all — fall back to anthropic env-var as the
    // only legacy single-provider path Compose installs relied on.
    const envKey = process.env[envNameFor("anthropic")];
    if (!envKey) return null;
    return resolveProvider("anthropic", { model: DEFAULT_MODEL.anthropic });
  }
  return resolveProvider(meta.name, {
    model: meta.model,
    ...(meta.baseUrl ? { baseUrl: meta.baseUrl } : {}),
    ...(meta.maxOutputTokens !== undefined ? { maxOutputTokens: meta.maxOutputTokens } : {}),
  });
}

/**
 * Get a specific provider by name (used when callers need a named
 * provider regardless of the active row, e.g. tests).
 */
export async function getProviderByName(name: ProviderName): Promise<ResolvedProvider | null> {
  if (!deps) return null;
  const meta = await loadProviderMeta(deps, name);
  const effective = meta ?? { model: DEFAULT_MODEL[name] };
  return resolveProvider(name, effective);
}

/** Test/debug helper — exposed names. */
export function knownProviderNames(): ReadonlyArray<ProviderName> {
  return PROVIDER_NAMES;
}

// ---------------------------------------------------------------------
// issue #306 — tier-model resolution support
// ---------------------------------------------------------------------

/**
 * Raw `config.modelTiers` from the ACTIVE provider row (undefined when
 * absent or no active row). Callers validate via `parseModelTierMap`
 * (model-tiers.ts) so malformed config fails loudly at the spawn
 * surface, not silently here.
 */
export async function getActiveModelTiersRaw(): Promise<unknown> {
  if (!deps) {
    throw new Error("provider-resolver not configured — call configureProviderResolver() at boot");
  }
  const meta = await loadActiveProviderMeta(deps);
  return meta?.modelTiersRaw;
}

/**
 * issue #306 — per-(name,model) cache for tier-resolved providers.
 * Separate from the per-name `cache` on purpose: writing a tier provider
 * into the per-name slot would evict the parent chat's resolved entry on
 * every spawn and thrash the 60s TTL.
 */
const tierCache = new Map<string, CacheEntry>();

/**
 * Resolve the ACTIVE provider but with `modelId` in place of the row's
 * configured chat model — the tier-routing path for subagent children
 * (issue #306). Same key + baseUrl + maxOutputTokens as the active row;
 * only the model differs, so `ai_calls` rows and `ai_pricing` lookups
 * (both keyed on provider+model) attribute the child's spend correctly
 * with zero extra work.
 *
 * Returns null when no active provider row exists or no key resolves —
 * the same "AI provider not configured" surface as `getActiveProvider`.
 */
export async function getActiveProviderForModel(modelId: string): Promise<ResolvedProvider | null> {
  if (!deps) {
    throw new Error("provider-resolver not configured — call configureProviderResolver() at boot");
  }
  const meta = await loadActiveProviderMeta(deps);
  // No active row: tier mapping lives ON the active row, so there is
  // nothing to route to — the env-only legacy fallback deliberately does
  // not apply here (it has no config to carry a tier map).
  if (!meta) return null;
  const cacheKey = `${meta.name}::${modelId}`;
  const now = Date.now();
  const cached = tierCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.resolved;

  const key = await loadApiKey(deps, meta.name);
  if (!key) return null;
  const provider = makeProvider({
    name: meta.name,
    model: modelId,
    apiKey: key.apiKey,
    ...(meta.baseUrl ? { baseUrl: meta.baseUrl } : {}),
  });
  const resolved: ResolvedProvider = {
    provider,
    source: key.source,
    providerName: meta.name,
    model: modelId,
    keyFingerprint: await fingerprintKey(key.apiKey),
    ...(meta.maxOutputTokens !== undefined ? { maxOutputTokens: meta.maxOutputTokens } : {}),
  };
  tierCache.set(cacheKey, { resolved, expiresAt: now + TTL_MS });
  return resolved;
}
