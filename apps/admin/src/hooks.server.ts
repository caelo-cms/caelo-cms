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
// adapter-node answers SIGTERM/SIGINT by closing the HTTP server, letting
// in-flight requests finish, then emitting `sveltekit:shutdown` and waiting
// for the event loop to drain. Ours never drains: the bootstrapped workers
// below (redeploy, GC sweeps, release check, plugin host) poll on timers and
// hold pg pools. Without this exit, Cloud Run and `docker stop` fall back to
// SIGKILL after their grace period. The workers keep no in-memory state the
// database does not already hold, so exiting once requests are done is safe.
process.on("sveltekit:shutdown", (reason: string) => {
  console.error(`[shutdown] ${reason}: HTTP server drained, exiting`);
  process.exit(0);
});

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve as resolvePath } from "node:path";
import {
  assertDurableMediaRoot,
  BugIntakeClient,
  bugIntakeUrl,
  buildEmailTransport,
  configureMcpBridge,
  configurePluginUninstallFinalizer,
  configureProviderResolver,
  type EmailConfigRow,
  emitSnapshot,
  generateKekHex,
  getActiveProvider,
  getMediaStorage,
  lockPluginRow,
  makePluginImageProvider,
  makePluginTextProvider,
  startAutoUpdateScheduler,
  startBugForwardingWorker,
  startChatImageGcWorker,
  startDomainEventGcWorker,
  startProposalGcWorker,
  startPublicProjectionPublisher,
  startQualityAuditWorker,
  startReleaseCheckWorker,
  transformPluginImage,
} from "@caelo-cms/admin-core";
import {
  bootstrap as bootstrapPluginHost,
  ensureDevSignedManifests,
  loadedPlugins,
  type AIProvider as PluginHostAIProvider,
  type SnapshotEmitter,
  syncPluginHost,
} from "@caelo-cms/plugin-host";
import { execute } from "@caelo-cms/query-api";
import { startRedeployOrchestrator } from "@caelo-cms/redeploy-orchestrator";
import {
  type ExecutionContext,
  type PlatformUpdateAgentStatus,
  redirectTargetIssue,
} from "@caelo-cms/shared";
import type { Handle, ServerInit } from "@sveltejs/kit/hooks";
import { legacySecurityRedirect } from "#lib/legacy-security-redirect.js";
import { bootstrapE2eOperatorAccess } from "#lib/server/google-iap.js";
import { SESSION_COOKIE } from "#lib/server/guards.js";
import { getQueryContext, mediaStorageSetup } from "#lib/server/query.js";
import { releaseManifestReader } from "#lib/server/release-check.js";
import { convergeTrigger, upgraderTrigger } from "#lib/server/upgrader.js";
import { updatesProvider } from "#lib/upgrade-path.js";

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

// P11.5 commit 2 — bootstrap the Tier-1 plugin host.
//
// #387 one-trust-path: the admin host ALWAYS loads plugins from disk
// through the full verify pipeline (manifest parse → Ed25519 signature →
// validator → import). The old testPlugins default that skipped
// signature + validator is gone. Dev convenience is auto-signing, not
// skipped verification: on a non-production boot, stale/missing
// manifest.json + manifest.sig are regenerated from each plugin's built
// dist with the repo-local `.caelo-dev-key`, and the loader verifies
// against that key via the `.tier1-trust-root` drop file. Production
// images sign at image-build time (same mechanism, throwaway build key;
// image provenance is cosign's job).
let pluginHostBoot: Promise<void> | null = null;

/** Walk up from cwd to the directory containing `packages/plugins`.
 *  Throws (no-fallbacks) when the workspace shape isn't found. */
function findWorkspaceRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolvePath(dir, "packages", "plugins"))) return dir;
    const parent = resolvePath(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `plugin host: could not locate packages/plugins walking up from ${process.cwd()} — set CAELO_PLUGINS_ROOT`,
  );
}

/**
 * The plugin host boot, started once and shared: every request waits for
 * it (#1008) so none renders, dispatches or passes the Publish-live gate on
 * empty registries during a cold start.
 */
function bootstrapPlugins(): Promise<void> {
  if (!pluginHostBoot) pluginHostBoot = bootPluginHost();
  return pluginHostBoot;
}

