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

/**
 * The image the revision serving traffic runs, by every digest it is known
 * by (not the service template's: after a rollback the template names the
 * failed image while traffic stays on the previous revision).
 *
 * Why two digests (#860): Caelo's release images are OCI image *indexes*
 * (buildx adds a provenance/SBOM attestation manifest even to a
 * single-platform build), and the signed release manifest, install.json
 * and every deploy pin the index digest. Cloud Run's `status.imageDigest`
 * names what it resolved and pulled, the linux/amd64 *platform manifest*
 * inside that index, so comparing it with a recorded index digest never
 * matches. The digest the revision was deployed with
 * (`spec.containers[0].image`, `…@sha256:<index>`) is the form everything
 * else records; it is content-addressed, so the revision necessarily runs
 * that index's image.
 */
export interface ServingImage {
  /** The digest the revision was deployed with; null when deployed by tag. */
  readonly deployedDigest: string | null;
  /** The digest Cloud Run resolved and runs (`status.imageDigest`); null when not reported. */
  readonly resolvedDigest: string | null;
}

/** Every digest `image` is known by, deployed form first. */
export function servingImageDigests(image: ServingImage): string[] {
  const out: string[] = [];
  for (const d of [image.deployedDigest, image.resolvedDigest]) {
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

const PINNED_DIGEST = /@(sha256:[0-9a-f]{64})$/;

/**
 * The serving revision's {@link ServingImage}, or null when the revision or
 * any digest of it cannot be read.
 */
export async function findServingImage(
  run: GcloudRunner,
  projectId: string,
  region: string,
  serviceName: string,
): Promise<ServingImage | null> {
  const revision = await findCurrentRevision(run, projectId, region, serviceName);
  if (!revision) return null;
  const r = await run([
    "run",
    "revisions",
    "describe",
    revision,
    "--region",
    region,
    "--project",
    projectId,
    "--format=json",
  ]);
  if (!r.ok) return null;
  let parsed: {
    spec?: { containers?: { image?: unknown }[] };
    status?: { imageDigest?: unknown };
  };
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const digestOf = (ref: unknown): string | null =>
    typeof ref === "string" ? (PINNED_DIGEST.exec(ref.trim())?.[1] ?? null) : null;
  const image: ServingImage = {
    deployedDigest: digestOf(parsed.spec?.containers?.[0]?.image),
    resolvedDigest: digestOf(parsed.status?.imageDigest),
  };
  return servingImageDigests(image).length > 0 ? image : null;
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
