// SPDX-License-Identifier: MPL-2.0

// v0.5.9 — process-level handlers. Catches every async-leaked rejection
// and uncaught exception that would otherwise vanish into Bun's default
// (kill the process on uncaughtException; silently drop unhandledRejection
// in some configurations). Logs to stderr with a distinctive prefix so
// Cloud Run captures it and operators can grep one identifier across
// otherwise-invisible failures. Does NOT call process.exit — the runtime
// stays up; we just want visibility.
process.on("unhandledRejection", (reason, p) => {
  console.error("[unhandled.rejection]", { reason, promise: String(p) });
});
process.on("uncaughtException", (e) => {
  console.error("[uncaught.exception]", e);
});

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  type AIProvider as AdminAIProvider,
  buildEmailTransport,
  configureMcpBridge,
  configureProviderResolver,
  type EmailConfigRow,
  emitSnapshot,
  generateKekHex,
  getActiveProvider,
  getMediaStorage,
  resetStuckTranslationUnits,
  setMode2Provider,
  setTranslationProvider,
  startProposalGcWorker,
  startReleaseCheckWorker,
  startTranslationWorker,
} from "@caelo-cms/admin-core";
import authPluginDefinition from "@caelo-cms/plugin-auth";
import commentsPluginDefinition from "@caelo-cms/plugin-comments";
import formsPluginDefinition from "@caelo-cms/plugin-forms";
import {
  bootstrap as bootstrapPluginHost,
  type AIProvider as PluginHostAIProvider,
  type SnapshotEmitter,
} from "@caelo-cms/plugin-host";
import newsletterPluginDefinition from "@caelo-cms/plugin-newsletter";
import ratingsPluginDefinition from "@caelo-cms/plugin-ratings";
import translationPluginDefinition from "@caelo-cms/plugin-translation";
import { execute } from "@caelo-cms/query-api";
import { startRedeployOrchestrator } from "@caelo-cms/redeploy-orchestrator";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { Handle } from "@sveltejs/kit";
import { SESSION_COOKIE } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";

// Dev-mode KEK auto-gen. secret-box reads CAELO_SECRET_KEK lazily
// (only at first encrypt/decrypt), so populating it before any DB
// op is enough. Production installs receive it from Secret Manager /
// Compose `.env` and skip the auto-gen. Dev installs persist a
// generated KEK to `.caelo/dev-kek` (gitignored, mode 600) so it
// stays stable across `bun run dev` restarts — important so existing
// encrypted rows in the dev DB stay decryptable.
if (!process.env.CAELO_SECRET_KEK && process.env.NODE_ENV !== "production") {
  const devDir = resolvePath(process.cwd(), ".caelo");
  const devFile = resolvePath(devDir, "dev-kek");
  // Read-or-generate without an existsSync pre-check: the gap between the
  // check and the read/write is a TOCTOU race against a parallel boot
  // (CodeQL js/file-system-race). A failed read means "not there yet" →
  // generate and persist.
  let hex: string;
  try {
    hex = readFileSync(devFile, "utf8").trim();
  } catch {
    hex = generateKekHex();
    mkdirSync(devDir, { recursive: true });
    writeFileSync(devFile, hex, { mode: 0o600 });
    console.log(`[hooks] generated dev KEK → ${devFile}`);
  }
  process.env.CAELO_SECRET_KEK = hex;
}

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "hooks",
};

// P10 / P18 — one-time translation worker bootstrap. Runs at module
// load (i.e. once when SvelteKit boots). The worker polls for queued
// translation_job_units and dispatches Mode 1 / Mode 2 sequentially,
// resolving the AIProvider per unit via the ProviderResolver so a
// freshly-saved key picks up without a restart. When no provider is
// configured anywhere (DB or env), individual units fail with
// "AI provider not configured — visit /security/ai" — the dashboard
// surfaces it; the worker stays running.
let translationBootstrapped = false;
async function bootstrapTranslationWorker(): Promise<void> {
  if (translationBootstrapped) return;
  translationBootstrapped = true;
  // Resolver returns null → setTranslationProvider's resolver wrapper
  // throws "AI provider not configured" inside the unit handler.
  const resolveProvider = async (): Promise<{ provider: AdminAIProvider } | null> => {
    const r = await getActiveProvider();
    return r ? { provider: r.provider } : null;
  };
  setTranslationProvider({ resolveProvider });
  setMode2Provider({ resolveProvider });
  const { adapter, registry } = getQueryContext();
  await resetStuckTranslationUnits({ adapter, registry, systemCtx: SYSTEM_CTX });
  startTranslationWorker({ adapter, registry, systemCtx: SYSTEM_CTX });
}