async function bootPluginHost(): Promise<void> {
  const { adapter, registry } = getQueryContext();
  // P11.5 audit fix #3 — wire emitSnapshot + aiProvider so plugins that
  // declare those capabilities get working handles. Plugin's
  // requestedCapabilities still gates which handles are actually attached
  // per-call; this just supplies the implementations.
  // P18 + #593 — the provider is resolved per call, by the call's declared
  // purpose (translation → the Owner's translation model, else the chat
  // model); it throws when nothing is configured so plugin authors can
  // decide whether to surface or fail soft.
  const aiProvider: PluginHostAIProvider | undefined = makePluginTextProvider();
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
  // Resolve packages/plugins by walking up from cwd — import.meta.url
  // is useless here because the built SvelteKit output relocates this
  // module to build/server/chunks/, while dev serves it from src/.
  // Both the dev server (cwd=apps/admin) and the runtime image
  // (WORKDIR /app/apps/admin) sit two levels below the workspace root.
  const workspaceRoot = findWorkspaceRoot();
  const pluginsRoot = process.env.CAELO_PLUGINS_ROOT ?? `${workspaceRoot}/packages/plugins`;
  if (process.env.NODE_ENV !== "production") {
    const signed = await ensureDevSignedManifests({
      pluginsRoot,
      keyPath: `${workspaceRoot}/.caelo-dev-key`,
    });
    for (const r of signed.reports) {
      if (r.status === "failed" || r.status === "skipped") {
        console.warn(`[hooks] plugin dev-sign ${r.status}: ${r.slug} — ${r.reason}`);
      }
    }
  }
  // #393 — the uninstall op's schema drops run through these hooks
  // (DDL on both pools lives with the adapter, not the ops layer).
  configurePluginUninstallFinalizer({
    dropPublicSchema: (schemaName) => adapter.dropPluginPublicSchema({ schemaName }),
    dropAdminSchema: (schemaName) => adapter.dropPluginAdminSchema({ schemaName }),
  });
  const report = await bootstrapPluginHost({
    infra: {
      adapter,
      registry,
      aiProvider,
      imageTransform: transformPluginImage,
      imageProvider: makePluginImageProvider({ adapter, registry }),
      // #530 — originals of site media for plugins granted site_media_read.
      siteMediaBytes: (storageKey: string) => getMediaStorage().get(storageKey),
      emitSnapshot: emitter,
      emailTransport,
      lockPluginRow,
    },
    pluginsRoot,
    systemActorId: SYSTEM_CTX.actorId,
  });
  // #387 — a discarded LoadReport made plugin failures invisible; every
  // failed plugin is an operator-relevant event, so log loudly.
  console.log(
    `[hooks] plugin host: ${report.loaded.length} loaded${report.loaded.length > 0 ? ` (${report.loaded.map((l) => l.slug).join(", ")})` : ""}`,
  );
  // Installed but not running. Logged at the same volume as loaded ones
  // so "why is my plugin doing nothing" is answered by the boot log
  // rather than by reading the plugins table.
  if (report.inactive.length > 0) {
    console.log(
      `[hooks] plugin host: ${report.inactive.length} installed, awaiting Owner activation at /settings/plugins (${report.inactive
        .map((p) => `${p.slug}:${p.status}`)
        .join(", ")})`,
    );
  }
  for (const f of report.failed) {
    console.error(`[hooks] plugin FAILED to load: ${f.slug} — ${f.reason}`);
  }
  // #635 — the gateway has no cms_admin login: publish what it serves from
  // into cms_public now that the plugins (and their projection triggers)
  // are in place, then keep it current from the outbox.
  const publisher = startPublicProjectionPublisher({ adapter });
  await publisher.publishAll();
  // #724 rollout E — after the plugin host, so plugins' link hooks take
  // part, and after the gateway projection, which must not wait on a
  // site-wide content conversion (nor on the editor rows it locks).
  await migrateLinksOnce();
  // P12 review-pass #3 — startup warning if any loaded plugin declared
  // the `email` capability but no transport is configured. These sends
  // would fall through to the stderr stub silently otherwise.
  if (!emailTransport) {
    const emailUsers = loadedPlugins
      .all()
      .filter((p) => p.definition.requestedCapabilities?.includes("email"));
    if (emailUsers.length > 0) {
      console.warn(
        `[hooks] email transport NOT configured — ${emailUsers.map((p) => p.slug).join(", ")} will log sends to stderr only. Configure at /settings/email.`,
      );
    }
  }
}

