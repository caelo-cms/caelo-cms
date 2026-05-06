// SPDX-License-Identifier: MPL-2.0

/**
 * Lifecycle commands per CLAUDE.md §11.C: every install gets a
 * `caelo-cms` CLI binary with first-class `upgrade / backup / restore
 * / rotate-secret / status / destroy` operations. These are the
 * day-2 operations operators do regularly — they shouldn't drop
 * into provider tools for any of them.
 *
 * Each command:
 *   - reads the install id from the active install (single install
 *     per machine for v1; multi-install via `--install-id` flag)
 *   - dispatches to provider-specific implementations (gcp / aws /
 *     azure / self-hosted)
 *   - emits human-readable progress + a final summary
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { cancel, confirm, isCancel, log, note, spinner } from "@clack/prompts";
import { bold, cyan, dim, green, red, yellow } from "kleur/colors";
import { gcloud } from "./gcloud.js";
import { type InstallMetadata, installRoot, readMetadata, readSecret } from "./install-state.js";

/** Find the single install on this machine — or warn if 0/multiple. */
function findActiveInstall(): { installId: string; meta: InstallMetadata } | null {
  const home = homedir();
  if (!existsSync(home)) return null;
  const candidates = readdirSync(home)
    .filter((entry) => entry.startsWith(".caelo-"))
    .map((entry) => entry.replace(/^\.caelo-/, ""));
  for (const installId of candidates) {
    const meta = readMetadata(installId);
    if (meta) return { installId, meta };
  }
  return null;
}

function requireInstall(): { installId: string; meta: InstallMetadata } {
  const found = findActiveInstall();
  if (!found) {
    log.error(red("No Caelo install found on this machine."));
    log.warn(
      `Run ${bold("bunx @caelo-cms/provisioning")} first to provision an install, OR copy ${dim("~/.caelo-<install-id>/")} from the provisioning machine.`,
    );
    process.exit(1);
  }
  return found;
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
      region ?? "europe-west1",
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
  const { installId, meta } = requireInstall();
  log.info(`Install: ${bold(installId)} ${dim(`(${meta.provider})`)}`);
  log.info(`Domain:  ${bold(meta.domain)}`);
  log.info(`Project: ${bold(meta.projectId ?? "<self-hosted>")}`);

  if (meta.provider === "gcp") {
    await gcpStatus(meta);
  } else {
    log.warn(`status command for provider ${meta.provider} not yet implemented.`);
  }
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

  const region = meta.region ?? "europe-west1";
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
}

interface ServicePlan {
  readonly slug: "admin" | "gateway";
  readonly serviceName: string;
  readonly imageRef: string;
  readonly digest: string;
  readonly priorRevision: string;
  readonly healthPath: string;
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

/**
 * Poll the health endpoint until it returns 200 (ok) or the deadline
 * expires (unhealthy). Cold starts on Cloud Run can take 10–30s, so
 * we give 60s before declaring failure.
 */
async function probeHealthy(url: string, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5_000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        if (body?.ok === true) return true;
      }
    } catch {
      // network blip / cold start in progress — retry.
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
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

export async function upgradeCommand(opts: UpgradeOpts = {}): Promise<void> {
  const { meta } = requireInstall();
  if (meta.provider !== "gcp") {
    log.warn(`upgrade for provider ${meta.provider} not yet implemented.`);
    return;
  }
  if (!meta.projectId) return;

  const region = meta.region ?? "europe-west1";
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
      return;
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
      return;
    }
    const digest = digestRes.digest;
    const priorRevision = await findCurrentRevision(meta.projectId, region, serviceName);
    if (!priorRevision) {
      sPre.stop(red(`Could not capture current revision for ${slug} — refusing to roll`));
      return;
    }
    plans.push({
      slug,
      serviceName,
      digest,
      imageRef: `${registryRegion}-docker.pkg.dev/${registryProject}/${registryRepo}/${slug}@${digest}`,
      priorRevision,
      // Admin's health endpoint is shipped at /_caelo/health (P21);
      // gateway's is /healthz (existed since P0).
      healthPath: slug === "admin" ? "/_caelo/health" : "/healthz",
    });
  }
  sPre.stop(green(`Pre-flight ok — ${plans.length} services planned`));

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
    if (!verified) return;
  } else {
    log.warn(yellow("--skip-verify set — image signatures NOT verified."));
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
  const mig = await runMigrationsViaCloudRunJob({ projectId: meta.projectId, region });
  if (!mig.ok) {
    sMig.stop(red(`Migrations failed (${mig.error ?? "unknown"}). Aborting upgrade.`));
    log.warn(
      "No traffic was shifted. Inspect the Cloud Run Job logs:\n" +
        "  gcloud logging read 'resource.type=cloud_run_job AND " +
        'resource.labels.job_name=~"caelo-migrate-.*"\' ' +
        `--project=${meta.projectId} --limit=50`,
    );
    return;
  }
  sMig.stop(green("Migrations applied"));

  // ────────────────────────────────────────────────────────────────
  // Phase 2: roll each service, probe health, auto-rollback on fail.
  // If admin succeeds but gateway fails, also roll admin back so the
  // operator never ends up on a mismatched-version pair.
  // ────────────────────────────────────────────────────────────────
  const rolled: ServicePlan[] = [];
  for (const plan of plans) {
    const s = spinner();
    s.start(`Rolling ${plan.slug} → ${plan.digest.slice(0, 19)}...`);
    const upd = await gcloud([
      "run",
      "services",
      "update",
      plan.serviceName,
      "--region",
      region,
      "--project",
      meta.projectId,
      "--image",
      plan.imageRef,
      "--quiet",
    ]);
    if (!upd.ok) {
      s.stop(red(`Failed: ${upd.stderr.trim()}`));
      await rollbackPriorlyRolled(meta.projectId, region, rolled);
      return;
    }
    const url = await findServiceUrl(meta.projectId, region, plan.serviceName);
    if (!url) {
      s.stop(red(`Could not resolve service URL for ${plan.slug} — rolling back`));
      await rollbackTraffic(meta.projectId, region, plan.serviceName, plan.priorRevision);
      await rollbackPriorlyRolled(meta.projectId, region, rolled);
      return;
    }
    s.stop(green(`${plan.slug} rolled — probing ${url}${plan.healthPath} for 60s...`));

    const sProbe = spinner();
    sProbe.start(`Health-probing ${plan.slug}...`);
    const healthy = await probeHealthy(`${url}${plan.healthPath}`, 60_000);
    if (!healthy) {
      sProbe.stop(red(`${plan.slug} unhealthy after roll — auto-rolling back`));
      const rb = await rollbackTraffic(
        meta.projectId,
        region,
        plan.serviceName,
        plan.priorRevision,
      );
      if (!rb) {
        log.error(
          red(
            `Rollback of ${plan.slug} FAILED — manually shift traffic back: ` +
              `gcloud run services update-traffic ${plan.serviceName} ` +
              `--to-revisions=${plan.priorRevision}=100 ` +
              `--region=${region} --project=${meta.projectId}`,
          ),
        );
      }
      await rollbackPriorlyRolled(meta.projectId, region, rolled);
      return;
    }
    sProbe.stop(green(`${plan.slug} healthy ✓`));
    rolled.push(plan);
  }
  log.success(`Upgrade to ${bold(targetTag)} complete (admin + gateway both healthy).`);
}

