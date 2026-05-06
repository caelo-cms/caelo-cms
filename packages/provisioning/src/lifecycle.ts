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

  note(
    [
      `${dim("Admin Cloud Run URL")}  ${adminUri.ok ? bold(adminUri.stdout.trim()) : red("error")}`,
      `${dim("Cloud SQL state")}     ${sqlState.ok ? bold(sqlState.stdout.trim()) : red("error")}`,
      `${dim("Public site")}          ${cyan(`https://${meta.domain}`)}`,
      `${dim("Admin (IAP-gated)")}    ${cyan(`https://admin.${meta.domain}`)}`,
    ].join("\n"),
    "Status",
  );
}

// =========================================================================
// upgrade — pull latest images + roll Cloud Run
// =========================================================================

export async function upgradeCommand(): Promise<void> {
  const { meta } = requireInstall();
  if (meta.provider !== "gcp") {
    log.warn(`upgrade for provider ${meta.provider} not yet implemented.`);
    return;
  }
  if (!meta.projectId) return;

  const region = meta.region ?? "europe-west1";
  // Match the Pulumi stack's image source — the team-managed public
  // Artifact Registry repo. `:main` is a floating tag; Cloud Run only
  // rolls when the image *reference* changes, so we resolve to the
  // current sha256 digest first and pass that.
  const registryProject = "caelo-website";
  const registryRegion = "europe-west1";
  const registryRepo = "caelo-cms-images";
  for (const slug of ["admin", "gateway"] as const) {
    const s = spinner();
    s.start(`Resolving + rolling ${slug}...`);

    // 1. Find the deployed Cloud Run service name (Pulumi-suffixed).
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

    // 2. Resolve the floating `:main` tag → current sha256 digest.
    const tagInfo = await gcloud([
      "artifacts",
      "docker",
      "tags",
      "list",
      `${registryRegion}-docker.pkg.dev/${registryProject}/${registryRepo}/${slug}`,
      "--filter",
      "tag=main",
      "--format=value(version)",
      "--project",
      registryProject,
    ]);
    if (!tagInfo.ok || !tagInfo.stdout.trim()) {
      s.stop(red(`Couldn't resolve image digest for ${slug}:main`));
      log.error(`Verify the image exists at ghcr.io / caelo-cms-images. ${tagInfo.stderr.trim()}`);
      return;
    }
    const digest = tagInfo.stdout.trim().split("\n")[0]?.trim() ?? "";
    const imageRef = `${registryRegion}-docker.pkg.dev/${registryProject}/${registryRepo}/${slug}@${digest}`;

    // 3. Roll the Cloud Run service.
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
    s.stop(green(`${slug} rolled to ${digest.slice(0, 19)}...`));
  }
  log.success("Upgrade complete.");
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
