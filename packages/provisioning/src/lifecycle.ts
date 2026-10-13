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
import { provisioningUpgradeCommand } from "@caelo-cms/shared";
import { cancel, confirm, isCancel, log, note, select, spinner } from "@clack/prompts";
import { bold, cyan, dim, green, red, yellow } from "kleur/colors";
import { activeAccount, gcloud } from "./gcloud.js";
import { type GcloudRunner, realSleep } from "./gcloud-retry.js";
import { GCP_STACK_ENV } from "./gcp-names.js";
import { INFRA_CONTRACT_VERSION } from "./infra-contract.js";
import {
  currentMetadata,
  type ImageDigests,
  type InstallMetadata,
  installFlag,
  installRoot,
  installStagingHost,
  listInstalls,
  readMetadata,
  readSecret,
  recordImageDigests,
  recordInfraContractVersion,
  scrubInstallProgress,
  selectInstall,
  writeMetadata,
} from "./install-state.js";
import { runMigrationsViaCloudRunJob } from "./migration-runner.js";
import {
  convergeKeylessProvisioner,
  provisionerServiceAccountEmail,
} from "./provisioner-identity.js";
import { assertRegionUnchanged } from "./regions.js";
import {
  type HttpFetch,
  ROTATABLE_SECRETS,
  type RotatableSecret,
  rolesOfSecret,
  rotateRuntimeSecret,
  rotationRefusal,
} from "./runtime-secrets.js";
import { selfCommand } from "./self-command.js";
import {
  backendShellEnv,
  localStateNotice,
  type ResolvedBackend,
  resolveBackend,
} from "./state-backend.js";
import {
  type AppRollPlan,
  type ReleaseImage,
  ROLL_ORDER,
  type RollSlug,
} from "./upgrade/app-roll.js";
import { restoreCommand, takeSqlBackup } from "./upgrade/backup.js";
import { findServiceUrl, resolveGcpResourceName } from "./upgrade/gcp-lookup.js";
import { createIapHealthProbe, type HealthProbe } from "./upgrade/health.js";
import {
  fetchLatestReleaseTag,
  RELEASE_REGISTRY,
  releaseImageRef,
  releaseTag,
  resolveTagDigest,
  verifyCosignAll,
} from "./upgrade/release-images.js";
import { clackReporter } from "./upgrade/reporter.js";
import { upgradeGcpInstall } from "./upgrade/upgrade.js";

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
    return installs.map(currentMetadata);
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
    if (choice === "all") return installs.map(currentMetadata);
    wanted = choice;
  }
  const selected = selectInstall(installs, wanted);
  if (!selected.ok) return exitNoInstall(selected.message);
  return [currentMetadata(selected.meta)];
}

