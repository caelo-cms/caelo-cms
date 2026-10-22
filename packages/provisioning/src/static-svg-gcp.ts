// SPDX-License-Identifier: MPL-2.0

/**
 * #891 — backfill of the `gcp` stack's live SVG objects, run by the converge
 * (`ensureStackInvariants`, stack-converge.ts) on every upgrade.
 *
 * On GCS the publisher stores every SVG with `Content-Disposition:
 * attachment` (admin-core `gcsObjectMetadata` says why that, not a CSP), but
 * the hash-skip never rewrites an unchanged object, and Cloud CDN keeps the
 * responses it cached for up to a year (`STATIC_CDN_POLICY.maxTtl`). So the
 * converge patches every live SVG that lacks the header and, when it patched
 * any, invalidates the CDN cache once so the edge stops serving the old
 * responses. A second run finds nothing to patch and purges nothing.
 *
 * Failures warn instead of aborting the upgrade: the publisher's
 * CACHE_POLICY_VERSION bump rewrites every object on the next Publish live
 * anyway, and the report names what is left to do.
 */

import type { GcloudRunner } from "./gcloud-retry.js";
import { gcpBucketName, gcpNamePrefix } from "./gcp-names.js";
import type { InstallTarget, InvariantOutcome } from "./stack-converge.js";

/** `gcloud storage objects update` takes many URLs; keep each argv bounded. */
const UPDATE_BATCH = 100;

/** gcloud's answer when a wildcard matches nothing (an install with no SVGs). */
const NO_MATCH = /matched no objects|No URLs matched|One or more URLs matched no/i;

/** One object of `gcloud storage objects list --format=json` (standardised keys). */
interface ListedObject {
  readonly storage_url?: unknown;
  readonly content_disposition?: unknown;
}

/**
 * The `gs://…` URLs in `listJson` (gcloud's standardised object listing)
 * that are not yet served as downloads.
 *
 * @throws when the output is not the JSON list gcloud prints.
 */
export function svgObjectsMissingDisposition(listJson: string): string[] {
  const parsed = JSON.parse(listJson.trim() === "" ? "[]" : listJson) as unknown;
  if (!Array.isArray(parsed)) throw new Error("the object listing is not a JSON list");
  const out: string[] = [];
  for (const o of parsed as ListedObject[]) {
    if (typeof o.storage_url !== "string") {
      throw new Error("an object in the listing has no storage_url");
    }
    if (o.content_disposition !== "attachment") out.push(o.storage_url);
  }
  return out;
}

/** Patch the live SVGs of a `gcp` install and purge the CDN when any changed. */
export async function ensureSvgDownloads(
  install: InstallTarget,
  run: GcloudRunner,
): Promise<InvariantOutcome> {
  const bucket = gcpBucketName(install.projectId, install.env, "static");
  const base = {
    id: `SVGs in gs://${bucket} served as downloads`,
    onFailure: "warn" as const,
    why: "an uploaded SVG opened on the live site downloads instead of running script on the site's origin (#891)",
  };
  const project = `--project=${install.projectId}`;
  const failed = (error: string): InvariantOutcome => ({
    ...base,
    status: "failed",
    error: `${error}\n    The next Publish live rewrites every SVG with the header; purge the CDN afterwards (gcloud compute url-maps invalidate-cdn-cache <url-map> --path="/*" --global).`,
  });

  const list = await run([
    "storage",
    "objects",
    "list",
    `gs://${bucket}/**.svg`,
    project,
    "--format=json",
  ]);
  if (!list.ok) {
    return NO_MATCH.test(list.stderr)
      ? { ...base, status: "present" }
      : failed(`list SVG objects: ${list.stderr.trim()}`);
  }
  let pending: string[];
  try {
    pending = svgObjectsMissingDisposition(list.stdout);
  } catch (e) {
    return failed(`list SVG objects: ${(e as Error).message}`);
  }
  if (pending.length === 0) return { ...base, status: "present" };

  for (let i = 0; i < pending.length; i += UPDATE_BATCH) {
    const update = await run([
      "storage",
      "objects",
      "update",
      ...pending.slice(i, i + UPDATE_BATCH),
      "--content-disposition=attachment",
      project,
    ]);
    if (!update.ok) return failed(`set Content-Disposition: ${update.stderr.trim()}`);
  }

  // The edge still holds the old responses. One site-wide purge: SVGs sit
  // under many paths, and this only runs when objects were just patched.
  const maps = await run([
    "compute",
    "url-maps",
    "list",
    "--global",
    project,
    `--filter=name~^${gcpNamePrefix(install.env)}-url-map`,
    "--format=value(name)",
  ]);
  const urlMap = maps.ok ? maps.stdout.trim().split("\n")[0]?.trim() : "";
  if (!urlMap) {
    return failed(
      `patched ${pending.length} SVG(s), but found no URL map to purge: ${maps.ok ? "none listed" : maps.stderr.trim()}`,
    );
  }
  const purge = await run([
    "compute",
    "url-maps",
    "invalidate-cdn-cache",
    urlMap,
    "--path=/*",
    "--global",
    "--async",
    project,
    "--quiet",
  ]);
  if (!purge.ok) {
    return failed(
      `patched ${pending.length} SVG(s), but the CDN purge failed: ${purge.stderr.trim()}`,
    );
  }
  return { ...base, status: "applied" };
}
