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
  anthropic: "claude-opus-4-7",
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
}

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
}

/**
 * Drop a cached provider so the next `getActiveProvider` / `getProviderByName`
 * call re-reads from the DB. Called by `ai_providers.set` / `clear_key`
 * via in-process pg_notify (commit 2 emits the notify; commit 3 wires the
 * subscriber inside this resolver via a periodic poll for now —
 * cross-process LISTEN ships as a P18 follow-up).
 */
export function invalidateProviderCache(name?: ProviderName): void {
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
  const cached = cache.get(name);
  const now = Date.now();
  if (
    cached &&
    cached.expiresAt > now &&
    cached.resolved.model === meta.model &&
    cached.resolved.maxOutputTokens === meta.maxOutputTokens
  ) {
    return cached.resolved;
  }

  // Try DB-stored encrypted key first.
  let apiKey: string | null = null;
  let source: "db" | "env" = "env";
  const encrypted = await loadEncryptedKeyFromDb(deps, name);
  if (encrypted) {
    apiKey = await decryptSecret({
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      kekFingerprint: encrypted.kekFingerprint,
    });
    source = "db";
  } else {
    // Env fallback.
    const envKey = process.env[envNameFor(name)];
    if (envKey) {
      apiKey = envKey;
      source = "env";
    }
  }

  if (!apiKey) return null;

  const provider = makeProvider({
    name,
    model: meta.model,
    apiKey,
    ...(meta.baseUrl ? { baseUrl: meta.baseUrl } : {}),
  });
  const keyFingerprint = await fingerprintKey(apiKey);
  const resolved: ResolvedProvider = {
    provider,
    source,
    providerName: name,
    model: meta.model,
    keyFingerprint,
    ...(meta.maxOutputTokens !== undefined ? { maxOutputTokens: meta.maxOutputTokens } : {}),
  };
  cache.set(name, { resolved, expiresAt: now + TTL_MS });
  return resolved;
}

/**
 * Get the currently-active provider (the one with `is_active = true`).
 * Returns null when no provider is configured anywhere — chat / translation
 * / plugin host all surface this as "configure your AI provider."
 */
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
