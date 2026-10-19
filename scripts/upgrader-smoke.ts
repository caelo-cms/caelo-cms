#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * The real-GCP upgrader smoke test (#818): install a release candidate on
 * a dedicated smoke install with that install's OWN upgrader job, and
 * check that it really serves afterwards. Driven by
 * `.github/workflows/upgrader-smoke.yml`; setup in docs/dev/upgrader-smoke.md.
 *
 * Why real GCP: the first live in-app update died at its first bucket write
 * on an IAM condition no fake could have caught (#799), and the gateway of
 * v0.10.51 exited on start only on Cloud Run (#821). So this drives the
 * real job — its image, its service account and IAM self-check, the
 * backup, the migration job on Direct VPC egress, the roll and the deep
 * health check — and then asserts from the outside:
 *
 *   - install.json in the ops bucket records the candidate and the signed
 *     manifest's admin + gateway digests;
 *   - the revisions serving traffic run exactly those images and the
 *     services are Ready (the images booted on Cloud Run);
 *   - the upgrader job moved itself onto the candidate's ops image.
 *
 * Which update is tested. The smoke install rides the release train: every
 * release tag (candidate and stable) is installed on it in order, so the
 * first candidate of a cycle goes from the previous stable release N-1,
 * later candidates from the candidate before. When the install is behind
 * N-1 it is first brought to N-1 (that run is an upgrader test too); when
 * it is AHEAD of the candidate the run fails and says how to reset it.
 * Re-running for a candidate that is already installed only re-checks.
 *
 *   bun scripts/upgrader-smoke.ts --candidate 0.11.0-rc.1 \
 *     --project-id caelo-upgrader-smoke --region europe-west1 [--dry-run]
 *       --dry-run reads and verifies everything, prints the plan and the
 *       commands, and requests nothing.
 *
 *   bun scripts/upgrader-smoke.ts --candidate 0.11.0-rc.1 --installed 0.10.53
 *       No cloud at all: print the plan for an install that runs 0.10.53.
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
/** The provisioning CLI of this checkout (`cms-provision`). */
const PROVISIONING_CLI = resolve(REPO_ROOT, "packages", "provisioning", "src", "cli.ts");

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

/** What the run will do. */
export type SmokePlan =
  | { readonly kind: "install"; readonly versions: readonly string[]; readonly note: string }
  | { readonly kind: "verify-only"; readonly note: string }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * Plan the smoke run for an install that runs `installed`.
 *
 * @param previous the newest stable release before the candidate (N-1)
 */
export function planSmoke(input: {
  readonly installed: string;
  readonly previous: string | null;
  readonly candidate: string;
}): SmokePlan {
  const { installed, previous, candidate } = input;
  if (installed === candidate) {
    return {
      kind: "verify-only",
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
      kind: "install",
      versions: [previous, candidate],
      note: `The smoke install runs ${installed}, behind the previous release ${previous}: installing ${previous} first, then ${candidate} (${previous} → ${candidate} is the update under test).`,
    };
  }
  return {
    kind: "install",
    versions: [candidate],
    note:
      previous === null || installed === previous
        ? `Testing ${installed} → ${candidate}.`
        : `Testing ${installed} → ${candidate} (the release train: ${installed} is after the previous stable release ${previous}).`,
  };
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

/** `cms-provision request-update … --wait` from this checkout; resolves to its exit code. */
function requestUpdate(version: string, projectId: string, region: string): number {
  const r = spawnSync(
    // The Bun running this script, so the CLI runs on the same pinned version.
    process.execPath,
    [
      PROVISIONING_CLI,
      "request-update",
      "--version",
      version,
      "--project-id",
      projectId,
      "--region",
      region,
      "--wait",
    ],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  return r.status ?? 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const candidate = flag(argv, "candidate")?.replace(/^v/, "");
  if (!candidate || !SEMVER.test(candidate)) {
    console.error("Usage: bun scripts/upgrader-smoke.ts --candidate <x.y.z[-rc.n]> …");
    return 2;
  }
  const previous = previousStable(releaseTags(), candidate);
  const offline = flag(argv, "installed");
  if (offline) {
    console.log(JSON.stringify(planSmoke({ installed: offline, previous, candidate }), null, 2));
    return 0;
  }
  const projectId = flag(argv, "project-id");
  const region = flag(argv, "region");
  if (!projectId || !region) {
    console.error("upgrader-smoke: --project-id and --region are required.");
    return 2;
  }
  const dryRun = argv.includes("--dry-run");
  const run: GcloudRunner = gcloud;

  // The candidate must be a signed release before anything is asked of the install.
  const manifest = await fetchVerifiedReleaseManifest(candidate);
  if (!manifest.ok) {
    console.error(
      `upgrader-smoke: the manifest of ${candidate} does not verify: ${manifest.error.message}`,
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
  const plan = planSmoke({ installed: install.releaseVersion, previous, candidate });
  console.log(`Previous stable release: ${previous ?? "none"}; candidate: ${candidate}.`);
  if (plan.kind === "refuse") {
    console.error(`upgrader-smoke: ${plan.reason}`);
    return 1;
  }
  console.log(plan.note);
  if (plan.kind === "install") {
    for (const v of plan.versions) {
      const cmd = `cms-provision request-update --version ${v} --project-id ${projectId} --region ${region} --wait`;
      if (dryRun) {
        console.log(`[dry-run] would run: ${cmd}`);
        continue;
      }
      console.log(`::group::${cmd}`);
      const code = requestUpdate(v, projectId, region);
      console.log("::endgroup::");
      if (code !== 0) {
        console.error(
          `upgrader-smoke: installing ${v} on the smoke install failed (exit ${code}).`,
        );
        return 1;
      }
    }
    if (dryRun) return 0;
  }
  const failures = smokeFailures(manifest.manifest, await observe(run, projectId, region));
  if (failures.length > 0) {
    for (const f of failures) console.error(`upgrader-smoke: ${f}`);
    return 1;
  }
  console.log(
    `Upgrader smoke test passed: ${candidate} serves on ${projectId} (admin ${manifest.manifest.digests.admin.slice(0, 19)}…, gateway ${manifest.manifest.digests.gateway.slice(0, 19)}…), and the upgrader moved onto its ops image.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