// P11.5 audit fix #3 + P18 — adapter from admin-core's event-streaming
// AIProvider to plugin-host's single-shot complete() shape. Drains the
// stream, accumulates text + usage, returns a flat result. Costs of
// plugin AI calls flow through the standard ai_calls accounting via
// the plugin's actor row (caelo.actor_id) in upstream call sites.
//
// Resolves the provider per-call via getActiveProvider() so plugins
// pick up a freshly-saved key without a restart. When no provider is
// configured, complete() throws — plugin host surfaces this in the
// plugin's error log (the plugin author can choose to surface it
// further or fail soft).
function makePluginHostAiProvider(): PluginHostAIProvider {
  return {
    complete: async (opts) => {
      const resolved = await getActiveProvider();
      if (!resolved) {
        throw new Error("AI provider not configured — Owner must visit /security/ai");
      }
      const provider = resolved.provider;
      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      const stream = provider.generate({
        systemPrompt: opts.system,
        messages: opts.messages,
        tools: [],
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
      });
      for await (const event of stream) {
        if (event.kind === "text-delta") text += event.text;
        else if (event.kind === "usage") {
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
        } else if (event.kind === "error") {
          throw new Error(`provider error: ${event.message}`);
        }
      }
      return { text, inputTokens, outputTokens };
    },
  };
}

// P11.5 commit 2 — bootstrap the Tier-1 plugin host.
//
// P12 review-pass: on-disk loading is now wired (loader reads
// `packages/plugins/<slug>/manifest.json` + `manifest.sig`, verifies via the
// embedded Caelo public key OR `CAELO_TIER1_PUBLIC_KEY` env override). For
// dev iteration we still default to testPlugins mode (no disk hop, instant
// reload via `bun --bun vite dev`); set `CAELO_USE_DISK_PLUGINS=1` to switch
// to the disk-loader path. Production builds run the disk loader.
let pluginHostBootstrapped = false;
async function bootstrapPlugins(): Promise<void> {
  if (pluginHostBootstrapped) return;
  pluginHostBootstrapped = true;
  const { adapter, registry } = getQueryContext();
  // P11.5 audit fix #3 — wire emitSnapshot + aiProvider so plugins that
  // declare those capabilities get working handles. Plugin's
  // requestedCapabilities still gates which handles are actually attached
  // per-call; this just supplies the implementations.
  // P18 — provider is resolved per-call via getActiveProvider(); the
  // wrapper below throws when nothing is configured so plugin authors
  // can decide whether to surface or fail soft.
  const aiProvider: PluginHostAIProvider | undefined = makePluginHostAiProvider();
  // The plugin-host's SnapshotEmitter type is a structural subset of
  // admin-core's `SnapshotInput`. Both expect the same fields; the cast
  // makes the structural compat explicit (TS doesn't relate the two
  // ReadonlyArray<{kind: string, ...}> shapes nominally).
  const emitter = emitSnapshot as unknown as SnapshotEmitter;
  // P12 review pass — read email_config and construct the transport.
  // The plugin host's ctx.email.send falls back to a stderr stub when
  // no transport is wired, so this is best-effort: a missing/broken
  // config never blocks plugin host startup.
  let emailTransport: ReturnType<typeof buildEmailTransport> | undefined;
  try {
    const r = await execute(registry, adapter, SYSTEM_CTX, "email_config.get", {});
    if (r.ok) {
      const cfg = (r.value as { config: EmailConfigRow }).config;
      emailTransport = buildEmailTransport(cfg);
    }
  } catch {
    // best-effort; ctx.email.send falls back to stderr stub
  }
  const useDisk = process.env.CAELO_USE_DISK_PLUGINS === "1";
  // P12 review-pass #3 — startup warning if any active plugin
  // declared `email` capability but no transport is configured. These
  // sends will fall through to the stderr stub silently otherwise.
  if (!emailTransport) {
    const emailUsers = [
      newsletterPluginDefinition,
      authPluginDefinition,
      formsPluginDefinition,
    ].filter((p) => p.requestedCapabilities?.includes("email"));
    if (emailUsers.length > 0) {
      console.warn(
        `[hooks] email transport NOT configured — ${emailUsers.map((p) => p.slug).join(", ")} will log sends to stderr only. Configure at /security/email.`,
      );
    }
  }
  await bootstrapPluginHost({
    infra: {
      adapter,
      registry,
      aiProvider,
      emitSnapshot: emitter,
      emailTransport,
    },
    // Disk path requires `bun run plugins:sign` to have produced
    // manifest.json + manifest.sig in each plugin dir, AND
    // CAELO_TIER1_PUBLIC_KEY env to match the dev key (or the embedded
    // production key when shipped).
    pluginsRoot: useDisk
      ? new URL("../../../packages/plugins", import.meta.url).pathname
      : "/dev/null/unused",
    systemActorId: SYSTEM_CTX.actorId,
    testPlugins: useDisk
      ? undefined
      : [
          { definition: translationPluginDefinition },
          { definition: formsPluginDefinition },
          { definition: ratingsPluginDefinition },
          { definition: newsletterPluginDefinition },
          { definition: commentsPluginDefinition },
          { definition: authPluginDefinition },
        ],
  });
}

