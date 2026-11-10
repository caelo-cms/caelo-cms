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
// below (site import, plugin host) hold timers and pg
// pools. Without this exit, Cloud Run and `docker stop` fall back to
// SIGKILL after their grace period. The workers keep no in-memory state the
// database does not already hold, so exiting once requests are done is safe.
process.on("sveltekit:shutdown", (reason: string) => {
  console.error(`[shutdown] ${reason}: HTTP server drained, exiting`);
  process.exit(0);
});

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  assertDurableMediaRoot,
  buildEmailTransport,
  configureMcpBridge,
  configurePluginUninstallFinalizer,
  configureProviderResolver,
  createPublicProjectionPublisher,
  type EmailConfigRow,
  emitSnapshot,
  generateKekHex,
  getActiveProvider,
  getMediaStorage,
  inProcessJobLauncher,
  lockPluginRow,
  makePluginImageProvider,
  makePluginTextProvider,
  mcpBackPressureResponse,
  refreshStaleLiveReleaseAtBoot,
  registerRedirectSyncRunner,
  retireLegacyStagingPreviewsAtBoot,
  setInProcessJobLauncher,
  setStagingCaptureAccess,
  stagingCaptureAccess,
  stagingServedByGateway,
  startLiveFanOut,
  startSiteImportWorker,
  transformPluginImage,
} from "@caelo-cms/admin-core";
import {
  bootstrap as bootstrapPluginHost,
  dropPluginPublicSchemas,
  type EmailTransport,
  ensureChangeConsumers,
  ensureDevSignedManifests,
  holdRuntimeHeartbeat,
  hostInstanceId,
  type AIProvider as PluginHostAIProvider,
  pluginHostRequestStart,
  type SnapshotEmitter,
} from "@caelo-cms/plugin-host";
import { execute, withBranchVisibilityScope } from "@caelo-cms/query-api";
import { type ExecutionContext, servableRedirectTargetIssue } from "@caelo-cms/shared";
import type { Handle, ServerInit } from "@sveltejs/kit/hooks";
import { legacySecurityRedirect } from "#lib/legacy-security-redirect.js";
import { bootstrapE2eOperatorAccess } from "#lib/server/google-iap.js";
import { SESSION_COOKIE } from "#lib/server/guards.js";
import { getQueryContext, mediaStorageSetup } from "#lib/server/query.js";
import { releaseWhenSent } from "#lib/server/request-lifetime.js";
import { runAdminSchedulerTick, setSchedulerProjectionPublisher } from "#lib/server/scheduler.js";

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
  const { adapter, stagingAdapter, registry } = getQueryContext();
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
  // #1337 — the transport behind an admin-side ctx.email.send (an approved
  // newsletter campaign), built from email_config on every send so a
  // configuration change takes effect without a restart. Without one the
  // send fails with the setup step (the address never reaches a log).
  const emailTransport = {
    send: async (args: Parameters<EmailTransport["send"]>[0]) => {
      const r = await execute(registry, adapter, SYSTEM_CTX, "email_config.get", {});
      if (!r.ok) throw new Error(`email_config.get: ${JSON.stringify(r.error)}`);
      const transport = buildEmailTransport((r.value as { config: EmailConfigRow }).config);
      if (!transport) {
        throw new Error("no mail transport is set up — configure one at Settings → Email");
      }
      return transport.send(args);
    },
  };
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
    // #1329 — in both public databases.
    dropPublicSchema: (schemaName) =>
      dropPluginPublicSchemas({ adapter, stagingAdapter }, schemaName),
    dropAdminSchema: (schemaName) => adapter.dropPluginAdminSchema({ schemaName }),
  });
  const report = await bootstrapPluginHost({
    infra: {
      adapter,
      // #1329 — every load provisions the plugin's tables in the staging database too.
      stagingAdapter,
      registry,
      aiProvider,
      imageTransform: transformPluginImage,
      imageProvider: makePluginImageProvider({ adapter, registry }),
      // #530 — originals of site media for plugins granted site_media_read.
      siteMediaBytes: (storageKey: string) => getMediaStorage().get(storageKey),
      emitSnapshot: emitter,
      emailTransport,
      // #1432 — the host and signing key of unsubscribe links, from cms_admin.
      mailLinks: async () => {
        const r = await execute(
          registry,
          adapter,
          SYSTEM_CTX,
          "public_mail_deliveries.link_config",
          {},
        );
        if (!r.ok) throw new Error(`mail link config: ${JSON.stringify(r.error)}`);
        return r.value as { origin: string | null; key: string | null };
      },
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
  const publisher = createPublicProjectionPublisher({ adapter, stagingAdapter });
  // #1140 — the scheduler tick's projection backstop drains through it.
  setSchedulerProjectionPublisher(publisher);
  // A failed boot publish (another publisher held the lock throughout, the
  // database was overloaded) must not fail the plugin-host boot, which is
  // memoised for the process: the scheduler tick's backstop retries the
  // full publish until it succeeds.
  await publisher.publishAll().catch((e: unknown) => {
    console.error(
      `[public-projection] boot publish failed; retried on the next scheduler tick: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
  // #1267 — plugins' change consumers, woken by the change journal on any
  // instance; one instance runs each consumer at a time (its claim). A start
  // that failed here is retried by the next scheduler tick (#1361).
  ensureChangeConsumers({ adapter, registry }).catch((e) =>
    console.error("[hooks] plugin change consumers did not start (the next tick retries)", e),
  );
  // #724 rollout E — after the plugin host, so plugins' link hooks take
  // part, and after the gateway projection, which must not wait on a
  // site-wide content conversion (nor on the editor rows it locks).
  await migrateLinksOnce();
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
  // The conversion recognises absolute links to the site's own host by the
  // stored base URL, which CAELO_SITE_URL seeds. Run it after that seed:
  // before it, those links would be judged external and stay literal for
  // good, because the run records as applied (#1008 review).
  await seedSiteBaseUrl();
  if (process.env.CAELO_SITE_URL?.trim() && siteBaseUrlSeed === null) {
    console.error(
      "[bootstrap.link_migration] skipped: the site base URL could not be seeded yet (retried at the next start)",
    );
    return;
  }
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
// (no token required). Self-hosted only: a cloud install's token comes from
// its secret manager when /setup opens (security/owner-bootstrap-secret.ts).
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

// #1359 — reporting jobs (the quality audit after a Stage) run in a job of
// their own on cloud installs, which reports back to this admin by request.
// Self-hosted and development installs have no such job: there this process
// runs the same job main itself, started by the Stage request and the tick's
// backstop. On a cloud install the launcher ignores it (admin-core
// reporting-jobs/launcher.ts).
let reportingJobsBootstrapped = false;
function bootstrapReportingJobs(): void {
  if (reportingJobsBootstrapped) return;
  reportingJobsBootstrapped = true;
  const { adapter, registry } = getQueryContext();
  setInProcessJobLauncher((kind) => inProcessJobLauncher({ adapter, registry }, kind));
}

// #1360 — the site-import crawl worker (P14) still polls in-process until
// it moves into a container job of its own (#1140 category A). Every other
// maintenance loop runs on the scheduler tick (lib/server/scheduler.ts).
let siteImportBootstrapped = false;
function bootstrapSiteImport(): void {
  if (siteImportBootstrapped) return;
  siteImportBootstrapped = true;
  const { adapter, registry } = getQueryContext();
  // issue #198 — hand the importer worker the media storage so crawl
  // screenshots persist (review side-by-sides + parity references).
  startSiteImportWorker({ adapter, registry, screenshotStorage: getMediaStorage() });
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

// #1267 — live topics across admin instances: every committing op's topics
// and every journaled change reach editors on every instance (a LISTEN
// connection; the journal's GC runs on the scheduler tick).
function bootstrapLiveFanOut(): void {
  if (liveFanOutBootstrapped) return;
  liveFanOutBootstrapped = true;
  const { adapter } = getQueryContext();
  startLiveFanOut({ adapter, instanceId: hostInstanceId() }).catch((e) =>
    console.error("[bootstrap.live_fan_out] failed", e),
  );
}
let liveFanOutBootstrapped = false;

// #1157 — redirects sync to the hosting provider on save, no build: the
// post-commit push every redirects write runs (idempotent). Targets whose
// provider is behind are retried on the scheduler tick (Settings →
// Redirects shows it).
function bootstrapRedirectSync(): void {
  const { adapter, registry } = getQueryContext();
  registerRedirectSyncRunner({ adapter, registry });
  // #1380 — a converge that moved the visitor gateway leaves the live
  // Firebase release's /api/** rewrite on the old service, and a release
  // that fixes the fixed headers (nosniff, SVG CSP) leaves the old ones live;
  // the first boot after either re-releases the served version with the
  // current config (no build). Every other provider returns at once.
  void refreshStaleLiveReleaseAtBoot({ adapter, registry }).then(
    (outcome) => {
      if (outcome === "refreshed") {
        console.info(
          "[bootstrap.live-release] the live release now has the current /api/** rewrite and security headers",
        );
      }
    },
    (e) => console.error("[bootstrap.live-release] failed", e),
  );
  // #1331 — preview channels an older release staged to are public by URL:
  // delete them, so the staging gateway stays the only path to staged pages.
  void retireLegacyStagingPreviewsAtBoot().catch((e) =>
    console.error("[bootstrap.staging-previews] failed", e),
  );
  // #1330 — renders of the protected staging site carry a per-run token.
  if (stagingServedByGateway(process.env.CAELO_PROVIDER)) {
    setStagingCaptureAccess(stagingCaptureAccess(adapter));
  }
}

// #1140 — dev and test runs have no scheduler: no Cloud Scheduler, no
// `caelo-scheduler` Compose service. There the admin ticks itself, calling
// the same tick the endpoint runs. Never in production (NODE_ENV=production
// on every install): there the scheduler calls the endpoint, and no
// in-process timer does the work (scripts/no-background-timers.test.ts).
// `CAELO_SCHEDULER_CLOCK=off` turns it off for a run that drives ticks itself.
const DEV_CLOCK_INTERVAL_MS = 5 * 60 * 1000;
let devClockBootstrapped = false;
function bootstrapDevSchedulerClock(): void {
  if (devClockBootstrapped) return;
  devClockBootstrapped = true;
  if (process.env.NODE_ENV === "production" || process.env.CAELO_SCHEDULER_CLOCK === "off") return;
  // The endpoint's request passes the plugin host's request start first
  // (handleRequest below); the dev clock does the same.
  const tick = () =>
    void (async () => {
      await pluginHostRequestStart();
      await runAdminSchedulerTick();
    })().catch((e: unknown) => {
      console.error(
        `[scheduler] dev clock tick failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, DEV_CLOCK_INTERVAL_MS).unref?.();
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

/**
 * #1392 — every request runs in its own branch-visibility scope: the ops
 * of one request (a preview, one MCP tool call, a chat turn) ask
 * `caelo_branch_visible` once per branch, and no verdict outlives it.
 *
 * #1361 — and holds the plugin runtime heartbeat until its response body
 * is sent (an event stream, a streamed page, a media download until its
 * end), so a server busy with a long request keeps counting as live for
 * the other servers. A sub-request (a load's own `fetch` during SSR) runs
 * inside a request that holds it already, and its body may go unread.
 */
export const handle: Handle = (input) =>
  withBranchVisibilityScope(async () => {
    if (input.event.isSubRequest) return handleRequest(input);
    const release = holdRuntimeHeartbeat();
    try {
      return releaseWhenSent(await handleRequest(input), release);
    } catch (e) {
      release();
      throw e;
    }
  });

const handleRequest: Handle = async ({ event, resolve }) => {
  // #684 — the Settings section moved from /security; keep every old link,
  // bookmark and in-flight Approve POST working. Answered before session
  // resolution: the target page runs its own auth guard.
  const moved = legacySecurityRedirect(event.url);
  if (moved) return new Response(null, { status: 308, headers: { Location: moved } });
  // #1375 — an MCP call to a saturated admin gets 429 + Retry-After before
  // it touches the database (the plugin-host sync below reads it too).
  const busy = mcpBackPressureResponse(
    event.url.pathname,
    getQueryContext().adapter.poolPressure("admin"),
  );
  if (busy) return busy;
  ensureProviderResolverConfigured();
  // v0.5.9 — fire-and-forget bootstraps had `void` prefixes that
  // swallowed their rejections. Replace with .catch() so background
  // task failures (plugin manifest invalid, bootstrap token DB write)
  // land in Cloud Run stderr instead of disappearing into the void.
  bootstrapE2eOperatorAccess();
  bootstrapSiteImport();
  bootstrapSupersedeUpdateRequests();
  bootstrapMcpBridge();
  bootstrapLiveFanOut();
  bootstrapRedirectSync();
  bootstrapReportingJobs();
  bootstrapDevSchedulerClock();
  // #1008 — wait for the shared plugin-host boot, then follow plugin
  // decisions made through any instance (throttled state check; reconciles
  // only when the plugin rows changed), so this request renders and
  // dispatches on the database's plugin state. #1361 — the same request
  // start confirms this instance's plugin runtime rows when they are stale
  // and runs a change-consumer retry that came due: the admin gets CPU only
  // while it serves a request, so none of this rides a timer.
  await bootstrapPlugins().catch((e) => console.error("[bootstrap.plugins] failed", e));
  await pluginHostRequestStart();
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
        // or embeds a URL in the path, unless it is an approved external
        // address (#1358); such a stored row is reported and the 404 stands
        // (the static build refuses the same rows).
        const unsafeTarget = m ? servableRedirectTargetIssue(m.toPath) : null;
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