// Epic #724 rollout E — the one-time data migration that turns existing
// literal internal links (`/about`) into page references. It is a Query
// API op, not a SQL migration: the conversion needs the canonicaliser and
// the site's page lookup. Runs once per install (the op skips when an
// applied run exists, under an advisory lock so two booting instances do
// not both convert); a failure is logged loudly, leaves the links as they
// are, and is retried at the next start. The Owner sees the report and
// can re-run or revert it at Settings → Internal links.
async function migrateLinksOnce(): Promise<void> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, SYSTEM_CTX, "links.migrate_to_references", {
    trigger: "boot",
    onlyIfNeverApplied: true,
  });
  if (!r.ok) {
    console.error(
      "[bootstrap.link_migration] FAILED — stored internal links stay literal until it succeeds (retried at the next start; Settings → Internal links runs it by hand)",
      r.error,
    );
    return;
  }
  const v = r.value as {
    skipped: boolean;
    run: { runId: string; counts: Record<string, number>; unresolvedCount: number } | null;
  };
  if (v.skipped || !v.run) return;
  const converted = Object.values(v.run.counts).reduce((a, b) => a + b, 0);
  console.log(
    `[bootstrap.link_migration] ${converted} internal link(s) stored as references; ${v.run.unresolvedCount} could not be converted (report: Settings → Internal links, run ${v.run.runId})`,
  );
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

// #650 — seed staging_access.staging_host from CAELO_STAGING_HOST, which
// provisioning sets from the install's staging host setting (the wizard's
// answer, default staging.<domain>; `upgrade` defaults installs that
// predate it). Fills an unset value only, so an Owner's later change in
// Settings → Domains is never overwritten. Same memoised shape as the
// site base URL seed below.
let stagingHostSeed: Promise<void> | null = null;
function seedStagingHost(): Promise<void> {
  if (stagingHostSeed) return stagingHostSeed;
  stagingHostSeed = (async () => {
    const host = process.env.CAELO_STAGING_HOST?.trim();
    if (!host) return;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, SYSTEM_CTX, "staging_access.seed_host", { host });
    if (!r.ok) {
      // A rejected host (not an FQDN, the live or admin host) is permanent
      // until provisioning changes it; anything else is retried.
      if (r.error.kind === "ValidationFailed" || r.error.kind === "HandlerError") {
        console.error("[bootstrap.staging_host] CAELO_STAGING_HOST rejected", r.error);
        return;
      }
      throw new Error(`seed_host failed: ${JSON.stringify(r.error)}`);
    }
    if ((r.value as { seeded: boolean }).seeded) {
      console.log(`[bootstrap.staging_host] staging host set to ${host}`);
    }
  })().catch((e) => {
    console.error("[bootstrap.staging_host] failed", e);
    stagingHostSeed = null;
  });
  return stagingHostSeed;
}

// #551 — seed site_defaults.site_base_url from CAELO_SITE_URL, which
// provisioning sets to https://<install domain>. Fills an unset value only
// (the op never overwrites), so it covers fresh installs and upgrades of
// installs that never configured it, without touching an Owner's choice.
// Awaited by the first request(s) so a deploy can never race the seed;
// memoised so it runs once per process (retried after a transient failure).
let siteBaseUrlSeed: Promise<void> | null = null;
function seedSiteBaseUrl(): Promise<void> {
  if (siteBaseUrlSeed) return siteBaseUrlSeed;
  siteBaseUrlSeed = (async () => {
    const url = process.env.CAELO_SITE_URL?.trim();
    if (!url) return;
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, SYSTEM_CTX, "site_defaults.seed_site_base_url", {
      siteBaseUrl: url,
      source: "CAELO_SITE_URL",
    });
    if (!r.ok) {
      // A malformed CAELO_SITE_URL is permanent; anything else (database
      // not reachable yet, …) is retried by the next request.
      if (r.error.kind === "ValidationFailed") {
        console.error("[bootstrap.site_base_url] CAELO_SITE_URL rejected", r.error);
        return;
      }
      throw new Error(`seed_site_base_url failed: ${JSON.stringify(r.error)}`);
    }
    if ((r.value as { seeded: boolean }).seeded) {
      console.log(`[bootstrap.site_base_url] site base URL set to ${url}`);
    }
  })().catch((e) => {
    console.error("[bootstrap.site_base_url] failed", e);
    siteBaseUrlSeed = null;
  });
  return siteBaseUrlSeed;
}