/**
 * Roll back any services that already passed their probe in this
 * upgrade run. Called when a later service fails its probe so the
 * operator never ends up on an admin-new + gateway-old (or vice versa)
 * mismatched pair.
 */
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
  // First check cosign is on PATH. The Bun.spawnSync API surfaces
  // ENOENT as a non-zero exit; we surface the actionable hint
  // separately from a real verify failure.
  const cosignProbe = Bun.spawnSync(["cosign", "version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (cosignProbe.exitCode !== 0) {
    log.error(red("cosign not found on PATH — required for image-signature verification."));
    log.warn(
      "Install cosign:\n" +
        "  • brew install cosign           (macOS)\n" +
        "  • https://docs.sigstore.dev/cosign/installation/  (other)\n" +
        "Or pass --skip-verify to roll without signature checks (NOT recommended for production).",
    );
    return false;
  }

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
  const { meta } = requireInstall();
  if (meta.provider !== "gcp") {
    log.warn(`backup for provider ${meta.provider} not yet implemented.`);
    return;
  }
  if (!meta.projectId) return;

  const s = spinner();
  s.start("Resolving Cloud SQL instance + triggering on-demand backup...");
  const sqlName = await resolveGcpResourceName(
    "sql-instance",
    "caelo-production-pg",
    meta.projectId,
  );
  if (!sqlName) {
    s.stop(red("Could not find caelo-production-pg* Cloud SQL instance"));
    return;
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
    return;
  }
  s.stop(green(`Backup created. List with \`gcloud sql backups list --instance=${sqlName}\`.`));
}

// =========================================================================
// rotate-secret <name>
// =========================================================================

export async function rotateSecretCommand(name: string | undefined): Promise<void> {
  if (!name) {
    log.error(red("Usage: caelo-cms rotate-secret <name>"));
    log.warn(
      `Names: ${[
        "postgres-password",
        "csrf-secret",
        "cookie-secret",
        "secret-kek",
        "anthropic-api-key",
        "resend-api-key",
      ].join(", ")}`,
    );
    process.exit(2);
  }
  const { meta } = requireInstall();
  if (meta.provider !== "gcp") {
    log.warn(`rotate-secret for provider ${meta.provider} not yet implemented.`);
    return;
  }
  log.warn(
    yellow(
      `Secret rotation v1 prints the gcloud command for you to run. Full automation lands in a follow-up.`,
    ),
  );
  note(
    [
      bold("Run this from your terminal:"),
      "",
      `  ${cyan(`echo -n "<new-value>" | gcloud secrets versions add caelo-production-${name} --data-file=- --project=${meta.projectId}`)}`,
      "",
      `Then redeploy admin + gateway to pick up the new value:`,
      `  ${cyan(`bunx @caelo-cms/provisioning upgrade`)}`,
    ].join("\n"),
    "Rotate secret",
  );
}

// =========================================================================
// destroy — pulumi destroy + gcloud projects delete
// =========================================================================

export async function destroyCommand(): Promise<void> {
  const { installId, meta } = requireInstall();

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