// P14 — pending bootstrap token uptake. cms-provision init writes
// `.caelo/pending-token.json` (alongside the docker-compose); on first
// admin boot we INSERT the row via owner_bootstrap_tokens.insert and
// delete the staging file so a redeploy doesn't double-insert. Failure
// is non-fatal: a missing/corrupt file just leaves /setup in dev-mode
// (no token required).
let pendingTokenInserted = false;
async function consumePendingBootstrapToken(): Promise<void> {
  if (pendingTokenInserted) return;
  pendingTokenInserted = true;
  // Resolve relative to repo root for dev; in the production container
  // the volume bind mounts `.caelo/` to `/app/.caelo/` so `process.cwd()`
  // points at the right place either way.
  const candidates = [
    resolvePath(process.cwd(), ".caelo/pending-token.json"),
    resolvePath(process.cwd(), "../../.caelo/pending-token.json"),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { token: string; expiresAt: string };
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, SYSTEM_CTX, "owner_bootstrap_tokens.insert", {
      token: raw.token,
      expiresAt: raw.expiresAt,
    });
    if (r.ok) {
      unlinkSync(path);
      console.log(`[hooks] inserted pending bootstrap token from ${path}`);
    }
  } catch (e) {
    console.warn(`[hooks] failed to consume ${path}:`, e);
  }
}

// P13 — debounced auto-redeploy + gateway log GC. Polls audit_events
// for "publishable" op kinds (driven by site_settings.auto_redeploy_*)
// and fires deploy.trigger after `auto_redeploy_debounce_ms` of quiet.
// Off by default; Owner toggles at /security/gateway.
let redeployBootstrapped = false;
function bootstrapRedeploy(): void {
  if (redeployBootstrapped) return;
  redeployBootstrapped = true;
  const { adapter, registry } = getQueryContext();
  // issue #198 — hand the importer worker the media storage so crawl
  // screenshots persist (review side-by-sides + parity references).
  startRedeployOrchestrator({ adapter, registry, screenshotStorage: getMediaStorage() });
}

// P21 ship 5 — release-check sidecar. Polls GitHub Releases once
// per hour and writes to release_check_cache; notifications.aggregate
// reads the cached row instead of doing the network call inside its
// own transaction.
let releaseCheckBootstrapped = false;
function bootstrapReleaseCheck(): void {
  if (releaseCheckBootstrapped) return;
  releaseCheckBootstrapped = true;
  const { adapter } = getQueryContext();
  startReleaseCheckWorker({ adapter });
}

// v0.2.37 — proposal GC sidecar. Sweeps pending rows older than 30
// days → 'superseded' once per day across all *_pending_actions
// tables. Keeps the bell badge meaningful.
let proposalGcBootstrapped = false;
function bootstrapProposalGc(): void {
  if (proposalGcBootstrapped) return;
  proposalGcBootstrapped = true;
  const { adapter } = getQueryContext();
  startProposalGcWorker({ adapter });
}

// P17 PR4 + P18 — wire the MCP bridge to the ProviderResolver so
// external `bunx @caelo-cms/mcp-server` callers can drive the
// chat-runner. resolveProvider returns null when no key is wired
// anywhere; mcp.send_chat surfaces a structured error pointing at
// /security/ai instead of crashing.
let mcpBridgeBootstrapped = false;
function bootstrapMcpBridge(): void {
  if (mcpBridgeBootstrapped) return;
  mcpBridgeBootstrapped = true;
  const { adapter, registry } = getQueryContext();
  configureMcpBridge({
    adapter,
    registry,
    resolveProvider: async () => {
      const r = await getActiveProvider();
      return r ? r.provider : null;
    },
  });
}

