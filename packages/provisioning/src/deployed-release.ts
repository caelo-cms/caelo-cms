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
import {
  CLOUD_RUN_SLUGS,
  type CloudRunSlug,
  cloudRunServicePrefix,
  type GcpProvider,
  RETIRED_SERVICE_ENV,
  SERVICE_IMAGE_NAMES,
  SERVICE_SECRET_ENV,
  type ServiceImageName,
} from "./stack-contract.js";
import { liveContainerEnv } from "./stack-converge.js";

/** The `sha256:…` digest an image reference pins, or null for a tag reference. */
export function digestFromImageRef(ref: string): string | null {
  return ref.trim().match(/@(sha256:[0-9a-f]{64})$/)?.[1] ?? null;
}

/** The single deployed Cloud Run service playing `slug` (stack-contract.ts cloudRunServicePrefix). */
async function findDeployedService(
  run: GcloudRunner,
  opts: { provider: GcpProvider; projectId: string; region: string },
  slug: CloudRunSlug,
): Promise<{ ok: true; name: string } | { ok: false; error: string; missing: boolean }> {
  const prefix = cloudRunServicePrefix(opts.provider, GCP_STACK_ENV, slug);
  const list = await run([
    "run",
    "services",
    "list",
    `--region=${opts.region}`,
    `--project=${opts.projectId}`,
    `--filter=metadata.name~^${prefix}`,
    "--format=value(metadata.name)",
  ]);
  if (!list.ok)
    return { ok: false, error: `list Cloud Run services: ${list.stderr.trim()}`, missing: false };
  const names = list.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length !== 1) {
    return {
      ok: false,
      error:
        names.length === 0
          ? `no ${prefix}* Cloud Run service: the install runs a release from before it (the ${slug} became its own service in #1328). Run \`upgrade\` first: it creates the service and moves the release over.`
          : `expected one ${prefix}* Cloud Run service, found ${names.join(", ")}`,
      missing: names.length === 0,
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
 * gateway from before #613 or #635: its release needs a cms_admin pool
 * (admin_role, then gateway_role) the current contract no longer gives it —
 * it still carries the retired database vars.
 * Such an install has to go through `upgrade` first, which moves the image
 * and the env in one revision.
 */
export async function checkDeployedRuntimeEnv(opts: {
  provider: GcpProvider;
  projectId: string;
  region: string;
  run?: GcloudRunner;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = opts.run ?? defaultGcloud;
  for (const slug of CLOUD_RUN_SLUGS) {
    const found = await findDeployedService(run, opts, slug);
    // #1330 — the staging gateway is the CLI's (staging-gateway-setup.ts):
    // an install from before it gets it after this `up`, so a missing one
    // runs no release that could mismatch the env. The data gateway is
    // missing after a first `up` that withheld it (gateway-bootstrap.ts) and
    // a run that stopped before the next one; the same holds.
    if (!found.ok && (slug === "staging-gateway" || slug === "gateway") && found.missing) continue;
    if (!found.ok) return { ok: false, error: found.error };
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
    const missing = [
      ...Object.keys(SERVICE_SECRET_ENV[slug]).filter(
        (name) => name.endsWith("_PASSWORD") && env.get(name)?.kind !== "secret",
      ),
      // A database var the contract retired (the gateway's ADMIN_* before
      // #613, its GATEWAY_* before #635) means the running release still
      // needs that login.
      ...RETIRED_SERVICE_ENV[slug].filter((name) => /DATABASE/.test(name) && env.has(name)),
    ];
    if (missing.length > 0) {
      return {
        ok: false,
        error: `${found.name} does not match the current database env (${missing.join(", ")}) — its release predates it (Secret Manager runtime secrets; for the gateway, its own database login, #613/#635). Run \`upgrade\` first: it moves the release and its env over together. Re-running the installer now would give the running release a database env it can't connect with.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Read the image digests the Cloud Run services run. Fails, naming
 * what is missing, when a service can't be found unambiguously or doesn't
 * run a digest-pinned image.
 */
export async function readDeployedImageDigests(opts: {
  provider: GcpProvider;
  projectId: string;
  region: string;
  run?: GcloudRunner;
}): Promise<{ ok: true; digests: ImageDigests } | { ok: false; error: string }> {
  const run = opts.run ?? defaultGcloud;
  const digests: Record<ServiceImageName, string> = {
    admin: "",
    gateway: "",
    "mcp-auth-proxy": "",
  };
  const digestOf = async (
    slug: CloudRunSlug,
  ): Promise<{ ok: true; digest: string } | { ok: false; error: string; missing: boolean }> => {
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
    if (!image.ok) {
      return { ok: false, error: `describe ${found.name}: ${image.stderr.trim()}`, missing: false };
    }
    const digest = digestFromImageRef(image.stdout);
    if (!digest) {
      return {
        ok: false,
        error: `${found.name} runs '${image.stdout.trim()}', which is not pinned to a digest`,
        missing: false,
      };
    }
    return { ok: true, digest };
  };
  // One digest per release image.
  for (const slug of SERVICE_IMAGE_NAMES) {
    const d = await digestOf(slug);
    if (!d.ok) return { ok: false, error: d.error };
    digests[slug] = d.digest;
  }
  // #1330 — the staging gateway runs the gateway's image and rolls with it:
  // one that runs another image means the services serve two releases, and
  // the wizard must not record (or deploy) either as "the" release. An
  // install from before it has none yet (the CLI creates it after `up`).
  const staging = await digestOf("staging-gateway");
  if (!staging.ok && !staging.missing) return { ok: false, error: staging.error };
  if (staging.ok && staging.digest !== digests.gateway) {
    return {
      ok: false,
      error: `the staging gateway runs ${staging.digest}, but the gateway runs ${digests.gateway}: the two must run the same release image. Run \`upgrade\` first — it rolls both onto one release — then re-run the installer.`,
    };
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
  if (opts.recorded && !opts.recorded["mcp-auth-proxy"]) {
    // #1328 — the release it records predates the MCP-Auth-Proxy: this
    // installer's stack would deploy a proxy image of another release.
    return {
      ok: false,
      error:
        "This install runs a release from before the MCP-Auth-Proxy (its install.json records no mcp-auth-proxy image). Run `upgrade` first — it sets the proxy up and records the release — then re-run the installer.",
    };
  }
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