function exitNoInstall(message: string): never {
  log.error(red(message));
  if (listInstalls().length === 0) {
    log.warn(
      `Run ${bold(selfCommand())} first to provision an install, OR copy ${dim("~/.caelo-<install-id>/")} from the provisioning machine.`,
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

  // #696 — an install made (or resumed) through the install job: how that
  // job stands, from the same record the installer attaches with.
  if (
    (meta.provider === "gcp" || meta.provider === "gcp-firebase") &&
    meta.stateBackend?.kind === "gcs"
  ) {
    const { installJobStatusLines } = await import("./wizards/gcp-install-job.js");
    for (const line of await installJobStatusLines(meta)) log.info(line);
  }

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
  const r = await fetchLatestReleaseTag();
  const latest = r.ok ? r.tag : null;
  releaseCheckCache = { fetchedAt: now, latest };
  return latest;
}

async function gcpStatus(meta: InstallMetadata): Promise<void> {
  if (!meta.projectId) return;
  const s = spinner();
  s.start("Resolving deployed resources + checking health...");

  const region = installRegion(meta);
  const adminName = await resolveGcpResourceName(
    gcloud,
    "run-service",
    "caelo-production-admin",
    meta.projectId,
    region,
  );
  const sqlName = await resolveGcpResourceName(
    gcloud,
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
  // #696 — the upgrade runs as the new release's CLI and rolls exactly that
  // release, on exactly this install (same command Settings → Updates shows).
  const upgradeHint =
    latestStable && latestStable !== CAELO_VERSION
      ? `${yellow(`v${latestStable} available`)} — run \`${provisioningUpgradeCommand({ version: latestStable, install: meta.domain })}\``
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
// upgrade — converge the infrastructure, then roll Cloud Run to a release
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
   * #696 — roll with Cloud Run's readiness check only, without the deep
   * health check (for installs the probe cannot reach, or a roll to a
   * release that predates the deep health endpoint).
   */
  readonly skipHealthCheck?: boolean;
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

export async function upgradeCommand(opts: UpgradeOpts = {}): Promise<void> {
  if (opts.installId) {
    const selected = selectInstall(listInstalls(), opts.installId);
    if (!selected.ok) return exitNoInstall(selected.message);
    const meta = currentMetadata(selected.meta);
    if (!(await upgradeInstall(meta.installId, meta, opts))) process.exitCode = 1;
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

/**
 * Resolve both release images' digests from the public registry. Via the
 * registry's anonymous V2 API, not `gcloud artifacts docker tags list`: that
 * needs IAM read on Caelo's registry project, which operators don't have.
 */
async function resolveReleaseImages(
  tag: string,
): Promise<{ ok: true; images: Record<RollSlug, ReleaseImage> } | { ok: false; error: string }> {
  const images: Partial<Record<RollSlug, ReleaseImage>> = {};
  for (const slug of ROLL_ORDER) {
    const res = await resolveTagDigest(slug, tag);
    if (!res.ok) {
      const r = RELEASE_REGISTRY;
      return {
        ok: false,
        error:
          `Couldn't resolve image digest for ${slug}:${tag}: the public registry returned ${res.reason}.\n` +
          `Verify the tag exists at https://${r.region}-docker.pkg.dev/${r.project}/${r.repo}/${slug}:${tag}\n` +
          "(latest releases live at https://github.com/caelo-cms/caelo-cms/releases — pass --version vX.Y.Z to pin.)",
      };
    }
    images[slug] = { digest: res.digest, imageRef: releaseImageRef(slug, res.digest) };
  }
  return { ok: true, images: images as Record<RollSlug, ReleaseImage> };
}

/**
 * `upgrade`'s step of the keyless provisioner migration (#696,
 * provisioner-identity.ts) — a converge step (upgrade/converge.ts runs it
 * first). Idempotent: on an install that already runs keyless it only
 * confirms the grant.
 *
 * @returns false when the upgrade must stop (the message is printed)
 */
async function upgradeKeylessProvisioner(installId: string, projectId: string): Promise<boolean> {
  const account = await activeAccount();
  if (!account) {
    log.error(red("No active gcloud account. Run `gcloud auth login`, then re-run upgrade."));
    return false;
  }
  const s = spinner();
  s.start("Ensuring the provisioner service account is used without a key...");
  const r = await convergeKeylessProvisioner({
    projectId,
    secretsDir: join(installRoot(installId), "secrets"),
    operatorAccount: account,
  });
  if (!r.ok) {
    s.stop(red("Could not move the provisioner to impersonation. Aborting upgrade."));
    log.error(r.error);
    log.warn("Nothing was rolled and no migrations ran. Fix the above and re-run.");
    return false;
  }
  if (r.grant === "no-provisioner") {
    s.stop(
      green(`No ${provisionerServiceAccountEmail(projectId)} in this project — nothing to do`),
    );
    return true;
  }
  s.stop(
    green(
      r.legacyKey === "removed"
        ? "Provisioner moved to impersonation; its long-lived key is deleted"
        : `Provisioner keyless ok ${dim(`(${account} may impersonate it)`)}`,
    ),
  );
  if (r.legacyKey === "removed") {
    note(
      [
        `This install no longer keeps a service-account key on your machine (#696).`,
        ...r.lines.map((l) => `  ${l}`),
        "",
        `Infrastructure runs (re-running the installer) now use your own Google login:`,
        `${account} impersonates ${provisionerServiceAccountEmail(projectId)} with short-lived tokens.`,
        `They need Application Default Credentials once on this machine: ${bold("gcloud auth application-default login")}`,
      ].join("\n"),
      "Service-account key removed",
    );
  }
  return true;
}

/**
 * Upgrade one install: converge, then app-roll (upgrade/upgrade.ts holds the
 * sequence; this wires it to gcloud, the registry, cosign and install.json).
 */
async function upgradeInstall(
  installId: string,
  meta: InstallMetadata,
  opts: UpgradeOpts,
): Promise<boolean> {
  // #656 — earlier installers checkpointed database URLs with role
  // passwords (and the setup link) into progress.json. Scrub them first,
  // on every provider and whether or not the roll below succeeds.
  for (const line of scrubInstallProgress(installId)) log.warn(yellow(line));

  // gcp and gcp-firebase share the admin + gateway shape on Cloud Run; only
  // the static-site layer differs, which upgrade doesn't touch.
  if (meta.provider !== "gcp" && meta.provider !== "gcp-firebase") {
    log.warn(`upgrade for provider ${meta.provider} not yet implemented.`);
    return false;
  }
  if (!meta.projectId) return false;
  const provider = meta.provider;
  const projectId = meta.projectId;

  // #607 — upgrade never moves an install: a `--region` other than the
  // recorded one is refused before anything rolls.
  const region = installRegion(meta, opts.region);
  const targetTag = releaseTag(opts);
  log.info(`Upgrading admin + gateway to ${bold(targetTag)}`);
  // #650 — an install from before the staging host setting converges to
  // the default (staging.<domain>) without operator action: recorded here,
  // handed to the admin as CAELO_STAGING_HOST, which seeds its setting.
  const stagingHost = installStagingHost(meta);
  if (!meta.stagingDomain) writeMetadata(installId, { ...meta, stagingDomain: stagingHost });

  const run: GcloudRunner = gcloud;
  const http = fetch as unknown as HttpFetch;
  const ok = await upgradeGcpInstall(
    {
      provider,
      projectId,
      region,
      env: GCP_STACK_ENV,
      domain: meta.domain,
      stagingHost,
      ownerEmail: meta.ownerEmail,
      targetTag,
      infraContractVersion: INFRA_CONTRACT_VERSION,
      skipVerify: opts.skipVerify === true,
      skipHealthCheck: opts.skipHealthCheck === true,
    },
    {
      run,
      http,
      reporter: clackReporter(),
      resolveImages: resolveReleaseImages,
      verifyImages: verifyCosignAll,
      migrate: (imageRef) =>
        runMigrationsViaCloudRunJob({ projectId, region, imageOverride: imageRef }, { run }),
      healthProbe: (plan) => gcpHealthProbe(run, http, plan),
      recordDigests: (digests) => recordRolledDigests(installId, provider, digests),
      recordInfraContractVersion: (version) => recordInfraContractVersion(installId, version),
      provisionerIdentity: () => upgradeKeylessProvisioner(installId, projectId),
    },
  );
  // #696 — upgrade never moves Pulumi state; it says how to.
  const stateNotice = localStateNotice(meta);
  if (stateNotice) note(stateNotice, "Pulumi state is on this machine");
  if (ok && provider === "gcp-firebase") {
    // #650 — staging builds now render the staging host; the gateway
    // serves it once it is mapped. The command is idempotent, so this
    // reminder is safe to repeat on every upgrade.
    log.info(
      `Protected staging site: run ${bold("cms-provision staging-domain enable")} once to serve the staging host (it maps the host the admin uses — ${bold(stagingHost)} unless changed there —, turns on password protection, prints the login and the DNS record). Host and access: admin → Settings → Domains / Staging access.`,
    );
  }
  return ok;
}

/** The deep health probe for `plan`'s install, through IAP. */
async function gcpHealthProbe(
  run: GcloudRunner,
  http: HttpFetch,
  plan: AppRollPlan,
): Promise<{ ok: true; probe: HealthProbe } | { ok: false; error: string }> {
  const { install } = plan;
  const urls: Partial<Record<RollSlug, string>> = {};
  for (const s of plan.services) {
    const url = await findServiceUrl(run, install.projectId, install.region, s.serviceName);
    if (!url) {
      return {
        ok: false,
        error: `Could not read the ${s.slug} service's URL for the health check.`,
      };
    }
    urls[s.slug] = url;
  }
  return {
    ok: true,
    probe: createIapHealthProbe(
      {
        provider: install.provider,
        projectId: install.projectId,
        domain: install.domain,
        adminServiceUrl: urls.admin as string,
        gatewayServiceUrl: urls.gateway as string,
      },
      { run, http, sleep: realSleep },
    ),
  };
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
        `Could not record the rolled digests in the install.json of ${installId} (${reason(e)}). Add this before re-running the installer, or it deploys the newest release instead:\n  "imageDigests": ${JSON.stringify(digests)}`,
      ),
    );
  }
  const meta = readMetadata(installId);
  const manual = stackConfigRecovery(installId, meta ?? {}, provider, digests);
  let backend: ResolvedBackend;
  try {
    if (!meta) throw new Error(`no install.json for '${installId}'`);
    backend = resolveBackend(meta, {
      installRoot: installRoot(installId),
      readPassphrase: () => readSecret(installId, "pulumi-passphrase"),
    });
  } catch (e) {
    log.warn(
      yellow(
        `Stack config not updated (${reason(e)}). Before any manual \`pulumi up\`, run:\n${manual}`,
      ),
    );
    return;
  }
  try {
    const { writeImageDigestsToStack } = await import("./wizards/gcp-pulumi.js");
    const { removedOverrides } = await writeImageDigestsToStack({
      backend,
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
  meta: Pick<InstallMetadata, "stateBackend">,
  provider: "gcp" | "gcp-firebase",
  digests: ImageDigests,
): string {
  const env = backendShellEnv(meta, installRoot(installId));
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

// =========================================================================
// backup — Cloud SQL on-demand backup
// =========================================================================

export async function backupCommand(): Promise<void> {
  await forEachInstall("backup", (_installId, meta) => backupOf(meta));
}

/** Both GCP providers keep their data in the install's Cloud SQL instance. */
async function backupOf(meta: InstallMetadata): Promise<boolean> {
  if (meta.provider !== "gcp" && meta.provider !== "gcp-firebase") {
    log.warn(`backup for provider ${meta.provider} not yet implemented.`);
    return false;
  }
  if (!meta.projectId) return false;

  const s = spinner();
  s.start("Resolving Cloud SQL instance + triggering on-demand backup...");
  const r = await takeSqlBackup(
    gcloud,
    { projectId: meta.projectId, env: GCP_STACK_ENV },
    "backup",
  );
  if (!r.ok) {
    s.stop(red(`Failed: ${r.error}`));
    return false;
  }
  s.stop(green(`Backup ${r.backup.backupId} of ${r.backup.instance} created.`));
  log.info(`Restore it (overwrites all data written since): ${bold(restoreCommand(r.backup))}`);
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
      gcloud,
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
    rolesOfSecret(secret).length > 0
      ? await resolveGcpResourceName(gcloud, "sql-instance", "caelo-production-pg", meta.projectId)
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