/**
 * Per-request middleware: resolve session cookie → populate `locals.user` +
 * `locals.ctx`. The `csrfSecret` field is the long-lived per-session secret —
 * forms use a derived per-render token via `signCsrfToken`.
 */
// P18 — wire ProviderResolver before any other bootstrap step that
// might call getActiveProvider(). Idempotent: configureProviderResolver
// just resets cache + dep slot.
let providerResolverConfigured = false;
function ensureProviderResolverConfigured(): void {
  if (providerResolverConfigured) return;
  providerResolverConfigured = true;
  const { adapter, registry } = getQueryContext();
  configureProviderResolver({ adapter, registry });
}

export const handle: Handle = async ({ event, resolve }) => {
  ensureProviderResolverConfigured();
  // v0.5.9 — fire-and-forget bootstraps had `void` prefixes that
  // swallowed their rejections. Replace with .catch() so background
  // task failures (translation worker crash, plugin manifest invalid,
  // bootstrap token DB write) land in Cloud Run stderr instead of
  // disappearing into the void.
  bootstrapTranslationWorker().catch((e) => console.error("[bootstrap.translation] failed", e));
  bootstrapRedeploy();
  bootstrapReleaseCheck();
  bootstrapProposalGc();
  bootstrapMcpBridge();
  bootstrapPlugins().catch((e) => console.error("[bootstrap.plugins] failed", e));
  consumePendingBootstrapToken().catch((e) => console.error("[bootstrap.token] failed", e));
  const { adapter, registry } = getQueryContext();
  const token = event.cookies.get(SESSION_COOKIE);
  let user: App.Locals["user"] = null;

  // P16 — one request-id per HTTP request, threaded through every Query API
  // call AND echoed back as `X-Caelo-Request-Id`. Lets operators grep one
  // identifier across structured-log lines, audit_events, ai_calls, and the
  // browser network tab. Honours an upstream `x-request-id` (Caddy / gateway
  // can inject one for cross-service tracing).
  const requestId = event.request.headers.get("x-request-id") ?? crypto.randomUUID();

  if (token) {
    const requestCtx: ExecutionContext = { ...SYSTEM_CTX, requestId };
    const result = await execute(registry, adapter, requestCtx, "auth.resolve_session", { token });
    if (result.ok) {
      const v = result.value as {
        userId: string;
        email: string;
        csrfToken: string;
        permissions: string[];
        roles: string[];
        onboardedAt: string | null;
      };
      user = {
        id: v.userId,
        email: v.email,
        roles: v.roles,
        permissions: new Set(v.permissions),
        csrfSecret: v.csrfToken, // op output is the long-lived secret
        onboardedAt: v.onboardedAt,
      };
    } else {
      event.cookies.delete(SESSION_COOKIE, { path: "/" });
    }
  }

  event.locals.user = user;
  event.locals.ctx = user
    ? { actorId: user.id, actorKind: "human", requestId }
    : { ...SYSTEM_CTX, requestId };

  const response = await resolve(event);
  // Echo the correlation id so client errors can be cross-referenced with
  // server logs without operator guesswork.
  response.headers.set("X-Caelo-Request-Id", requestId);

  // P6.7.5 — fallback redirect lookup on a 404. In production Caddy
  // serves redirects from `_redirects.caddy`; the admin / smoke server
  // consults the `redirects` table directly so dev paths and tests see
  // the same behaviour without Caddy in front. We only check on 404 to
  // keep the happy path single-query.
  if (response.status === 404 && event.request.method === "GET") {
    try {
      const lookup = await execute(registry, adapter, SYSTEM_CTX, "redirects.lookup", {
        fromPath: event.url.pathname,
      });
      if (lookup.ok) {
        const m = (
          lookup.value as {
            match: { toPath: string; statusCode: number } | null;
          }
        ).match;
        if (m) {
          return new Response(null, {
            status: m.statusCode,
            headers: { Location: m.toPath },
          });
        }
      }
    } catch {
      // best-effort; never let a redirect lookup fail the original 404.
    }
  }

  return response;
};
