// SPDX-License-Identifier: MPL-2.0

/**
 * Lifecycle commands per CLAUDE.md §11.C: every install gets a
 * `caelo-cms` CLI binary with first-class `upgrade / backup / restore
 * / rotate-secret / status / destroy` operations. These are the
 * day-2 operations operators do regularly — they shouldn't drop
 * into provider tools for any of them.
 *
 * Each command:
 *   - acts on the install named by `--install <install-id or domain>`, or
 *     on the only install on this machine; with several and no flag it
 *     stops and lists them (selectInstall in install-state.ts)
 *   - dispatches to provider-specific implementations (gcp / aws /
 *     azure / self-hosted)
 *   - emits human-readable progress + a final summary
 */

import { join, resolve as resolvePath } from "node:path";
import { cancel, confirm, isCancel, log, note, select, spinner } from "@clack/prompts";
import { bold, cyan, dim, green, red, yellow } from "kleur/colors";
import { gcloud } from "./gcloud.js";
import { GCP_STACK_ENV, gatewayServiceAccountEmail, runServiceAccountEmail } from "./gcp-names.js";
import {
  type ImageDigests,
  type InstallMetadata,
  installFlag,
  installRoot,
  listInstalls,
  readSecret,
  recordImageDigests,
  selectInstall,
} from "./install-state.js";
import { ensureMcpIapAccess, type IapResource } from "./mcp-iap.js";
import { ensureOperatorAccessSync, resolveOperatorAccessTarget } from "./operator-access.js";
import { assertRegionUnchanged } from "./regions.js";
import {
  ensureGatewayServiceAccount,
  ensureGeneratedSecrets,
  plainGeneratedSecretSeed,
  ROTATABLE_SECRETS,
  type RotatableSecret,
  readSecretReplication,
  rotateRuntimeSecret,
  rotationRefusal,
} from "./runtime-secrets.js";
import { adminMediaVolume, MCP_ENV_VAR, OPERATOR_ACCESS_JOB_ENV_VAR } from "./stack-contract.js";
import {
  type DeployedService,
  type EnvChange,
  ensureStackInvariants,
  type LiveEnvValue,
  type LiveVolumes,
  liveContainerEnv,
  liveContainerMemory,
  liveEnvHasInlinePassword,
  liveVolumes,
  planAdminMemory,
  planContractEnv,
  planMediaVolume,
  rollService,
  serviceRollArgs,
} from "./stack-converge.js";

/**
 * The installs a command acts on. `--install <id or domain>` names one
 * (`--install all` every one, where the command allows it). Without the flag:
 * the only install on this machine; with several, an interactive terminal
 * asks which one (or all), and a non-interactive run stops with the list.
 * Never guesses — acting on the wrong install upgrades or wipes the wrong
 * site (see selectInstall).
 */
async function chooseInstalls(opts: {
  readonly verb: string;
  readonly allowAll: boolean;
}): Promise<InstallMetadata[]> {
  const installs = listInstalls();
  let wanted: string | undefined;
  try {
    wanted = installFlag(process.argv);
  } catch (e) {
    log.error(red(e instanceof Error ? e.message : String(e)));
    process.exit(2);
  }
  if (wanted === "all") {
    if (!opts.allowAll) {
      log.error(
        red(`${opts.verb} runs on one install at a time; pass --install <install-id or domain>.`),
      );
      process.exit(2);
    }
    if (installs.length === 0) return exitNoInstall("No Caelo install found on this machine.");
    return installs;
  }
  if (wanted === undefined && installs.length > 1 && process.stdin.isTTY) {
    const choice = await select<string>({
      message: `Which install should ${opts.verb} act on?`,
      options: [
        ...installs.map((m) => ({
          value: m.installId,
          label: m.domain,
          hint: `${m.installId}, ${m.provider}`,
        })),
        ...(opts.allowAll
          ? [{ value: "all", label: `All ${installs.length} installs`, hint: "one after another" }]
          : []),
      ],
    });
    if (isCancel(choice)) {
      cancel("Aborted.");
      process.exit(1);
    }
    if (choice === "all") return installs;
    wanted = choice;
  }
  const selected = selectInstall(installs, wanted);
  if (!selected.ok) return exitNoInstall(selected.message);
  return [selected.meta];
}

function exitNoInstall(message: string): never {
  log.error(red(message));
  if (listInstalls().length === 0) {
    log.warn(
      `Run ${bold("bunx @caelo-cms/provisioning")} first to provision an install, OR copy ${dim("~/.caelo-<install-id>/")} from the provisioning machine.`,
    );
  }
  process.exit(1);
}

/** The one install a single-install command (rotate-secret, truncate, destroy) acts on. */
async function requireInstall(verb: string): Promise<{ installId: string; meta: InstallMetadata }> {
  const [meta] = await chooseInstalls({ verb, allowAll: false });
  if (!meta) return exitNoInstall("No Caelo install found on this machine.");
  return { installId: meta.installId, meta };
}

/**
 * Run `run` for each chosen install in turn, with a header when there are
 * several. `run` reports whether the install succeeded; the first failure
 * stops the batch (the installs after it are left untouched) and sets a
 * non-zero exit code, so scripts see it too.
 *
 * @param check validates the chosen set before anything runs (e.g. a
 *   --region that cannot match several installs); returns an error or null
 */
async function forEachInstall(
  verb: string,
  run: (installId: string, meta: InstallMetadata) => Promise<boolean>,
  check?: (chosen: readonly InstallMetadata[]) => string | null,
): Promise<void> {
  const chosen = await chooseInstalls({ verb, allowAll: true });
  const problem = check?.(chosen) ?? null;
  if (problem) {
    log.error(red(problem));
    process.exit(2);
  }
  for (const [i, meta] of chosen.entries()) {
    if (chosen.length > 1) {
      note(`${meta.domain} ${dim(`(${meta.installId})`)}`, `${verb} ${i + 1}/${chosen.length}`);
    }
    if (await run(meta.installId, meta)) continue;
    process.exitCode = 1;
    const skipped = chosen.slice(i + 1);
    if (skipped.length > 0) {
      log.warn(
        `${verb} failed for ${meta.domain}; stopped before ${skipped.map((m) => m.domain).join(", ")}.`,
      );
    }
    return;
  }
}

/**
 * The install's recorded region (#607); exits with the actionable reason
 * when install.json has none, or when `requested` names a different one.
 */
