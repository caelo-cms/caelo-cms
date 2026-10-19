#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * The real-GCP upgrader smoke test (#818): every release is installed on a
 * dedicated smoke install by that install's OWN upgrader job, started the
 * only way any install starts it — Settings → Updates, one click + the
 * Owner's password. There is no side channel (no operator endpoint, no
 * CLI request): the maintainer decided every release installs through
 * that one path, so the smoke test checks what that path produced and
 * never starts an update itself. Driven by
 * `.github/workflows/upgrader-smoke.yml`; setup in docs/dev/upgrader-smoke.md.
 *
 * Why real GCP: the first live in-app update died at its first bucket write
 * on an IAM condition no fake could have caught (#799), and the gateway of
 * v0.10.51 exited on start only on Cloud Run (#821). What a passing check
 * asserts, from the outside, for a release R:
 *
 *   - install.json in the ops bucket records R and the signed manifest's
 *     admin + gateway digests;
 *   - the revisions serving traffic run exactly those images and the
 *     services are Ready (the images booted on Cloud Run);
 *   - the upgrader job moved itself onto R's ops image (its last step).
 *
 * Two modes:
 *
 *   --mode gate    (release.yml, before npm + the GitHub Release): a tag is
 *                  not offered in Settings → Updates until it is published,
 *                  so it cannot be installed yet. The gate checks that the
 *                  smoke install cleanly serves the release before it, at
 *                  least the previous stable release N-1 — i.e. that N-1
 *                  WAS installed through Settings → Updates and verified —
 *                  and that the candidate's manifest verifies. A release
 *                  cannot ship while its predecessor never went through the
 *                  real in-app path.
 *   --mode verify  (by hand, after the maintainer installed the published
 *                  release on the smoke install via Settings → Updates):
 *                  the install must run the release and serve it cleanly.
 *
 *   bun scripts/upgrader-smoke.ts --candidate 0.11.0 --mode gate \
 *     --project-id caelo-upgrader-smoke --region europe-west1
 *
 *   bun scripts/upgrader-smoke.ts --candidate 0.11.0 --installed 0.10.53
 *       No cloud at all: print the gate's plan for an install on 0.10.53.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { gcloud } from "../packages/provisioning/src/gcloud.ts";
import type { GcloudRunner } from "../packages/provisioning/src/gcloud-retry.ts";
import {
  GCP_STACK_ENV,
  gcpNamePrefix,
  upgraderJobName,
} from "../packages/provisioning/src/gcp-names.ts";
import type { InstallMetadata } from "../packages/provisioning/src/install-state.ts";
import {
  fetchVerifiedReleaseManifest,
  type ReleaseManifest,
} from "../packages/provisioning/src/release-manifest.ts";
import { opsBucketName } from "../packages/provisioning/src/state-backend.ts";
import {
  findServingImage,
  resolveGcpResourceName,
  servingImageDigests,
} from "../packages/provisioning/src/upgrade/gcp-lookup.ts";
import { releaseImageRef } from "../packages/provisioning/src/upgrade/release-images.ts";
import { isNewerVersion } from "../packages/shared/src/version.ts";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * The newest stable release below `candidate`, from git tags (`v0.10.53`).
 * Stable = no pre-release part. Null when there is none.
 */
export function previousStable(tags: readonly string[], candidate: string): string | null {
  let best: string | null = null;
  for (const tag of tags) {
    const v = tag.trim().replace(/^v/, "");
    const m = SEMVER.exec(v);
    if (!m || m[4] !== undefined) continue;
    if (!isNewerVersion(candidate, v)) continue;
    if (best === null || isNewerVersion(v, best)) best = v;
  }
  return best;
}

/** Which smoke check runs. */
export type SmokeMode = "gate" | "verify";

/** What the run will check. */
export type SmokePlan =
  /** Check that the smoke install cleanly serves `version`. */
  | { readonly kind: "check"; readonly version: string; readonly note: string }
  | { readonly kind: "refuse"; readonly reason: string };

const VIA_SETTINGS =
  "install it on the smoke install through Settings → Updates (one click + the Owner's password), run the upgrader-smoke workflow with mode `verify` for it";

/**
 * Plan the smoke run for an install that runs `installed`.
 *
 * @param previous the newest stable release before the candidate (N-1)
 */
export function planSmoke(input: {
  readonly installed: string;
  readonly previous: string | null;
  readonly candidate: string;
  readonly mode: SmokeMode;
}): SmokePlan {
  const { installed, previous, candidate, mode } = input;
  if (mode === "verify") {
    if (installed === candidate) {
      return {
        kind: "check",
        version: candidate,
        note: `The smoke install runs ${candidate}; checking that it serves it.`,
      };
    }
    return {
      kind: "refuse",
      reason: `The smoke install runs ${installed}, not ${candidate}. ${capitalise(VIA_SETTINGS)} again.`,
    };
  }
  if (installed === candidate) {
    return {
      kind: "check",
      version: candidate,
      note: `The smoke install already runs ${candidate}; checking that it serves it (a re-run).`,
    };
  }
  if (isNewerVersion(installed, candidate)) {
    return {
      kind: "refuse",
      reason: `The smoke install runs ${installed}, which is newer than ${candidate}; an upgrader cannot go back. Reset the smoke install to ${previous ?? "the previous release"} (docs/dev/upgrader-smoke.md, "Reset"), then run again.`,
    };
  }
  if (previous && isNewerVersion(previous, installed)) {
    return {
      kind: "refuse",
      reason: `The smoke install runs ${installed}, behind the previous release ${previous}: ${previous} never went through the real in-app update. ${capitalise(VIA_SETTINGS)}, then re-run this release.`,
    };
  }
  return {
    kind: "check",
    version: installed,
    note: `The smoke install runs ${installed}; checking that it serves it cleanly before ${candidate} ships. Once ${candidate} is published, ${VIA_SETTINGS}.`,
  };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What was observed on the smoke install after the run. */
export interface SmokeObservation {
  readonly install: InstallMetadata | null;
  /** Every digest each serving revision is known by. */
  readonly serving: { readonly admin: readonly string[]; readonly gateway: readonly string[] };
  /** Ready condition of each service. */
  readonly ready: { readonly admin: boolean; readonly gateway: boolean };
  /** The upgrader job's container image. */
  readonly upgraderImage: string | null;
}

/** Every way the smoke install does not serve `manifest`'s release. Empty means pass. */
export function smokeFailures(manifest: ReleaseManifest, seen: SmokeObservation): string[] {
  const out: string[] = [];
  const v = manifest.version;
  if (!seen.install) out.push("install.json is missing from the ops bucket");
  else {
    if (seen.install.releaseVersion !== v) {
      out.push(`install.json records ${seen.install.releaseVersion ?? "no release"}, not ${v}`);
    }
    for (const slug of ["admin", "gateway"] as const) {
      if (seen.install.imageDigests?.[slug] !== manifest.digests[slug]) {
        out.push(
          `install.json records ${slug} ${seen.install.imageDigests?.[slug] ?? "none"}, not ${manifest.digests[slug]}`,
        );
      }
    }
  }
  for (const slug of ["admin", "gateway"] as const) {
    if (!seen.serving[slug].includes(manifest.digests[slug])) {
      out.push(
        `the ${slug} revision serving traffic runs ${seen.serving[slug].join(" / ") || "an unreadable image"}, not ${manifest.digests[slug]}`,
      );
    }
    if (!seen.ready[slug]) out.push(`the ${slug} service is not Ready`);
  }
  const ops = releaseImageRef("ops", manifest.digests.ops);
  if (seen.upgraderImage !== ops) {
    out.push(`the upgrader job runs ${seen.upgraderImage ?? "an unreadable image"}, not ${ops}`);
  }
  return out;
}

/** Whether `gcloud run services describe --format=json` reports Ready=True. */
export function serviceReady(serviceJson: string): boolean {
  try {
    const d = JSON.parse(serviceJson) as {
      status?: { conditions?: { type?: string; status?: string }[] };
    };
    return d.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;
  } catch {
    return false;
  }
}

/** Parse `--name value` flags. */
function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

async function readInstall(run: GcloudRunner, projectId: string): Promise<InstallMetadata | null> {
  const r = await run(["storage", "cat", `gs://${opsBucketName(projectId)}/install/install.json`]);
  if (!r.ok) {
    if (/matched no objects|not found|404/i.test(r.stderr)) return null;
    throw new Error(`read install.json of ${projectId}: ${r.stderr.trim()}`);
  }
  return JSON.parse(r.stdout) as InstallMetadata;
}

async function observe(
  run: GcloudRunner,
  projectId: string,
  region: string,
): Promise<SmokeObservation> {
  const serving = { admin: [] as string[], gateway: [] as string[] };
  const ready = { admin: false, gateway: false };
  for (const slug of ["admin", "gateway"] as const) {
    const prefix = `${gcpNamePrefix(GCP_STACK_ENV)}-${slug}`;
    const service = await resolveGcpResourceName(run, "run-service", prefix, projectId, region);
    if (!service) continue;
    const image = await findServingImage(run, projectId, region, service);
    serving[slug] = image ? servingImageDigests(image) : [];
    const d = await run([
      "run",
      "services",
      "describe",
      service,
      `--region=${region}`,
      `--project=${projectId}`,
      "--format=json",
    ]);
    ready[slug] = d.ok && serviceReady(d.stdout);
  }
  const job = await run([
    "run",
    "jobs",
    "describe",
    upgraderJobName(GCP_STACK_ENV),
    `--region=${region}`,
    `--project=${projectId}`,
    "--format=value(spec.template.spec.template.spec.containers[0].image)",
  ]);
  return {
    install: await readInstall(run, projectId),
    serving,
    ready,
    upgraderImage: job.ok ? job.stdout.trim() || null : null,
  };
}

function releaseTags(): string[] {
  const r = spawnSync("git", ["tag", "--list", "v*"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git tag --list: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
}

async function main(argv: readonly string[]): Promise<number> {
  const candidate = flag(argv, "candidate")?.replace(/^v/, "");
  if (!candidate || !SEMVER.test(candidate)) {
    console.error(
      "Usage: bun scripts/upgrader-smoke.ts --candidate <x.y.z[-rc.n]> --mode gate|verify …",
    );
    return 2;
  }
  const modeFlag = flag(argv, "mode") ?? "gate";
  if (modeFlag !== "gate" && modeFlag !== "verify") {
    console.error(`upgrader-smoke: --mode is gate or verify, not ${modeFlag}.`);
    return 2;
  }
  const mode: SmokeMode = modeFlag;
  const previous = previousStable(releaseTags(), candidate);
  const offline = flag(argv, "installed");
  if (offline) {
    console.log(
      JSON.stringify(planSmoke({ installed: offline, previous, candidate, mode }), null, 2),
    );
    return 0;
  }
  const projectId = flag(argv, "project-id");
  const region = flag(argv, "region");
  if (!projectId || !region) {
    console.error("upgrader-smoke: --project-id and --region are required.");
    return 2;
  }
  const run: GcloudRunner = gcloud;

  // The candidate must be a signed release before anything is judged.
  const candidateManifest = await fetchVerifiedReleaseManifest(candidate);
  if (!candidateManifest.ok) {
    console.error(
      `upgrader-smoke: the manifest of ${candidate} does not verify: ${candidateManifest.error.message}`,
    );
    return 1;
  }
  const install = await readInstall(run, projectId);
  if (!install?.releaseVersion) {
    console.error(
      `upgrader-smoke: gs://${opsBucketName(projectId)}/install/install.json names no release; is ${projectId} a Caelo install whose state lives in its project? (docs/dev/upgrader-smoke.md)`,
    );
    return 1;
  }
  const plan = planSmoke({ installed: install.releaseVersion, previous, candidate, mode });
  console.log(
    `Previous stable release: ${previous ?? "none"}; candidate: ${candidate}; mode: ${mode}.`,
  );
  if (plan.kind === "refuse") {
    console.error(`upgrader-smoke: ${plan.reason}`);
    return 1;
  }
  console.log(plan.note);
  const checked =
    plan.version === candidate
      ? candidateManifest
      : await fetchVerifiedReleaseManifest(plan.version);
  if (!checked.ok) {
    console.error(
      `upgrader-smoke: the manifest of ${plan.version} (the release the smoke install runs) does not verify: ${checked.error.message}`,
    );
    return 1;
  }
  const failures = smokeFailures(checked.manifest, await observe(run, projectId, region));
  if (failures.length > 0) {
    for (const f of failures) console.error(`upgrader-smoke: ${f}`);
    console.error(
      `upgrader-smoke: the smoke install does not cleanly serve ${plan.version}. Its update timeline is under Settings → Updates on the smoke install (docs/dev/upgrader-smoke.md, "When it fails").`,
    );
    return 1;
  }
  console.log(
    `Upgrader smoke check passed: ${plan.version} serves on ${projectId} (admin ${checked.manifest.digests.admin.slice(0, 19)}…, gateway ${checked.manifest.digests.gateway.slice(0, 19)}…), and the upgrader runs its ops image.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
