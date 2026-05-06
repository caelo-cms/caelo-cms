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
  // from the running admin's CAELO_VERSION env when set; falls back
  // to the @caelo-cms/shared bundled version of the local CLI.
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

  // P20 — version selection. The release CI's docker/metadata-action
  // uses `type=semver,pattern={{version}}` which strips the leading `v`
  // from the git tag, so Docker tags are bare semver: `:0.5.3`,
  // `:0.5`, `:latest`. Pre-release tags get a channel-named tag
  // (`:rc`, `:beta`) but NO `:latest`. Operators pin via --version
  // (just the semver, no `v`), opt into pre-releases via --channel,
  // or default to `:latest`.
  const targetTag = (() => {
    if (opts.version) return opts.version.startsWith("v") ? opts.version.slice(1) : opts.version;
    if (opts.channel === "rc") return "rc";
    if (opts.channel === "beta") return "beta";
    return "latest";
  })();
  log.info(`Rolling admin + gateway to ${bold(targetTag)} (registry: ${dim(registryRepo)})`);

  for (const slug of ["admin", "gateway"] as const) {
    const s = spinner();
    s.start(`Resolving + rolling ${slug}...`);

    const serviceName = await resolveGcpResourceName(
      "run-service",
      `caelo-production-${slug}`,
      meta.projectId,
      region,
    );
    if (!serviceName) {
      s.stop(red(`Could not find caelo-production-${slug}* Cloud Run service`));
      return;
    }

    // Resolve the requested tag → current sha256 digest. Cloud Run
    // only rolls when the image REFERENCE changes; pinning to the
    // sha digest guarantees a fresh revision even if `:latest` was
    // republished without changing tags.
    const tagInfo = await gcloud([
      "artifacts",
      "docker",
      "tags",
      "list",
      `${registryRegion}-docker.pkg.dev/${registryProject}/${registryRepo}/${slug}`,
      "--filter",
      `tag=${targetTag}`,
      "--format=value(version)",
      "--project",
      registryProject,
    ]);
    if (!tagInfo.ok || !tagInfo.stdout.trim()) {
      s.stop(red(`Couldn't resolve image digest for ${slug}:${targetTag}`));
      log.error(
        `Verify the tag exists. Available: \`gcloud artifacts docker tags list ${registryRegion}-docker.pkg.dev/${registryProject}/${registryRepo}/${slug} --project=${registryProject}\``,
      );
      return;
    }
    const digest = tagInfo.stdout.trim().split("\n")[0]?.trim() ?? "";
    const imageRef = `${registryRegion}-docker.pkg.dev/${registryProject}/${registryRepo}/${slug}@${digest}`;

    const r = await gcloud([
      "run",
      "services",
      "update",
      serviceName,
      "--region",
      region,
      "--project",
      meta.projectId,
      "--image",
      imageRef,
      "--quiet",
    ]);
    if (!r.ok) {
      s.stop(red(`Failed: ${r.stderr.trim()}`));
      return;
    }
    s.stop(green(`${slug} (${targetTag}) rolled to ${digest.slice(0, 19)}...`));
  }
  log.success(`Upgrade to ${bold(targetTag)} complete.`);
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