// #553 — quality-audit worker. Lighthouse runs against the staged build
// after a substantial Stage; the worker claims queued audit runs (written by
// the Stage flow's quality_audits.enqueue) and records the results. Runs
// the audit itself in a child process, so this process only waits on it.
let qualityAuditBootstrapped = false;
function bootstrapQualityAudits(): void {
  if (qualityAuditBootstrapped) return;
  qualityAuditBootstrapped = true;
  const { adapter, registry } = getQueryContext();
  startQualityAuditWorker({ adapter, registry });
}

// Epic #901 — sends AI bug reports to the Caelo bug intake once the Owner
// opted in on /settings/bugs. Idle (one cheap read per minute) while off.
// CAELO_BUG_INTAKE_URL points a fork or a test run at another intake.
let bugForwardingBootstrapped = false;
function bootstrapBugForwarding(): void {
  if (bugForwardingBootstrapped) return;
  bugForwardingBootstrapped = true;
  const { adapter, registry } = getQueryContext();
  startBugForwardingWorker({
    adapter,
    registry,
    client: new BugIntakeClient({ baseUrl: bugIntakeUrl(process.env) }),
  });
}

// P13 — debounced auto-redeploy + gateway log GC. Polls audit_events
// for "publishable" op kinds (driven by site_settings.auto_redeploy_*)
// and fires deploy.trigger after `auto_redeploy_debounce_ms` of quiet.
// Off by default; Owner toggles at /settings/gateway.
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
  // #696 — `off` for test runs: the Playwright suite seeds
  // release_check_cache itself, and a poll racing it would overwrite the
  // seeded release with whatever GitHub says (and spend the CI runner's
  // unauthenticated GitHub API quota).
  if (process.env.CAELO_RELEASE_CHECK === "off") return;
  const { adapter } = getQueryContext();
  // The worker also reads the release's manifest for its route (#817).
  startReleaseCheckWorker({
    adapter,
    readManifest: releaseManifestReader(),
    provider: updatesProvider(process.env),
  });
}

// #696 Phase 5 — automatic Caelo updates. Every admin instance runs the
// loop; a lease in the database makes one decision per interval, and the
// request it queues is the same row "Install update" writes (the upgrader
// job / self-hosted agent pick it up and verify the signed manifest).
// `off` for test runs: the Playwright suite seeds release_check_cache and
// drives the page itself; a live tick would read the real registry and
// write emails into the suite's database.
let autoUpdateBootstrapped = false;
function bootstrapAutoUpdates(): void {
  if (autoUpdateBootstrapped) return;
  autoUpdateBootstrapped = true;
  if (process.env.CAELO_UPDATE_SCHEDULER === "off") return;
  const { adapter, registry } = getQueryContext();
  // Same upgrader the Owner's "Install update" uses: the Cloud Run job, or
  // on self-hosted the update agent (read through its heartbeat op).
  const readAgent = async (): Promise<PlatformUpdateAgentStatus | null> => {
    const r = await execute(registry, adapter, SYSTEM_CTX, "platform_updates.agent_status", {});
    if (!r.ok) throw new Error(`platform_updates.agent_status: ${JSON.stringify(r.error)}`);
    return (r.value as { agent: PlatformUpdateAgentStatus | null }).agent;
  };
  startAutoUpdateScheduler({
    adapter,
    registry,
    upgrader: () => upgraderTrigger(process.env, readAgent),
    // #819 — releases that change the cloud setup, when autoConverge allows.
    converge: () => convergeTrigger(process.env),
    readManifest: releaseManifestReader(),
    provider: updatesProvider(process.env),
    holder: `${process.env.K_REVISION ?? hostname()}/${process.pid}`,
  });
}

