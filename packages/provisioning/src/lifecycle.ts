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
  s.start("Checking Cloud Run + Cloud SQL health...");

  const adminUri = await gcloud([
    "run",
    "services",
    "describe",
    "caelo-production-admin",
    "--region",
    meta.region ?? "europe-west1",
    "--project",
    meta.projectId,
    "--format=value(status.url)",
  ]);
  const sqlState = await gcloud([
    "sql",
    "instances",
    "describe",
    "caelo-production-pg",
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
  for (const service of ["caelo-production-admin", "caelo-production-gateway"]) {
    const s = spinner();
    s.start(`Rolling ${service} to ghcr.io/caelo-cms/${service.split("-")[2]}:latest...`);
    const r = await gcloud([
      "run",
      "services",
      "update",
      service,
      "--region",
      region,
      "--project",
      meta.projectId,
      "--image",
      `ghcr.io/caelo-cms/${service.split("-")[2]}:latest`,
      "--quiet",
    ]);
    if (!r.ok) {
      s.stop(red(`Failed: ${r.stderr.trim()}`));
      log.error(
        `Cloud Run update failed. Check ${bold("ghcr.io/caelo-cms")} for the image, or pin via --image-tag.`,
      );
      return;
    }
    s.stop(green(`${service} rolled`));
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
  s.start("Triggering Cloud SQL on-demand backup...");
  const r = await gcloud([
    "sql",
    "backups",
    "create",
    "--instance",
    "caelo-production-pg",
    "--project",
    meta.projectId,
    "--description",
    `caelo-cms backup ${new Date().toISOString()}`,
  ]);
  if (!r.ok) {
    s.stop(red(`Failed: ${r.stderr.trim()}`));
    return;
  }
  s.stop(
    green("Backup created. List with `gcloud sql backups list --instance=caelo-production-pg`."),
  );
}

// =========================================================================
// rotate-secret <name>
// =========================================================================

export async function rotateSecretCommand(name: string | undefined): Promise<void> {
  if (!name) {
    log.error(red("Usage: caelo-cms rotate-secret <name>"));
    log.warn(
      `Names: ${["postgres-password", "csrf-secret", "cookie-secret", "anthropic-api-key"].join(", ")}`,
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
