// SPDX-License-Identifier: MPL-2.0

/**
 * Read-only lookups of a deployed GCP install, plus the one traffic move an
 * app-roll needs to undo itself. Every function takes the {@link GcloudRunner}
 * it runs through, so the upgrade phases can be driven by a fake in tests and
 * by a different identity in the in-cloud upgrader job (epic #696).
 */

import type { GcloudRunner } from "../gcloud-retry.js";

/**
 * Pulumi auto-naming appends a random 7-char suffix to every resource
 * (e.g. `caelo-production-admin-3efcfea`), so lifecycle commands find the
 * deployed name by prefix. Returns the first match, or null when the listing
 * fails or finds nothing.
 */
export async function resolveGcpResourceName(
  run: GcloudRunner,
  kind: "run-service" | "sql-instance",
  prefix: string,
  projectId: string,
  region?: string,
): Promise<string | null> {
  const args =
    kind === "run-service"
      ? [
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
        ]
      : [
          "sql",
          "instances",
          "list",
          "--project",
          projectId,
          "--filter",
          `name~^${prefix}`,
          "--format=value(name)",
        ];
  const r = await run(args);
  if (!r.ok) return null;
  return (
    r.stdout
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? null
  );
}

/** A Cloud Run lookup is regional; there is no default region to guess. */
function requiredRegion(region: string | undefined): string {
  if (!region) throw new Error("a Cloud Run lookup needs the install region (install.json)");
  return region;
}

function describeArgs(serviceName: string, region: string, projectId: string, format: string) {
  return [
    "run",
    "services",
    "describe",
    serviceName,
    "--region",
    region,
    "--project",
    projectId,
    `--format=${format}`,
  ];
}

/** The deployed service as `gcloud run services describe --format=json` returns it. */
export async function describeServiceJson(
  run: GcloudRunner,
  projectId: string,
  region: string,
  serviceName: string,
): Promise<string | null> {
  const r = await run(describeArgs(serviceName, region, projectId, "json"));
  return r.ok ? r.stdout : null;
}

/** The revision serving traffic now, so a failed roll can go back to it. */
export async function findCurrentRevision(
  run: GcloudRunner,
  projectId: string,
  region: string,
  serviceName: string,
): Promise<string | null> {
  const r = await run(
    describeArgs(serviceName, region, projectId, "value(status.traffic[0].revisionName)"),
  );
  if (!r.ok) return null;
  return r.stdout.trim().split("\n")[0]?.trim() || null;
}

/** The service's own `run.app` URL. */
export async function findServiceUrl(
  run: GcloudRunner,
  projectId: string,
  region: string,
  serviceName: string,
): Promise<string | null> {
  const r = await run(describeArgs(serviceName, region, projectId, "value(status.url)"));
  if (!r.ok) return null;
  return r.stdout.trim() || null;
}

/** Pin all of a service's traffic to `revision`. */
export async function pinTraffic(
  run: GcloudRunner,
  projectId: string,
  region: string,
  serviceName: string,
  revision: string,
): Promise<boolean> {
  const r = await run([
    "run",
    "services",
    "update-traffic",
    serviceName,
    "--region",
    region,
    "--project",
    projectId,
    "--to-revisions",
    `${revision}=100`,
    "--quiet",
  ]);
  return r.ok;
}