// #817 — once per process: an upgrade the Owner ran from Cloud Shell never
// touches the database, so the new admin closes the request that asked for
// it (`superseded`). Settings → Updates then stops offering a step for a
// release that already runs.
let supersedeBootstrapped = false;
function bootstrapSupersedeUpdateRequests(): void {
  if (supersedeBootstrapped) return;
  supersedeBootstrapped = true;
  const { adapter, registry } = getQueryContext();
  execute(registry, adapter, SYSTEM_CTX, "platform_updates.supersede_stale", {})
    .then((r) => {
      if (!r.ok) {
        console.error("[bootstrap.update_requests] supersede failed", r.error);
        return;
      }
      const { superseded } = r.value as { superseded: string[] };
      if (superseded.length > 0) {
        console.log(
          `[bootstrap.update_requests] closed ${superseded.length} superseded request(s)`,
        );
      }
    })
    .catch((e) => console.error("[bootstrap.update_requests] supersede failed", e));
}

// v0.2.37 — proposal GC sidecar. Sweeps pending rows older than 30
// days → 'superseded' once per day across all *_pending_actions
// tables. Keeps the bell badge meaningful.
let proposalGcBootstrapped = false;
function bootstrapDomainEventGc(): void {
  const { adapter } = getQueryContext();
  startDomainEventGcWorker({ adapter });
}

function bootstrapProposalGc(): void {
  if (proposalGcBootstrapped) return;
  proposalGcBootstrapped = true;
  const { adapter } = getQueryContext();
  startProposalGcWorker({ adapter });
}

// issue #356 — chat-image sweep. Images the AI produced live on their message
// like any other content, so they accumulate; unlike operator uploads nobody
// curates or browses them. Removes objects under `chat-images/` whose messages
// are older than 7 days, skipping any key a surviving message still shares.
let chatImageGcBootstrapped = false;
function bootstrapChatImageGc(): void {
  if (chatImageGcBootstrapped) return;
  chatImageGcBootstrapped = true;
  const { adapter } = getQueryContext();
  startChatImageGcWorker({ adapter });
}

// P17 PR4 + P18 — wire the MCP bridge to the ProviderResolver so
// external `bunx @caelo-cms/mcp-server` callers can drive the
// chat-runner. resolveProvider returns null when no key is wired
// anywhere; mcp.send_chat surfaces a structured error pointing at
// /settings/ai instead of crashing.
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

/**
 * Runs once at server start, before any request. A cloud install whose media
 * would land on the container's ephemeral filesystem refuses to start here,
 * so the Cloud Run revision fails its startup (and `cms-provision upgrade`
 * rolls back) instead of silently losing every upload.
 */
export const init: ServerInit = async () => {
  await assertDurableMediaRoot(mediaStorageSetup());
};

export const handle: Handle = async ({ event, resolve }) => {
  // #684 — the Settings section moved from /security; keep every old link,
  // bookmark and in-flight Approve POST working. Answered before session
  // resolution: the target page runs its own auth guard.
  const moved = legacySecurityRedirect(event.url);
  if (moved) return new Response(null, { status: 308, headers: { Location: moved } });
  ensureProviderResolverConfigured();
  // v0.5.9 — fire-and-forget bootstraps had `void` prefixes that
  // swallowed their rejections. Replace with .catch() so background
  // task failures (plugin manifest invalid, bootstrap token DB write)
  // land in Cloud Run stderr instead of disappearing into the void.
  bootstrapE2eOperatorAccess();
  bootstrapRedeploy();
  bootstrapReleaseCheck();
  bootstrapAutoUpdates();
  bootstrapSupersedeUpdateRequests();
  bootstrapProposalGc();
  bootstrapChatImageGc();
  bootstrapMcpBridge();
  bootstrapDomainEventGc();
  bootstrapQualityAudits();
  bootstrapBugForwarding();
  // #1008 — wait for the shared plugin-host boot, then follow plugin
  // decisions made through any instance (throttled state check; reconciles
  // only when the plugin rows changed), so this request renders and
  // dispatches on the database's plugin state.
  await bootstrapPlugins().catch((e) => console.error("[bootstrap.plugins] failed", e));
  await syncPluginHost();
  consumePendingBootstrapToken().catch((e) => console.error("[bootstrap.token] failed", e));
  await seedSiteBaseUrl();
  await seedStagingHost();
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
        // #657 — never emit a Location that leaves the site (`//host`)
        // or embeds a URL in the path; such a stored row is reported
        // and the 404 stands (the static build refuses the same rows).
        const unsafeTarget = m ? redirectTargetIssue(m.toPath) : null;
        if (m && unsafeTarget) {
          console.error(`[hooks] redirect ${event.url.pathname} not served: ${unsafeTarget}`);
        } else if (m) {
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