function installRegion(meta: InstallMetadata, requested?: string): string {
  try {
    return assertRegionUnchanged(meta, requested);
  } catch (e) {
    log.error(red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
}

/** A Cloud Run lookup is regional; there is no default region to guess. */
function requiredRegion(region: string | undefined): string {
  if (!region) throw new Error("a Cloud Run lookup needs the install region (install.json)");
  return region;
}

/**
 * Pulumi auto-naming appends a random 7-char suffix to every resource
 * (e.g. `caelo-production-admin-3efcfea`). Lifecycle commands need the
 * actual deployed names; this helper queries gcloud with a prefix
 * filter and returns the single match (or null if missing/ambiguous).
 *
 * Used for Cloud Run services + Cloud SQL instances. We accept a
 * `kind` for routing the gcloud subcommand (services vs sql instances).
 */
async function resolveGcpResourceName(
  kind: "run-service" | "sql-instance",
  prefix: string,
  projectId: string,
  region?: string,
): Promise<string | null> {
  const args: string[] = [];
  if (kind === "run-service") {
    args.push(
      "run",
      "services",
      "list",
      "--region",
      requiredRegion(region),
      "--project",
      projectId,
      "--filter",
      `metadata.name~^${prefix}`,
      "--format=value(metadata.name)",
    );
  } else {
    args.push(
      "sql",
      "instances",
      "list",
      "--project",
      projectId,
      "--filter",
      `name~^${prefix}`,
      "--format=value(name)",
    );
  }
  const r = await gcloud(args);
  if (!r.ok) return null;
  const matches = r.stdout
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return matches[0] ?? null;
}

// =========================================================================
// status — health check + monthly cost
// =========================================================================

export async function statusCommand(): Promise<void> {
  await forEachInstall("status", statusOf);
}

async function statusOf(installId: string, meta: InstallMetadata): Promise<boolean> {
  log.info(`Install: ${bold(installId)} ${dim(`(${meta.provider})`)}`);
  log.info(`Domain:  ${bold(meta.domain)}`);
  log.info(`Project: ${bold(meta.projectId ?? "<self-hosted>")}`);

  if (meta.provider === "gcp") {
    await gcpStatus(meta);
  } else {
    log.warn(`status command for provider ${meta.provider} not yet implemented.`);
  }
  return true;
}

/**
 * P20 — fetch the latest stable Caelo release tag from GitHub.
 * Returns null on any failure (network, rate limit, no releases yet)
 * — status output skips the "newer available" line in that case.
 * Caches in-process for 10 minutes to keep repeated `status` calls
 * polite to GitHub's unauthenticated rate limit (60 req/hr).
 */
let releaseCheckCache: { fetchedAt: number; latest: string | null } | null = null;
async function getLatestReleaseTag(): Promise<string | null> {
  const now = Date.now();
  if (releaseCheckCache && now - releaseCheckCache.fetchedAt < 10 * 60 * 1000) {
    return releaseCheckCache.latest;
  }
  try {
    const res = await fetch("https://api.github.com/repos/caelo-cms/caelo-cms/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      releaseCheckCache = { fetchedAt: now, latest: null };
      return null;
    }
    const json = (await res.json()) as { tag_name?: string };
    const latest = json.tag_name ?? null;
    releaseCheckCache = { fetchedAt: now, latest };
    return latest;
  } catch {
    releaseCheckCache = { fetchedAt: now, latest: null };
    return null;
  }
}

async function gcpStatus(meta: InstallMetadata): Promise<void> {
  if (!meta.projectId) return;
  const s = spinner();
  s.start("Resolving deployed resources + checking health...");

  const region = installRegion(meta);
  const adminName = await resolveGcpResourceName(
    "run-service",
    "caelo-production-admin",
    meta.projectId,
    region,
  );
  const sqlName = await resolveGcpResourceName(
    "sql-instance",
    "caelo-production-pg",
    meta.projectId,
  );
  if (!adminName || !sqlName) {
    s.stop(red("Could not resolve deployed resource names — is the install live?"));
    return;
  }

  const adminUri = await gcloud([
    "run",
    "services",
    "describe",
    adminName,
    "--region",
    region,
    "--project",
    meta.projectId,
    "--format=value(status.url)",
  ]);
  const sqlState = await gcloud([
    "sql",
    "instances",
    "describe",
    sqlName,
    "--project",
    meta.projectId,
    "--format=value(state)",
  ]);
  s.stop(green("Health check complete"));

  // P20 — show running version vs latest available release. Pulled
  // from @caelo-cms/shared (kept in lockstep by scripts/release.ts).
  const { CAELO_VERSION } = await import("@caelo-cms/shared");
  const latestTag = await getLatestReleaseTag();
  const latestStable = latestTag?.replace(/^v/, "") ?? null;
  const upgradeHint =
    latestStable && latestStable !== CAELO_VERSION
      ? `${yellow(`v${latestStable} available`)} — run \`bunx @caelo-cms/provisioning upgrade\``
      : latestStable === CAELO_VERSION
        ? green("up to date")
        : dim("(latest unknown)");

  note(
    [
      `${dim("Admin Cloud Run URL")}  ${adminUri.ok ? bold(adminUri.stdout.trim()) : red("error")}`,
      `${dim("Cloud SQL state")}     ${sqlState.ok ? bold(sqlState.stdout.trim()) : red("error")}`,
      `${dim("Public site")}          ${cyan(`https://${meta.domain}`)}`,
      `${dim("Admin (IAP-gated)")}    ${cyan(`https://admin.${meta.domain}`)}`,
      `${dim("CLI version")}          v${CAELO_VERSION}  ${upgradeHint}`,
    ].join("\n"),
    "Status",
  );
}

// =========================================================================
// upgrade — roll Cloud Run to a specific version (or latest)
// =========================================================================

interface UpgradeOpts {
  /** Explicit semver to roll to (e.g. "0.5.3"). Defaults to "latest". */
  readonly version?: string;
  /** Pre-release channel: "stable" (default), "rc", "beta". */
  readonly channel?: "stable" | "rc" | "beta";
  /**
   * P21 ship 4 — escape hatch for forks / staging environments using
   * unsigned images. Default = verify with cosign; refuse to roll on
   * mismatch.
   */
  readonly skipVerify?: boolean;
  /**
   * #607 — the region the operator expects the install in. Optional; when
   * given it must match install.json, because upgrade never moves regions.
   */
  readonly region?: string;
  /**
   * The install to upgrade, already chosen by the caller (the wizard's
   * "Upgrade <install>" entry). Without it the install comes from
   * `--install` or the picker (chooseInstalls).
   */
  readonly installId?: string;
}

interface ServicePlan {
  readonly slug: "admin" | "gateway";
  readonly serviceName: string;
  readonly imageRef: string;
  readonly digest: string;
  readonly priorRevision: string;
  /** Env vars the service runs with now (for the env-contract diff). */
  readonly liveEnv: ReadonlyMap<string, LiveEnvValue>;
  /** Container memory limit now (null = Cloud Run's default). */
  readonly liveMemory: string | null;
  /** Execution environment, volumes and mounts now. */
  readonly liveVolumes: LiveVolumes;
}

/** A service plan plus the env changes its roll applies. */
interface RollPlan extends ServicePlan {
  readonly envFlags: readonly string[];
  readonly envChanges: readonly EnvChange[];
  /** #553 — e.g. `--memory=2Gi` when the admin runs below the stack default. */
  readonly resourceFlags: readonly string[];
  /** The admin's media bucket volume when it is (partly) missing; empty otherwise. */
  readonly volumeFlags: readonly string[];
  readonly volumeChanges: readonly string[];
}

/**
 * Resolve a tag (e.g. `0.2.6` or `latest`) to the underlying sha256
 * digest via the Docker Registry V2 API directly, without needing the
 * caller's gcloud session to have IAM access to the registry's
 * project. Used for the upgrade pre-flight resolve — the registry is
 * public so an anonymous HEAD on the manifest endpoint suffices.
 */
async function resolveTagDigest(
  region: string,
  project: string,
  repo: string,
  image: string,
  tag: string,
): Promise<{ ok: true; digest: string } | { ok: false; reason: string }> {
  const url = `https://${region}-docker.pkg.dev/v2/${project}/${repo}/${image}/manifests/${tag}`;
  // Accept both Docker v2 + OCI manifest types so the registry returns
  // the resource we asked about (single-arch + multi-arch index both
  // surface a Docker-Content-Digest header that names the manifest
  // we'd pull on a `docker pull <image>:<tag>`).
  const accept = [
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.index.v1+json",
  ].join(",");
  try {
    const res = await fetch(url, { method: "HEAD", headers: { Accept: accept } });
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };
    }
    const digest = res.headers.get("docker-content-digest");
    if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      return { ok: false, reason: `unexpected digest header: ${digest ?? "(missing)"}` };
    }
    return { ok: true, digest };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The deployed service as `gcloud run services describe --format=json` returns it. */
async function describeServiceJson(
  projectId: string,
  region: string,
  serviceName: string,
): Promise<string | null> {
  const r = await gcloud([
    "run",
    "services",
    "describe",
    serviceName,
    "--region",
    region,
    "--project",
    projectId,
    "--format=json",
  ]);
  return r.ok ? r.stdout : null;
}

/** Look up the currently-serving Cloud Run revision so we can roll back to it. */
async function findCurrentRevision(
  projectId: string,
  region: string,
  serviceName: string,
): Promise<string | null> {
  const r = await gcloud([
    "run",
    "services",
    "describe",
    serviceName,
    "--region",
    region,
    "--project",
    projectId,
    "--format=value(status.traffic[0].revisionName)",
  ]);
  if (!r.ok) return null;
  const rev = r.stdout.trim().split("\n")[0]?.trim();
  return rev || null;
}

/** Cloud Run service URL, used as the health-probe target after a roll. */
async function findServiceUrl(
  projectId: string,
  region: string,
  serviceName: string,
): Promise<string | null> {
  const r = await gcloud([
    "run",
    "services",
    "describe",
    serviceName,
    "--region",
    region,
    "--project",
    projectId,
    "--format=value(status.url)",
  ]);
  if (!r.ok) return null;
  return r.stdout.trim() || null;
}

async function rollbackTraffic(
  projectId: string,
  region: string,
  serviceName: string,
  priorRevision: string,
): Promise<boolean> {
  const r = await gcloud([
    "run",
    "services",
    "update-traffic",
    serviceName,
    "--region",
    region,
    "--project",
    projectId,
    "--to-revisions",
    `${priorRevision}=100`,
    "--quiet",
  ]);
  return r.ok;
}

/**
 * The admin's IAP resource: the Cloud Run service itself on gcp-firebase
 * (native IAP), the LB backend service on gcp (Pulumi-suffixed name).
 */
async function resolveAdminIapResource(
  meta: InstallMetadata,
  region: string,
  adminServiceName: string,
): Promise<IapResource | null> {
  if (meta.provider === "gcp-firebase") {
    return { kind: "cloud-run", service: adminServiceName, region };
  }
  const r = await gcloud([
    "compute",
    "backend-services",
    "list",
    "--global",
    `--project=${meta.projectId}`,
    "--filter=name~^caelo-production-admin-backend",
    "--format=value(name)",
  ]);
  const name = r.ok ? r.stdout.trim().split("\n")[0]?.trim() : "";
  return name ? { kind: "backend-services", service: name } : null;
}

export async function upgradeCommand(opts: UpgradeOpts = {}): Promise<void> {
  if (opts.installId) {
    const selected = selectInstall(listInstalls(), opts.installId);
    if (!selected.ok) return exitNoInstall(selected.message);
    if (!(await upgradeInstall(selected.meta.installId, selected.meta, opts))) process.exitCode = 1;
    return;
  }
  await forEachInstall(
    "upgrade",
    (installId, meta) => upgradeInstall(installId, meta, opts),
    // Each install has its own recorded region (#607); one --region can't
    // match several, and finding out halfway would leave a partial batch.
    (chosen) =>
      opts.region && chosen.length > 1
        ? "--region names one install's region; drop it when upgrading several installs."
        : null,
  );
}

async function upgradeInstall(
  installId: string,
  meta: InstallMetadata,
  opts: UpgradeOpts,
): Promise<boolean> {
  // v0.5.15 — extended to cover gcp-firebase too. Both providers share
  // the identical admin + gateway shape on Cloud Run (Artifact
  // Registry image, `caelo-production-<slug>` service naming, the same
  // gcloud commands). The only delta is the static-site layer (Cloud
  // CDN vs Firebase Hosting) which upgradeCommand doesn't touch. AWS
  // + Azure still bail with "not yet implemented" until those
  // provider adapters land.
  if (meta.provider !== "gcp" && meta.provider !== "gcp-firebase") {
    log.warn(`upgrade for provider ${meta.provider} not yet implemented.`);
    return false;
  }
  if (!meta.projectId) return false;

  // #607 — upgrade never moves an install: a `--region` other than the
  // recorded one is refused before anything rolls.
  const region = installRegion(meta, opts.region);
  const registryProject = "caelo-website";
  const registryRegion = "europe-west1";
  const registryRepo = "caelo-cms-images";

  const targetTag = (() => {
    if (opts.version) return opts.version.startsWith("v") ? opts.version.slice(1) : opts.version;
    if (opts.channel === "rc") return "rc";
    if (opts.channel === "beta") return "beta";
    return "latest";
  })();
  log.info(`Upgrading admin + gateway to ${bold(targetTag)}`);

  // ────────────────────────────────────────────────────────────────
  // Phase 1: pre-flight. Resolve both digests + capture both prior
  // revisions BEFORE rolling anything. If any service is missing or
  // any digest can't be resolved, abort cleanly with no partial state.
  // ────────────────────────────────────────────────────────────────
  const plans: ServicePlan[] = [];
  const sPre = spinner();
  sPre.start("Pre-flight: resolving services + image digests + current revisions...");
  for (const slug of ["admin", "gateway"] as const) {
    const serviceName = await resolveGcpResourceName(
      "run-service",
      `caelo-production-${slug}`,
      meta.projectId,
      region,
    );
    if (!serviceName) {
      sPre.stop(red(`Could not find caelo-production-${slug}* Cloud Run service`));
      return false;
    }
    // Resolve the tag via the public Docker Registry V2 API directly,
    // not `gcloud artifacts docker tags list`. The gcloud path requires
    // the operator's local credentials to have IAM read on the Caelo
    // team's caelo-website project — end users don't have that, so
    // the call fails for them with a misleading "tag doesn't exist"
    // error. The AR repo is configured public; the V2 HEAD on the
    // manifest endpoint returns the Docker-Content-Digest header
    // anonymously. (Same source of truth `gcloud artifacts docker
    // tags list` is wrapping; we just skip the IAM-gated CLI.)
    const digestRes = await resolveTagDigest(
      registryRegion,
      registryProject,
      registryRepo,
      slug,
      targetTag,
    );
    if (!digestRes.ok) {
      sPre.stop(red(`Couldn't resolve image digest for ${slug}:${targetTag}`));
      log.error(
        `Public registry returned ${digestRes.reason}.\n` +
          `Verify the tag exists at https://${registryRegion}-docker.pkg.dev/${registryProject}/${registryRepo}/${slug}:${targetTag}\n` +
          `(latest releases live at https://github.com/caelo-cms/caelo-cms/releases — pass --version vX.Y.Z to pin.)`,
      );
      return false;
    }
    const digest = digestRes.digest;
    const priorRevision = await findCurrentRevision(meta.projectId, region, serviceName);
    if (!priorRevision) {
      sPre.stop(red(`Could not capture current revision for ${slug} — refusing to roll`));
      return false;
    }
    const serviceJson = await describeServiceJson(meta.projectId, region, serviceName);
    if (!serviceJson) {
      sPre.stop(red(`Could not read the ${slug} service's configuration — refusing to roll`));
      return false;
    }
    plans.push({
      slug,
      serviceName,
      digest,
      imageRef: `${registryRegion}-docker.pkg.dev/${registryProject}/${registryRepo}/${slug}@${digest}`,
      priorRevision,
      liveEnv: liveContainerEnv(serviceJson),
      liveMemory: liveContainerMemory(serviceJson),
      liveVolumes: liveVolumes(serviceJson),
    });
  }
  const install = {
    provider: meta.provider,
    projectId: meta.projectId,
    env: GCP_STACK_ENV,
    domain: meta.domain,
    region,
  };
  const deployed = Object.fromEntries(
    plans.map((p) => [p.slug, { serviceName: p.serviceName, liveEnv: p.liveEnv }]),
  ) as Record<"admin" | "gateway", DeployedService>;
  const envPlan = planContractEnv(install, deployed);
  if (!envPlan.ok) {
    sPre.stop(red("Pre-flight failed: the install's env contract can't be applied"));
    log.error(envPlan.error);
    return false;
  }
  // The admin's media lives in the media bucket, mounted as a Cloud Storage
  // volume. Without it every upload is lost on the next revision or
  // scale-to-zero, so a volume upgrade cannot add is a pre-flight failure.
  const adminLive = plans.find((p) => p.slug === "admin");
  const mediaVolume = adminLive
    ? planMediaVolume(adminLive.liveVolumes, adminMediaVolume(meta.projectId, GCP_STACK_ENV))
    : ({ ok: false, error: "no admin service planned" } as const);
  if (!mediaVolume.ok) {
    sPre.stop(red("Pre-flight failed: the admin's media volume can't be set up"));
    log.error(mediaVolume.error);
    return false;
  }
  let rolls: RollPlan[] = plans.map((p) => {
    // #553 — the admin runs the Lighthouse quality audit; raise it to the
    // stack's memory default (never lowered; an unparsable value is kept).
    const memory = p.slug === "admin" ? planAdminMemory(p.liveMemory) : null;
    if (memory && !memory.ok) log.warn(yellow(`admin memory left as is: ${memory.error}`));
    return {
      ...p,
      envFlags: envPlan.services[p.slug].flags,
      envChanges: envPlan.services[p.slug].changes,
      resourceFlags: memory?.ok ? memory.flags : [],
      volumeFlags: p.slug === "admin" ? mediaVolume.flags : [],
      volumeChanges: p.slug === "admin" ? mediaVolume.changes : [],
    };
  });
  sPre.stop(green(`Pre-flight ok — ${rolls.length} services planned`));
  for (const roll of rolls) {
    for (const c of roll.volumeChanges) log.info(`${roll.slug} ${bold("media")}: ${c}`);
    for (const f of roll.resourceFlags) {
      log.info(`${roll.slug} ${bold("resources")}: ${roll.liveMemory ?? dim("(default)")} → ${f}`);
    }
    for (const c of roll.envChanges) {
      log.info(
        `${roll.slug} env ${bold(c.name)}: ${c.from === undefined ? dim("(unset)") : c.from} → ${c.to === undefined ? dim("(removed)") : c.to}`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // P21 ship 4 — cosign verify each resolved digest against the
  // Caelo release workflow's keyless OIDC identity. Refuses to roll
  // on signature mismatch (compromised registry, typosquatted repo,
  // or operator pointed at a fork's image).
  //
  // Verification is opt-out via --skip-verify for forks/staging that
  // intentionally use unsigned images. Cosign-not-installed produces
  // a clear "install cosign or pass --skip-verify" message rather
  // than a confusing stack.
  // ────────────────────────────────────────────────────────────────
  if (!opts.skipVerify) {
    const verified = await verifyCosignAll(plans, registryRegion, registryProject, registryRepo);
    if (!verified) return false;
  } else {
    log.warn(yellow("--skip-verify set — image signatures NOT verified."));
  }

  // ────────────────────────────────────────────────────────────────
  // Runtime identities + secrets the env contract references: the
  // gateway's own run SA and the CLI-generated secrets
  // (runtime-secrets.ts). Created once, never overwritten. Must exist
  // before the IAM invariants bind them and before the rolls reference
  // them, so any failure aborts here.
  // ────────────────────────────────────────────────────────────────
  const sRt = spinner();
  sRt.start("Ensuring the gateway service account + generated runtime secrets...");
  const secretsTarget = { projectId: meta.projectId, env: GCP_STACK_ENV };
  const replication = await readSecretReplication(secretsTarget);
  const runtime = [
    await ensureGatewayServiceAccount(secretsTarget),
    ...(replication.ok
      ? await ensureGeneratedSecrets({
          ...secretsTarget,
          replication: replication.replication,
          seed: plainGeneratedSecretSeed(deployed.admin.liveEnv),
        })
      : [{ id: "secret replication", status: "failed" as const, error: replication.error }]),
  ];
  const runtimeFailed = runtime.filter((o) => o.status === "failed");
  if (runtimeFailed.length > 0) {
    sRt.stop(red("Runtime identities/secrets could not be ensured. Aborting upgrade."));
    for (const o of runtimeFailed) log.error(red(`  FAILED: ${o.id}\n    ${o.error ?? ""}`));
    log.warn("No traffic was shifted and no migrations ran. Fix the above and re-run.");
    return false;
  }
  sRt.stop(green("Gateway service account + runtime secrets ok"));
  for (const o of runtime.filter((o) => o.status === "applied")) log.info(`  created: ${o.id}`);

  // ────────────────────────────────────────────────────────────────
  // Converge the infrastructure the stack declares but upgrade can't get
  // from an image roll: IAM bindings + CDN policy added to the stacks after
  // this install was provisioned (stack-contract.ts). Additive + idempotent.
  // A failure the install can't work without aborts here, before
  // migrations or any traffic shift; the rest warn.
  // ────────────────────────────────────────────────────────────────
  const sInv = spinner();
  sInv.start("Ensuring the IAM bindings + CDN settings the stack declares...");
  const invariants = await ensureStackInvariants({
    provider: meta.provider,
    projectId: meta.projectId,
    region,
    env: GCP_STACK_ENV,
    services: Object.fromEntries(rolls.map((r) => [r.slug, r.serviceName])) as Record<
      "admin" | "gateway",
      string
    >,
  });
  const applied = invariants.outcomes.filter((o) => o.status === "applied");
  const failed = invariants.outcomes.filter((o) => o.status === "failed");
  if (invariants.mustAbort) {
    sInv.stop(red("Stack invariants could not be ensured. Aborting upgrade."));
  } else {
    sInv.stop(
      green(
        `Stack invariants ok (${invariants.outcomes.length - failed.length}/${invariants.outcomes.length}, ${applied.length} applied)`,
      ),
    );
  }
  for (const o of applied) log.info(`  applied: ${o.id} ${dim(`(${o.why})`)}`);
  for (const o of failed) {
    const line = `  ${o.onFailure === "abort" ? "FAILED" : "not applied"}: ${o.id} — ${o.why}\n    ${o.error ?? ""}`;
    if (o.onFailure === "abort") log.error(red(line));
    else log.warn(yellow(line));
  }
  if (invariants.mustAbort) {
    log.warn("No traffic was shifted and no migrations ran. Fix the bindings above and re-run.");
    return false;
  }

  // ────────────────────────────────────────────────────────────────
  // P21 ship 3 — DB migrations BEFORE traffic shifts. Idempotent
  // (drizzle bookkeeping table); a failure here aborts the upgrade
  // before the new image touches traffic, so the admin keeps
  // serving the old version against the existing schema.
  // ────────────────────────────────────────────────────────────────
  const sMig = spinner();
  sMig.start("Applying DB migrations (idempotent)...");
  const { runMigrationsViaCloudRunJob } = await import("./migration-runner.js");
  // v0.9.2 — pass the NEW admin image as imageOverride. Pre-v0.9.2 the
  // migration runner read the CURRENT admin image (the one being
  // replaced) which didn't carry the new release's migration files,
  // so new migrations were silently skipped. Production hit this on
  // every upgrade that introduced schema changes — the symptom was
  // post-rollout queries failing with "column does not exist".
  const adminPlan = rolls.find((p) => p.slug === "admin");
  const mig = await runMigrationsViaCloudRunJob({
    projectId: meta.projectId,
    region,
    ...(adminPlan ? { imageOverride: adminPlan.imageRef } : {}),
  });
  if (!mig.ok) {
    sMig.stop(red(`Migrations failed (${mig.error ?? "unknown"}). Aborting upgrade.`));
    log.warn(
      "No traffic was shifted. Inspect the Cloud Run Job logs:\n" +
        "  gcloud logging read 'resource.type=cloud_run_job AND " +
        'resource.labels.job_name=~"caelo-migrate-.*"\' ' +
        `--project=${meta.projectId} --limit=50`,
    );
    return false;
  }
  sMig.stop(green("Migrations applied"));

  // ────────────────────────────────────────────────────────────────
  // Issue #37 — MCP through IAP. Idempotently ensure the MCP service
  // account + its IAP/token-creator bindings; the admin learns the SA's
  // email from CAELO_MCP_IAP_SERVICE_ACCOUNT in the env contract. Installs
  // provisioned before this existed get it here, with no operator config.
  // A failure only costs MCP access, so it warns instead of aborting.
  // ────────────────────────────────────────────────────────────────
  // Env vars the rolls must leave as the service has them, because the
  // thing they point at could not be set up.
  const leaveUntouched: string[] = [];
  if (adminPlan) {
    const sMcp = spinner();
    sMcp.start("Ensuring MCP access through IAP...");
    const resource = await resolveAdminIapResource(meta, region, adminPlan.serviceName);
    const mcp = resource
      ? await ensureMcpIapAccess({ projectId: meta.projectId, resource })
      : { ok: false as const, error: "admin IAP backend service not found" };
    if (mcp.ok) {
      sMcp.stop(
        green(`MCP access ready (${mcp.serviceAccount}; ${mcp.operators.length} operator(s))`),
      );
    } else {
      sMcp.stop(yellow(`MCP access not configured: ${mcp.error}`));
      log.warn(
        "The upgrade continues; external MCP clients stay blocked by IAP until this succeeds.",
      );
      // Don't hand the admin an MCP service account that may not exist or
      // lacks its bindings: /security/mcp would print a `claude mcp add`
      // command that can't work. Leave the var as the service has it.
      leaveUntouched.push(MCP_ENV_VAR);
    }

    // ──────────────────────────────────────────────────────────────
    // Operator access: the sync job that keeps Google IAP in step with the
    // user list (operator-access.ts) — its own SA, the only principal that
    // may change the IAP binding; the admin may only start it. Also removes
    // the operator-access rights an earlier revision gave the admin's SA.
    // After migrations: the job's database user gets the role migration
    // 0239 creates. A failure only costs IAP following the user list, so it
    // warns; the admin then reports the sync as not set up, loudly.
    // ──────────────────────────────────────────────────────────────
    const sOa = spinner();
    sOa.start("Ensuring the operator-access sync job...");
    const resolved = await resolveOperatorAccessTarget({
      provider: meta.provider,
      projectId: meta.projectId,
      region,
      env: GCP_STACK_ENV,
      ownerEmail: meta.ownerEmail,
      imageRef: adminPlan.imageRef,
    });
    const oa = resolved.ok
      ? await ensureOperatorAccessSync(resolved.target)
      : { ok: false as const, done: [], error: resolved.error };
    for (const step of oa.done) log.info(`  ${dim(step)}`);
    if (oa.ok) {
      sOa.stop(green("Operator-access sync job ready (IAP follows the user list)"));
    } else {
      sOa.stop(yellow(`Operator-access sync job not set up: ${oa.error}`));
      log.warn(
        "The upgrade continues; user changes will report that Google IAP could not be updated until this succeeds. Re-run upgrade once the cause is fixed.",
      );
      leaveUntouched.push(OPERATOR_ACCESS_JOB_ENV_VAR);
    }
  }
  if (leaveUntouched.length > 0) {
    const replan = planContractEnv(install, deployed, { leaveUntouched });
    if (replan.ok) {
      rolls = rolls.map((r) => ({
        ...r,
        envFlags: replan.services[r.slug].flags,
        envChanges: replan.services[r.slug].changes,
      }));
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Phase 2: roll each service, probe health, auto-rollback on fail.
  // If admin succeeds but gateway fails, also roll admin back so the
  // operator never ends up on a mismatched-version pair. The env
  // contract's changes ride the same `services update` as the image, so
  // they land in the new revision (and roll back with it). So does the
  // service's run SA: the gateway moves to its own SA here.
  // ────────────────────────────────────────────────────────────────
  const rolled: ServicePlan[] = [];
  for (const plan of rolls) {
    const s = spinner();
    s.start(`Rolling ${plan.slug} → ${plan.digest.slice(0, 19)}...`);
    const upd = await rollService(
      serviceRollArgs({
        serviceName: plan.serviceName,
        region,
        projectId: meta.projectId,
        imageRef: plan.imageRef,
        serviceAccount:
          plan.slug === "admin"
            ? runServiceAccountEmail(meta.projectId, GCP_STACK_ENV)
            : gatewayServiceAccountEmail(meta.projectId, GCP_STACK_ENV),
        envFlags: plan.envFlags,
        resourceFlags: plan.resourceFlags,
        volumeFlags: plan.volumeFlags,
      }),
    );
    if (!upd.ok) {
      s.stop(red(`Failed: ${upd.stderr.trim()}`));
      await rollbackPriorlyRolled(meta.projectId, region, rolled);
      return false;
    }
    // Force traffic onto the new revision. `update --image` only auto-
    // flips when the service has no explicit traffic config — but our
    // own auto-rollback path (rollbackTraffic) pins traffic to the
    // prior revision, and that pin survives subsequent `update --image`
    // calls. Without an explicit `update-traffic --to-latest` here, a
    // prior failed upgrade silently locks every future upgrade off the
    // serving path: new revisions are created, marked Ready, and never
    // see traffic. Re-issuing it on every successful image update is
    // idempotent + fixes already-pinned services.
    const flip = await gcloud([
      "run",
      "services",
      "update-traffic",
      plan.serviceName,
      "--region",
      region,
      "--project",
      meta.projectId,
      "--to-latest",
      "--quiet",
    ]);
    if (!flip.ok) {
      s.stop(red(`Traffic flip to latest failed: ${flip.stderr.trim()}`));
      await rollbackPriorlyRolled(meta.projectId, region, rolled);
      return false;
    }
    if (!(await findServiceUrl(meta.projectId, region, plan.serviceName))) {
      s.stop(red(`Could not resolve service URL for ${plan.slug} — rolling back`));
      await rollbackTraffic(meta.projectId, region, plan.serviceName, plan.priorRevision);
      await rollbackPriorlyRolled(meta.projectId, region, rolled);
      return false;
    }
    // Cloud Run's `update --image` (with default --quiet) returns only
    // after the new revision passes its container-readiness probe AND
    // becomes the serving revision. That's the gate we rely on now —
    // the prior `/_caelo/health` HTTP probe via the run.app URL always
    // 403'd because the admin Cloud Run service is invoker-restricted
    // to the IAP service account (the LB+IAP gates user traffic; direct
    // run.app calls are denied by design). Probing through the LB would
    // require an IAP-issued OAuth token, which the operator's gcloud
    // session doesn't carry. Trust Cloud Run's own readiness signal —
    // a real startup failure surfaces as `gcloud update` returning an
    // error, which the upd.ok check above already catches and rolls
    // back. Deeper checks (DB connectivity, schema match) surface on
    // the first request after upgrade.
    s.stop(green(`${plan.slug} rolled to ${plan.digest.slice(0, 19)}... ✓`));
    rolled.push(plan);
  }
  log.success(`Upgrade to ${bold(targetTag)} complete (admin + gateway revisions Ready).`);
  if (rolls.some((r) => liveEnvHasInlinePassword(r.liveEnv))) {
    // The services just moved their database password to Secret Manager,
    // but every earlier revision still shows it in its env.
    log.warn(
      yellow(
        `The database password was stored in plain env vars before this upgrade and stays readable in the services' old revisions. Rotate it now: ${bold("bunx @caelo-cms/provisioning rotate-secret postgres-password")}`,
      ),
    );
  }

  const digestOf = (slug: "admin" | "gateway"): string => {
    const roll = rolls.find((r) => r.slug === slug);
    if (!roll) throw new Error(`upgrade rolled no ${slug} service`);
    return roll.digest;
  };
  await recordRolledDigests(installId, meta.provider, {
    admin: digestOf("admin"),
    gateway: digestOf("gateway"),
  });
  return true;
}

/**
 * Record the digests just rolled so nothing re-deploys an older release:
 * install.json (what a wizard re-run deploys) and the Pulumi stack config
 * (what a plain `pulumi up` deploys). The roll already succeeded, so each
 * write that fails warns with the exact manual fix instead of failing the
 * upgrade, and one failing never skips the other.
 */
async function recordRolledDigests(
  installId: string,
  provider: "gcp" | "gcp-firebase",
  digests: ImageDigests,
): Promise<void> {
  const reason = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
  try {
    recordImageDigests(installId, digests);
  } catch (e) {
    log.warn(
      yellow(
        `Could not record the rolled digests in ${installRoot(installId)}/install.json (${reason(e)}). Add this before re-running the installer, or it deploys the newest release instead:\n  "imageDigests": ${JSON.stringify(digests)}`,
      ),
    );
  }
  const manual = stackConfigRecovery(installId, provider, digests);
  const passphrase = readSecret(installId, "pulumi-passphrase");
  if (!passphrase) {
    log.warn(
      yellow(
        `No Pulumi passphrase in ~/.caelo-${installId}/secrets — stack config not updated. Before any manual \`pulumi up\`, run:\n${manual}`,
      ),
    );
    return;
  }
  try {
    const { writeImageDigestsToStack } = await import("./wizards/gcp-pulumi.js");
    const { removedOverrides } = await writeImageDigestsToStack({
      installRoot: installRoot(installId),
      pulumiPassphrase: passphrase,
      provider,
      digests,
    });
    log.info(dim("Pinned the rolled image digests in the Pulumi stack config."));
    if (removedOverrides.length > 0) {
      log.warn(
        yellow(
          `Removed ${removedOverrides.join(", ")} from the stack config: those image overrides win over the digest pins, so a later \`pulumi up\` would have rolled back to them.`,
        ),
      );
    }
  } catch (e) {
    log.warn(
      yellow(
        `Could not pin the rolled digests in the Pulumi stack config (${reason(e)}). Before any manual \`pulumi up\`, run:\n${manual}`,
      ),
    );
  }
}

/**
 * Shell commands that pin `digests` in the install's own Pulumi stack, with
 * the same workspace, backend, stack and passphrase the CLI uses — run from
 * any directory, they cannot hit an unrelated stack.
 */
function stackConfigRecovery(
  installId: string,
  provider: "gcp" | "gcp-firebase",
  digests: ImageDigests,
): string {
  const root = installRoot(installId);
  const env = `PULUMI_BACKEND_URL=file://${join(root, "state")} PULUMI_CONFIG_PASSPHRASE="$(cat ${join(root, "secrets", "pulumi-passphrase")})"`;
  const cwd = `--cwd ${resolvePath(import.meta.dir, "../stacks", provider)} --stack ${GCP_STACK_ENV}`;
  const lines = Object.entries(digests).map(
    ([svc, d]) => `  ${env} pulumi config set ${cwd} caelo-${provider}:image-digest-${svc} ${d}`,
  );
  if (provider === "gcp") {
    lines.push(
      `  ${env} pulumi config rm ${cwd} caelo-gcp:image-admin  # only if set`,
      `  ${env} pulumi config rm ${cwd} caelo-gcp:image-gateway  # only if set`,
    );
  }
  return lines.join("\n");
}

/**
 * Roll back any services that already passed their probe in this
 * upgrade run. Called when a later service fails its probe so the
 * operator never ends up on an admin-new + gateway-old (or vice versa)
 * mismatched pair.
 */
/** Returns true if `argv` runs to a zero exit; false on non-zero or ENOENT. */
function probeBinary(argv: string[]): boolean {
  try {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Ensure cosign is on PATH. If not — and the operator is on macOS with
 * brew available — offer to `brew install cosign` interactively. Falls
 * back to printing the platform install URL + the --skip-verify
 * escape hatch when auto-install isn't possible.
 *
 * Returns true if cosign is callable after this function returns.
 */
async function ensureCosignAvailable(): Promise<boolean> {
  if (probeBinary(["cosign", "version"])) return true;

  log.error(red("cosign not found on PATH — required for image-signature verification."));

  // macOS auto-install offer. Only when `brew` is itself on PATH —
  // otherwise the operator is on a stripped-down install where
  // homebrew was never set up, and the manual instructions are more
  // useful than a failing brew shell-out.
  if (process.platform === "darwin" && probeBinary(["brew", "--version"])) {
    const proceed = await confirm({
      message: "Install cosign via brew now? (one-shot: brew install cosign)",
      initialValue: true,
    });
    if (!isCancel(proceed) && proceed === true) {
      const s = spinner();
      s.start("brew install cosign");
      const installResult = Bun.spawnSync(["brew", "install", "cosign"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (installResult.exitCode === 0 && probeBinary(["cosign", "version"])) {
        s.stop(green("cosign installed ✓"));
        return true;
      }
      const stderr = new TextDecoder().decode(installResult.stderr);
      s.stop(red("brew install cosign failed"));
      log.error(stderr.trim().slice(0, 500));
    }
  }

  log.warn(
    "Install cosign:\n" +
      "  • brew install cosign           (macOS)\n" +
      "  • https://docs.sigstore.dev/cosign/installation/  (other)\n" +
      "Or pass --skip-verify to roll without signature checks (NOT recommended for production).",
  );
  return false;
}

/**
 * P21 ship 4 — verify cosign keyless signatures on every planned
 * image digest. Sigstore Fulcio + Rekor; the certificate identity
 * must match the Caelo release-images workflow. A mismatch means
 * either a registry compromise, a typosquat, or the operator pointed
 * at a fork's image. Either way: refuse to roll.
 *
 * Returns true on success (or skips with a clear error and returns
 * false if cosign isn't installed / verification fails).
 */
async function verifyCosignAll(
  plans: ServicePlan[],
  registryRegion: string,
  registryProject: string,
  registryRepo: string,
): Promise<boolean> {
  // Probe cosign. Bun.spawnSync THROWS ENOENT when the binary is
  // missing (instead of returning a non-zero exit), so the probe
  // needs try/catch — relying on `exitCode !== 0` would surface a
  // confusing stack trace to the operator instead of the actionable
  // "install cosign" hint.
  if (!(await ensureCosignAvailable())) return false;

  for (const plan of plans) {
    const s = spinner();
    s.start(`Verifying cosign signature for ${plan.slug}@${plan.digest.slice(0, 19)}...`);
    const fullRef = `${registryRegion}-docker.pkg.dev/${registryProject}/${registryRepo}/${plan.slug}@${plan.digest}`;
    const verify = Bun.spawnSync(
      [
        "cosign",
        "verify",
        fullRef,
        "--certificate-identity-regexp",
        // Both release-images.yml and release.yml dispatch images;
        // accept either workflow as the signer identity. The repo
        // path is fixed; only the workflow filename varies.
        "https://github.com/caelo-cms/caelo-cms/.github/workflows/(release-images|release).yml@.*",
        "--certificate-oidc-issuer",
        "https://token.actions.githubusercontent.com",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (verify.exitCode !== 0) {
      const stderr = new TextDecoder().decode(verify.stderr);
      s.stop(red(`cosign verify FAILED for ${plan.slug}`));
      log.error(
        red(
          `${plan.slug}@${plan.digest.slice(0, 19)} signature does NOT match the Caelo release workflow identity.\n` +
            "Either:\n" +
            "  • the registry was compromised, OR\n" +
            "  • you're targeting a fork's image (verify your install's registry path), OR\n" +
            "  • cosign / sigstore had a transient outage (retry).\n" +
            `cosign stderr: ${stderr.trim().slice(0, 500)}`,
        ),
      );
      return false;
    }
    s.stop(green(`${plan.slug} signature verified ✓`));
  }
  return true;
}

async function rollbackPriorlyRolled(
  projectId: string,
  region: string,
  rolled: ServicePlan[],
): Promise<void> {
  if (rolled.length === 0) return;
  log.warn(
    yellow(`Rolling back ${rolled.length} service(s) that succeeded earlier in this run...`),
  );
  for (const plan of rolled) {
    const ok = await rollbackTraffic(projectId, region, plan.serviceName, plan.priorRevision);
    log.info(
      ok
        ? green(`  ${plan.slug} traffic restored to ${plan.priorRevision}`)
        : red(`  ${plan.slug} rollback FAILED — manual fix required`),
    );
  }
}

// =========================================================================
// backup — Cloud SQL on-demand backup + bundle Pulumi state
// =========================================================================

export async function backupCommand(): Promise<void> {
  await forEachInstall("backup", (_installId, meta) => backupOf(meta));
}

async function backupOf(meta: InstallMetadata): Promise<boolean> {
  if (meta.provider !== "gcp") {
    log.warn(`backup for provider ${meta.provider} not yet implemented.`);
    return false;
  }
  if (!meta.projectId) return false;

  const s = spinner();
  s.start("Resolving Cloud SQL instance + triggering on-demand backup...");
  const sqlName = await resolveGcpResourceName(
    "sql-instance",
    "caelo-production-pg",
    meta.projectId,
  );
  if (!sqlName) {
    s.stop(red("Could not find caelo-production-pg* Cloud SQL instance"));
    return false;
  }
  const r = await gcloud([
    "sql",
    "backups",
    "create",
    "--instance",
    sqlName,
    "--project",
    meta.projectId,
    "--description",
    `caelo-cms backup ${new Date().toISOString()}`,
  ]);
  if (!r.ok) {
    s.stop(red(`Failed: ${r.stderr.trim()}`));
    return false;
  }
  s.stop(green(`Backup created. List with \`gcloud sql backups list --instance=${sqlName}\`.`));
  return true;
}

// =========================================================================
// rotate-secret <name>
// =========================================================================

export async function rotateSecretCommand(name: string | undefined): Promise<void> {
  if (!name) {
    log.error(red("Usage: caelo-cms rotate-secret <name>"));
    log.warn(`Names: ${ROTATABLE_SECRETS.join(", ")}`);
    process.exit(2);
  }
  const refusal = rotationRefusal(name);
  if (refusal) {
    log.error(red(refusal));
    process.exit(2);
  }
  const secret = name as RotatableSecret;
  const { meta } = await requireInstall("rotate-secret");
  if (meta.provider !== "gcp" && meta.provider !== "gcp-firebase") {
    log.warn(`rotate-secret for provider ${meta.provider} not yet implemented.`);
    return;
  }
  if (!meta.projectId) return;
  const region = installRegion(meta);

  const s = spinner();
  s.start(`Rotating ${secret}...`);
  const services: Partial<Record<"admin" | "gateway", string>> = {};
  for (const slug of ["admin", "gateway"] as const) {
    const serviceName = await resolveGcpResourceName(
      "run-service",
      `caelo-production-${slug}`,
      meta.projectId,
      region,
    );
    if (!serviceName) {
      s.stop(red(`Could not find caelo-production-${slug}* Cloud Run service — nothing rotated`));
      return;
    }
    services[slug] = serviceName;
  }
  const sqlInstance =
    secret === "postgres-password"
      ? await resolveGcpResourceName("sql-instance", "caelo-production-pg", meta.projectId)
      : null;
  const report = await rotateRuntimeSecret(
    {
      projectId: meta.projectId,
      region,
      env: GCP_STACK_ENV,
      services: services as Record<"admin" | "gateway", string>,
      ...(sqlInstance ? { sqlInstance } : {}),
    },
    secret,
  );
  if (report.ok) {
    s.stop(green(`${secret} rotated`));
  } else {
    s.stop(red(`Rotating ${secret} failed`));
  }
  for (const step of report.steps) log.info(`  ${step}`);
  if (report.error) log.error(red(report.error));
}

// =========================================================================
// destroy — pulumi destroy + gcloud projects delete
// =========================================================================

/**
 * v0.4.0 — Truncate all content + history tables on the install's Cloud
 * SQL, preserving identity (users / roles / providers / domains /
 * site_defaults / provisioning_outputs / site_ai_memory). The operator
 * can re-author from scratch against the current schema without
 * destroying infra.
 *
 * Useful after a schema-changing release (e.g. v0.4.0's module/content
 * split) when AI-authored content built against the old shape no
 * longer renders cleanly.
 */
export async function truncateCommand(): Promise<void> {
  const { meta } = await requireInstall("truncate");

  log.warn(
    yellow(
      `${bold("Truncate")} wipes ALL pages, modules, templates, layouts, redirects, nav menus, theme tokens, media assets, chat history, audit log, snapshots, and site memory on ${bold(meta.domain)}.\n` +
        `Preserved: users / roles / AI providers / domains / site_defaults / provisioning_outputs.`,
    ),
  );
  const confirm1 = await confirm({
    message: `Truncate content on ${bold(meta.domain)} (${bold(meta.projectId ?? "self-hosted")})?`,
    initialValue: false,
  });
  if (isCancel(confirm1) || !confirm1) {
    cancel("Cancelled.");
    process.exit(0);
  }
  const typed = await import("@clack/prompts").then((m) =>
    m.text({
      message: `Type the domain to confirm: ${bold(meta.domain)}`,
      validate: (v) => (v === meta.domain ? undefined : "Domain doesn't match — aborting"),
    }),
  );
  if (isCancel(typed)) {
    cancel("Cancelled.");
    process.exit(0);
  }

  if (meta.provider === "self-hosted") {
    log.warn(
      "Self-hosted truncate not yet wired. Run the SQL directly via " +
        `${cyan("docker compose -f .caelo/docker-compose.yml exec postgres psql -U admin_role cms_admin")} ` +
        "and TRUNCATE the content tables manually.",
    );
    return;
  }

  if ((meta.provider === "gcp" || meta.provider === "gcp-firebase") && meta.projectId) {
    const { truncateViaCloudRunJob } = await import("./migration-runner.js");
    const region = installRegion(meta);
    const r = await truncateViaCloudRunJob({ projectId: meta.projectId, region });
    if (!r.ok) {
      cancel(`Truncate failed: ${r.error}.`);
      process.exit(1);
    }
    note(
      [
        green(`✓ Content truncated on ${meta.domain}.`),
        "",
        "Next: visit the admin and start a fresh chat. The AI will author against",
        "the current schema (v0.4.0 → module = code + fields; content per page).",
      ].join("\n"),
      "Done",
    );
    return;
  }

  log.warn(`Truncate not implemented for provider=${meta.provider}.`);
}

export async function destroyCommand(): Promise<void> {
  const { installId, meta } = await requireInstall("destroy");

  log.warn(
    red(
      `${bold("Destroy will PERMANENTLY delete")} the GCP project + every Caelo resource. This is irreversible after the 30-day undelete window.`,
    ),
  );
  const confirm1 = await confirm({
    message: `Destroy the install for ${bold(meta.domain)} (${bold(meta.projectId ?? "self-hosted")})?`,
    initialValue: false,
  });
  if (isCancel(confirm1) || !confirm1) {
    cancel("Cancelled.");
    process.exit(0);
  }
  const typed = await import("@clack/prompts").then((m) =>
    m.text({
      message: `Type the domain to confirm: ${bold(meta.domain)}`,
      validate: (v) => (v === meta.domain ? undefined : "Domain doesn't match — aborting"),
    }),
  );
  if (isCancel(typed)) {
    cancel("Cancelled.");
    process.exit(0);
  }

  if (meta.provider === "gcp" && meta.projectId) {
    const s = spinner();
    s.start(`Deleting GCP project ${meta.projectId}...`);
    const r = await gcloud(["projects", "delete", meta.projectId, "--quiet"]);
    if (!r.ok) {
      s.stop(red(`Failed: ${r.stderr.trim()}`));
      log.warn(
        `You can delete the project manually via the Cloud Console: https://console.cloud.google.com/iam-admin/settings?project=${meta.projectId}`,
      );
    } else {
      s.stop(green(`Project ${meta.projectId} marked for deletion (30-day undelete window).`));
    }
  }

  log.info(
    `Local state at ${dim(installRoot(installId))} preserved. Remove manually if you want a clean slate: ${bold(`rm -rf ${installRoot(installId)}`)}.`,
  );
  void readSecret; // unused-import guard
}
