// SPDX-License-Identifier: MPL-2.0

/**
 * P21 ship 3 — shared migration runner. Used by both the GCP wizard
 * (apps/admin/scripts/wizards/gcp.ts) AND the lifecycle `upgrade`
 * command (lifecycle.ts).
 *
 * Spawns a one-shot Cloud Run Job that invokes
 * `bun /app/packages/migrations/src/migrate.ts <target>` against the
 * private-IP Cloud SQL instance. The job inherits the running admin
 * Cloud Run's image (so it always carries the matching migration set)
 * + its DB URLs + its network/subnet.
 *
 * Idempotent: drizzle's `__drizzle_migrations` table tracks applied
 * versions, so re-runs only apply NEW migrations. Returns `{ok}` so
 * callers (especially `upgrade`) can abort cleanly when a migration
 * fails BEFORE traffic shifts to the new revision.
 */

import { spinner } from "@clack/prompts";
import { green, red } from "kleur/colors";
import { gcloud } from "./gcloud.js";

interface MigrationRunnerOpts {
  readonly projectId: string;
  readonly region: string;
}

interface AdminConfig {
  readonly imageRef: string;
  readonly adminUrl: string;
  readonly publicUrl: string;
  readonly networkRef: string;
  readonly subnetRef: string;
}

/**
 * Resolve the running admin Cloud Run service's image + DB URLs +
 * VPC config. Returns null on any failure; caller surfaces the error.
 */
async function readAdminConfig(opts: MigrationRunnerOpts): Promise<AdminConfig | null> {
  // Find the actual deployed service name (Pulumi appends a 7-char
  // suffix; hardcoding the bare name 404s).
  const list = await gcloud([
    "run",
    "services",
    "list",
    "--region",
    opts.region,
    "--project",
    opts.projectId,
    "--filter",
    "metadata.name~^caelo-production-admin",
    "--format=value(metadata.name)",
  ]);
  if (!list.ok) return null;
  const serviceName = list.stdout.trim().split("\n")[0]?.trim();
  if (!serviceName) return null;

  const descr = await gcloud([
    "run",
    "services",
    "describe",
    serviceName,
    "--region",
    opts.region,
    "--project",
    opts.projectId,
    "--format=json",
  ]);
  if (!descr.ok) return null;

  try {
    const d = JSON.parse(descr.stdout) as {
      spec: {
        template: {
          metadata?: { annotations?: Record<string, string> };
          spec: {
            containers: { image?: string; env?: { name: string; value?: string }[] }[];
            vpcAccess?: { networkInterfaces?: { network?: string; subnetwork?: string }[] };
          };
        };
      };
    };
    const c = d.spec.template.spec.containers[0];
    const imageRef = c?.image ?? "";
    let adminUrl = "";
    let publicUrl = "";
    for (const e of c?.env ?? []) {
      if (e.name === "ADMIN_DATABASE_URL") adminUrl = e.value ?? "";
      if (e.name === "PUBLIC_ADMIN_DATABASE_URL") publicUrl = e.value ?? "";
    }
    let networkRef = "";
    let subnetRef = "";
    const niAnnotation =
      d.spec.template.metadata?.annotations?.["run.googleapis.com/network-interfaces"];
    if (niAnnotation) {
      try {
        const parsed = JSON.parse(niAnnotation) as { network?: string; subnetwork?: string }[];
        networkRef = parsed[0]?.network ?? "";
        subnetRef = parsed[0]?.subnetwork ?? "";
      } catch {
        // fall through
      }
    }
    if (!networkRef || !subnetRef) {
      const ni = d.spec.template.spec.vpcAccess?.networkInterfaces?.[0];
      networkRef ||= ni?.network ?? "";
      subnetRef ||= ni?.subnetwork ?? "";
    }
    if (!imageRef || !adminUrl || !publicUrl || !networkRef || !subnetRef) return null;
    return { imageRef, adminUrl, publicUrl, networkRef, subnetRef };
  } catch {
    return null;
  }
}

/**
 * Run admin + public migrations against Cloud SQL. Returns `{ok}` so
 * callers can decide what to do on failure (the wizard exits the
 * process; upgrade aborts before rolling Cloud Run).
 */
/**
 * v0.4.0 — Run TRUNCATE against cms_admin + cms_public via the same
 * one-shot Cloud Run Job pattern the migrator uses. Wipes content /
 * history / chat tables; keeps users / roles / providers / domains /
 * site_defaults / provisioning_outputs / site_ai_memory.
 *
 * Useful after a schema change (e.g. v0.4.0's module/content split)
 * when the operator wants the AI to start fresh against the new shape
 * without destroying the install.
 */
