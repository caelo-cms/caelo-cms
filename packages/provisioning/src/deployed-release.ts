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
import { type CloudRunSlug, SERVICE_SECRET_ENV } from "./stack-contract.js";
import { liveContainerEnv } from "./stack-converge.js";

/** The `sha256:…` digest an image reference pins, or null for a tag reference. */
export function digestFromImageRef(ref: string): string | null {
  return ref.trim().match(/@(sha256:[0-9a-f]{64})$/)?.[1] ?? null;
}

/** The single deployed (Pulumi-suffixed) Cloud Run service for `slug`. */
async function findDeployedService(
  run: GcloudRunner,
  opts: { projectId: string; region: string },
  slug: CloudRunSlug,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const prefix = `${gcpNamePrefix(GCP_STACK_ENV)}-${slug}`;
  const list = await run([
    "run",
    "services",
    "list",
    `--region=${opts.region}`,
    `--project=${opts.projectId}`,
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
  return { ok: true, name: names[0] as string };
}

/**
 * Whether the deployed services already run on the Secret Manager runtime
 * env (password-less database URLs + `*_PASSWORD` secret references).
 *
 * The stacks deploy that env; a release from before it can't use it (it
 * reads the password from the URL). The wizard keeps the release an install
 * runs, so re-running it on an install `upgrade` hasn't moved over yet would
 * pair the old release with env it can't connect with. The same holds for a
 * gateway from before #613: its release needs the admin_role pool the
 * current contract no longer gives it (no GATEWAY_DATABASE_PASSWORD yet).
 * Such an install has to go through `upgrade` first, which moves the image
 * and the env in one revision.
 */
export async function checkDeployedRuntimeEnv(opts: {
  projectId: string;
  region: string;
  run?: GcloudRunner;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = opts.run ?? defaultGcloud;
  for (const slug of ["admin", "gateway"] as const) {
    const found = await findDeployedService(run, opts, slug);
    if (!found.ok) return found;
    const describe = await run([
      "run",
      "services",
      "describe",
      found.name,
      `--region=${opts.region}`,
      `--project=${opts.projectId}`,
      "--format=json",
    ]);
    if (!describe.ok) {
      return { ok: false, error: `describe ${found.name}: ${describe.stderr.trim()}` };
    }
    const env = liveContainerEnv(describe.stdout);
    const missing = Object.keys(SERVICE_SECRET_ENV[slug]).filter(
      (name) => name.endsWith("_PASSWORD") && env.get(name)?.kind !== "secret",
    );
    if (missing.length > 0) {
      return {
        ok: false,
        error: `${found.name} does not read ${missing.join(", ")} from Secret Manager — its release predates the current database env (Secret Manager runtime secrets; for the gateway, its own database logins, #613). Run \`upgrade\` first: it moves the release and its env over together. Re-running the installer now would give the running release a database env it can't connect with.`,
      };
    }
  }
  return { ok: true };
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
  const digests = { admin: "", gateway: "" };
  for (const slug of ["admin", "gateway"] as const) {
    const found = await findDeployedService(run, opts, slug);
    if (!found.ok) return found;
    const image = await run([
      "run",
      "services",
      "describe",
      found.name,
      `--region=${opts.region}`,
      `--project=${opts.projectId}`,
      "--format=value(spec.template.spec.containers[0].image)",
    ]);
    if (!image.ok) return { ok: false, error: `describe ${found.name}: ${image.stderr.trim()}` };
    const digest = digestFromImageRef(image.stdout);
    if (!digest) {
      return {
        ok: false,
        error: `${found.name} runs '${image.stdout.trim()}', which is not pinned to a digest`,
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

/**
 * The region a deployed install's admin service runs in, read across all
 * regions, or null when no admin service exists (nothing deployed yet).
 * Used when install.json has no region recorded, so a re-run keeps the
 * install where it is instead of asking (#607). Fails when the services
 * can't be listed or the admin service exists in more than one region.
 */
export async function readDeployedRegion(opts: {
  projectId: string;
  run?: GcloudRunner;
}): Promise<{ ok: true; region: string | null } | { ok: false; error: string }> {
  const run = opts.run ?? defaultGcloud;
  const prefix = `${gcpNamePrefix(GCP_STACK_ENV)}-admin`;
  const list = await run([
    "run",
    "services",
    "list",
    `--project=${opts.projectId}`,
    `--filter=metadata.name~^${prefix}`,
    '--format=value(metadata.labels."cloud.googleapis.com/location")',
  ]);
  if (!list.ok) {
    return {
      ok: false,
      error: `list Cloud Run services to find the install's region: ${list.stderr.trim() || "no output"}`,
    };
  }
  const regions = [
    ...new Set(
      list.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (regions.length > 1) {
    return {
      ok: false,
      error: `${prefix}* Cloud Run services exist in several regions (${regions.join(", ")}); record the install's region in install.json ("region"), then re-run.`,
    };
  }
  return { ok: true, region: regions[0] ?? null };
}
