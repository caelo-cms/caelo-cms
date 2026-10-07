// SPDX-License-Identifier: MPL-2.0

/**
 * The release a deployed GCP install runs, read from its Cloud Run services.
 *
 * Installs created before `install.json` recorded `imageDigests` have no
 * other trustworthy record: `upgrade` rolled them through gcloud without
 * touching the Pulumi stack config, so the config may name an older release.
 * The wizard reads the live services instead, so re-running it on such an
 * install keeps what runs rather than rolling to `:latest` without the
 * migrations `upgrade` would run first.
 */

import { gcloud as defaultGcloud } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import { GCP_STACK_ENV, gcpNamePrefix } from "./gcp-names.js";
import type { ImageDigests } from "./install-state.js";

/** The `sha256:…` digest an image reference pins, or null for a tag reference. */
export function digestFromImageRef(ref: string): string | null {
  return ref.trim().match(/@(sha256:[0-9a-f]{64})$/)?.[1] ?? null;
}

/**
 * Read the image digests the admin and gateway services run. Fails, naming
 * what is missing, when a service can't be found unambiguously or doesn't
 * run a digest-pinned image.
 */
export async function readDeployedImageDigests(opts: {
  projectId: string;
  region: string;
  run?: GcloudRunner;
}): Promise<{ ok: true; digests: ImageDigests } | { ok: false; error: string }> {
  const run = opts.run ?? defaultGcloud;
  const project = `--project=${opts.projectId}`;
  const region = `--region=${opts.region}`;
  const digests = { admin: "", gateway: "" };
  for (const slug of ["admin", "gateway"] as const) {
    const prefix = `${gcpNamePrefix(GCP_STACK_ENV)}-${slug}`;
    const list = await run([
      "run",
      "services",
      "list",
      region,
      project,
      `--filter=metadata.name~^${prefix}`,
      "--format=value(metadata.name)",
    ]);
    if (!list.ok) return { ok: false, error: `list Cloud Run services: ${list.stderr.trim()}` };
    const names = list.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length !== 1) {
      return {
        ok: false,
        error: `expected one ${prefix}* Cloud Run service, found ${names.length === 0 ? "none" : names.join(", ")}`,
      };
    }
    const image = await run([
      "run",
      "services",
      "describe",
      names[0] as string,
      region,
      project,
      "--format=value(spec.template.spec.containers[0].image)",
    ]);
    if (!image.ok) return { ok: false, error: `describe ${names[0]}: ${image.stderr.trim()}` };
    const digest = digestFromImageRef(image.stdout);
    if (!digest) {
      return {
        ok: false,
        error: `${names[0]} runs '${image.stdout.trim()}', which is not pinned to a digest`,
      };
    }
    digests[slug] = digest;
  }
  return { ok: true, digests };
}

/** Where the digests a wizard run deploys come from. */
export type DigestChoice =
  | {
      readonly ok: true;
      readonly source: "recorded" | "live" | "latest";
      readonly digests: ImageDigests;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Pick the release a wizard run deploys. A re-run never changes versions —
 * that is `upgrade`'s job, which migrates the database before shifting
 * traffic:
 *
 *   - digests recorded in install.json win;
 *   - an install that was provisioned (`deployed`) but predates the record
 *     keeps what its services run;
 *   - only a new install resolves the floating release tag.
 */
export async function chooseImageDigests(opts: {
  readonly recorded: ImageDigests | null;
  readonly deployed: boolean;
  readonly readLive: () => ReturnType<typeof readDeployedImageDigests>;
  readonly resolveLatest: () => Promise<ImageDigests>;
}): Promise<DigestChoice> {
  if (opts.recorded) return { ok: true, source: "recorded", digests: opts.recorded };
  if (!opts.deployed) return { ok: true, source: "latest", digests: await opts.resolveLatest() };
  const live = await opts.readLive();
  if (!live.ok) {
    return {
      ok: false,
      error: `This install was provisioned before the release it runs was recorded, and the running release can't be read (${live.error}). Run \`upgrade\` once — it records the release it rolls to — then re-run the installer.`,
    };
  }
  return { ok: true, source: "live", digests: live.digests };
}