export async function truncateViaCloudRunJob(
  opts: MigrationRunnerOpts,
): Promise<{ ok: boolean; error?: string }> {
  const sAdmin = spinner();
  sAdmin.start("Reading admin Cloud Run config for truncate job...");
  const cfg = await readAdminConfig(opts);
  if (!cfg) {
    sAdmin.stop(red("Couldn't resolve admin config — admin may not be deployed yet"));
    return { ok: false, error: "admin-config-unresolved" };
  }
  sAdmin.stop(green(`Admin config resolved (${cfg.imageRef.slice(-19)})`));

  for (const target of ["admin", "public"] as const) {
    const s = spinner();
    s.start(`TRUNCATEing ${target} tables via one-shot Cloud Run Job...`);
    await gcloud([
      "run",
      "jobs",
      "delete",
      `caelo-truncate-${target}`,
      "--region",
      opts.region,
      "--project",
      opts.projectId,
      "--quiet",
    ]);
    const create = await gcloud([
      "run",
      "jobs",
      "create",
      `caelo-truncate-${target}`,
      `--image=${cfg.imageRef}`,
      "--region",
      opts.region,
      "--project",
      opts.projectId,
      "--service-account",
      `caelo-production-run-sa@${opts.projectId}.iam.gserviceaccount.com`,
      "--network",
      cfg.networkRef.split("/").pop() ?? cfg.networkRef,
      "--subnet",
      cfg.subnetRef.split("/").pop() ?? cfg.subnetRef,
      "--vpc-egress=private-ranges-only",
      "--command=bun",
      `--args=--bun,/app/packages/migrations/src/truncate.ts,${target}`,
      "--set-env-vars",
      `ADMIN_DATABASE_URL=${cfg.adminUrl},PUBLIC_ADMIN_DATABASE_URL=${cfg.publicUrl}`,
      "--max-retries=0",
      "--task-timeout=5m",
      "--quiet",
    ]);
    if (!create.ok) {
      s.stop(red(`Job create failed: ${create.stderr.trim()}`));
      return { ok: false, error: `truncate-${target}-create: ${create.stderr.trim()}` };
    }
    const exec = await gcloud([
      "run",
      "jobs",
      "execute",
      `caelo-truncate-${target}`,
      "--region",
      opts.region,
      "--project",
      opts.projectId,
      "--wait",
    ]);
    if (!exec.ok) {
      s.stop(red(`${target} truncate failed: ${exec.stderr.trim()}`));
      return { ok: false, error: `truncate-${target}-exec: ${exec.stderr.trim()}` };
    }
    s.stop(green(`${target} truncated`));
  }
  return { ok: true };
}

export async function runMigrationsViaCloudRunJob(
  opts: MigrationRunnerOpts & {
    /**
     * v0.9.2 — explicit image to run migrations against. When omitted,
     * falls back to the admin Cloud Run's CURRENT image (pre-upgrade
     * shape). The upgrade lifecycle MUST pass the NEW image being
     * rolled to — otherwise migrations run with the old image, which
     * doesn't carry the new migration files, so the bookkeeping
     * silently reports "no new migrations to apply" and the new admin
     * image then hits "column does not exist" on every query for new
     * schema. Operator-side recovery: `gcloud run jobs update
     * caelo-migrate-admin --image=<new-version>` then execute.
     */
    readonly imageOverride?: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  const sAdmin = spinner();
  sAdmin.start("Reading admin Cloud Run config for migration job...");
  const cfg = await readAdminConfig(opts);
  if (!cfg) {
    sAdmin.stop(red("Couldn't resolve admin config — admin may not be deployed yet"));
    return { ok: false, error: "admin-config-unresolved" };
  }
  const migrationImage = opts.imageOverride ?? cfg.imageRef;
  if (opts.imageOverride && opts.imageOverride !== cfg.imageRef) {
    sAdmin.stop(
      green(
        `Admin config resolved; migrating against NEW image (${migrationImage.slice(-19)}) instead of current (${cfg.imageRef.slice(-19)})`,
      ),
    );
  } else {
    sAdmin.stop(green(`Admin config resolved (${migrationImage.slice(-19)})`));
  }

  for (const target of ["admin", "public"] as const) {
    const s = spinner();
    s.start(`Applying ${target} migrations via one-shot Cloud Run Job...`);
    // Delete-then-create so each invocation runs with the freshest
    // image + env (no stale job specs).
    await gcloud([
      "run",
      "jobs",
      "delete",
      `caelo-migrate-${target}`,
      "--region",
      opts.region,
      "--project",
      opts.projectId,
      "--quiet",
    ]);
    const create = await gcloud([
      "run",
      "jobs",
      "create",
      `caelo-migrate-${target}`,
      `--image=${migrationImage}`,
      "--region",
      opts.region,
      "--project",
      opts.projectId,
      "--service-account",
      `caelo-production-run-sa@${opts.projectId}.iam.gserviceaccount.com`,
      "--network",
      cfg.networkRef.split("/").pop() ?? cfg.networkRef,
      "--subnet",
      cfg.subnetRef.split("/").pop() ?? cfg.subnetRef,
      "--vpc-egress=private-ranges-only",
      "--command=bun",
      `--args=--bun,/app/packages/migrations/src/migrate.ts,${target}`,
      "--set-env-vars",
      `ADMIN_DATABASE_URL=${cfg.adminUrl},PUBLIC_ADMIN_DATABASE_URL=${cfg.publicUrl}`,
      "--max-retries=0",
      "--task-timeout=10m",
      "--quiet",
    ]);
    if (!create.ok) {
      s.stop(red(`Job create failed: ${create.stderr.trim()}`));
      return { ok: false, error: `migrate-${target}-create: ${create.stderr.trim()}` };
    }
    const exec = await gcloud([
      "run",
      "jobs",
      "execute",
      `caelo-migrate-${target}`,
      "--region",
      opts.region,
      "--project",
      opts.projectId,
      "--wait",
    ]);
    if (!exec.ok) {
      s.stop(red(`${target} migrations failed: ${exec.stderr.trim()}`));
      return { ok: false, error: `migrate-${target}-exec: ${exec.stderr.trim()}` };
    }
    s.stop(green(`${target} migrations applied`));
  }
  return { ok: true };
}
