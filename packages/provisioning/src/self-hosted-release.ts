// SPDX-License-Identifier: MPL-2.0

/**
 * #696 Phase 4 — which Caelo release a self-hosted install runs, and how a
 * release becomes a pair of verified image digests.
 *
 * `.caelo/release.json` is the install metadata for self-hosted (the cloud
 * providers keep theirs in `~/.caelo-<id>/install.json`): the release
 * version, the digest-pinned admin + gateway image references the Compose
 * file runs, and a short history of installs/upgrades/rollbacks. It holds no
 * secrets (config.json does), so it is safe to read from tooling and
 * backups; writes refuse secret material like install.json's do.
 *
 * Every image reference that reaches the Compose file comes through
 * {@link resolveVerifiedRelease}: the tag is resolved to a digest in GHCR
 * (anonymously) and that digest — not the tag — is cosign-verified against
 * the Caelo release workflow identity. `init` and `upgrade` share it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoSecrets, writeJsonAtomic } from "./checkpoint-secrets.js";
import { ghcrImageDigest, ghcrImageRef, type ReleaseImages } from "./compose.js";
import { selfCommand } from "./self-command.js";
import {
  cosignVerifyArgv,
  GHCR_NAMESPACE,
  GHCR_REGISTRY,
  RELEASE_SERVICES,
  resolveRegistryDigest,
} from "./upgrade/release-images.js";

/** What a host command returned. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `docker` / `cosign` on the install's host. A seam so the install and
 * upgrade orchestration is unit-testable with a fake (no real containers).
 */
export interface HostRunner {
  /**
   * Run `argv` to completion. With `stdoutPath`, stdout streams into that
   * file (mode 600) instead of being captured — used for database dumps.
   * With `stdinPath`, that file is the process's stdin (restores); with
   * `stdinText`, that text is (secrets that must not appear in argv). With
   * `inherit`, stdout + stderr go to the terminal (long pulls and starts
   * the operator should watch) and come back empty.
   */
  run(argv: readonly string[], opts?: HostRunOptions): Promise<CommandResult>;
}

/** See {@link HostRunner.run}. */
export interface HostRunOptions {
  /** Extra environment variables on top of the CLI's own. */
  readonly env?: Readonly<Record<string, string>>;
  readonly stdoutPath?: string;
  readonly stdinPath?: string;
  readonly stdinText?: string;
  readonly inherit?: boolean;
}

/** The real runner: Bun.spawn; a missing binary is exit code 127, not a throw. */
export const bunHostRunner: HostRunner = {
  async run(argv, opts) {
    try {
      const proc = Bun.spawn([...argv], {
        ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
        stdin:
          opts?.stdinText !== undefined
            ? Buffer.from(opts.stdinText)
            : opts?.stdinPath
              ? Bun.file(opts.stdinPath)
              : "ignore",
        stdout: opts?.stdoutPath ? Bun.file(opts.stdoutPath) : opts?.inherit ? "inherit" : "pipe",
        stderr: opts?.inherit ? "inherit" : "pipe",
      });
      const stdout =
        opts?.stdoutPath || opts?.inherit
          ? ""
          : await new Response(proc.stdout as ReadableStream).text();
      const stderr = opts?.inherit ? "" : await new Response(proc.stderr as ReadableStream).text();
      return { exitCode: await proc.exited, stdout, stderr };
    } catch (e) {
      return { exitCode: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
  },
};

/** One install / upgrade / rollback of a self-hosted install. */
export interface ReleaseHistoryEntry {
  readonly at: string;
  readonly from: string | null;
  readonly to: string;
  readonly outcome: "installed" | "upgraded" | "rolled-back";
  readonly detail?: string;
}

/** `.caelo/release.json`. */
export interface SelfHostedRelease {
  /** The release tag the images were resolved from (e.g. `0.10.43`). */
  readonly version: string;
  readonly images: { readonly admin: string; readonly gateway: string };
  readonly installedAt: string;
  /** Newest last; capped at {@link HISTORY_LIMIT}. */
  readonly history: readonly ReleaseHistoryEntry[];
}

const HISTORY_LIMIT = 20;

export function releasePath(caeloDir: string): string {
  return join(caeloDir, "release.json");
}

/** The images of a recorded release, as the Compose generator takes them. */
export function releaseImages(release: SelfHostedRelease): ReleaseImages {
  return { mode: "release", admin: release.images.admin, gateway: release.images.gateway };
}

/**
 * The install's recorded release, or null when none is recorded (a dev-mode
 * install, or one created before #696 that still runs the repo bind mount).
 * Throws on a malformed record rather than running a guessed image.
 */
export function readRelease(caeloDir: string): SelfHostedRelease | null {
  const path = releasePath(caeloDir);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SelfHostedRelease>;
  const admin = raw.images?.admin ?? "";
  const gateway = raw.images?.gateway ?? "";
  if (
    typeof raw.version !== "string" ||
    !ghcrImageDigest("admin", admin) ||
    !ghcrImageDigest("gateway", gateway)
  ) {
    throw new Error(
      `${path} is malformed (needs version + digest-pinned ghcr.io/caelo-cms images); fix it or re-run \`${selfCommand("upgrade", "--version", "<x.y.z>")}\`.`,
    );
  }
  return {
    version: raw.version,
    images: { admin, gateway },
    installedAt: raw.installedAt ?? "",
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

/**
 * Record that the install now runs `images` of `version` (or, for a
 * rollback, keeps running the previous ones), appending to the history.
 */
export function recordRelease(
  caeloDir: string,
  next: { version: string; images: ReleaseImages },
  entry: Omit<ReleaseHistoryEntry, "at">,
  now: Date = new Date(),
): SelfHostedRelease {
  const prior = readRelease(caeloDir);
  const at = now.toISOString();
  const record: SelfHostedRelease = {
    version: next.version,
    images: { admin: next.images.admin, gateway: next.images.gateway },
    installedAt:
      prior && prior.version === next.version && entry.outcome === "rolled-back"
        ? prior.installedAt
        : at,
    history: [...(prior?.history ?? []), { at, ...entry }].slice(-HISTORY_LIMIT),
  };
  assertNoSecrets(record, "release.json");
  writeJsonAtomic(releasePath(caeloDir), record);
  return record;
}

/** Record a failed-and-rolled-back upgrade without changing the running release. */
export function recordRollback(
  caeloDir: string,
  current: SelfHostedRelease,
  attempted: string,
  detail: string,
  now: Date = new Date(),
): void {
  recordRelease(
    caeloDir,
    { version: current.version, images: releaseImages(current) },
    { from: current.version, to: attempted, outcome: "rolled-back", detail },
    now,
  );
}

export type VerifiedRelease =
  | { readonly ok: true; readonly images: ReleaseImages }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve the admin + gateway images of release `tag` in GHCR to digests,
 * then cosign-verify each digest against the Caelo release workflow
 * identity (unless `skipVerify`, the escape hatch for forks). The returned
 * references are digest-pinned, so what was verified is exactly what runs.
 */
export async function resolveVerifiedRelease(
  tag: string,
  deps: {
    readonly runner: HostRunner;
    readonly skipVerify?: boolean;
    readonly fetchImpl?: typeof fetch;
    readonly onProgress?: (message: string) => void;
  },
): Promise<VerifiedRelease> {
  const refs: Partial<Record<"admin" | "gateway", string>> = {};
  for (const service of RELEASE_SERVICES) {
    deps.onProgress?.(`Resolving ${GHCR_REGISTRY}/${GHCR_NAMESPACE}/${service}:${tag}`);
    const r = await resolveRegistryDigest(
      GHCR_REGISTRY,
      `${GHCR_NAMESPACE}/${service}`,
      tag,
      deps.fetchImpl,
    );
    if (!r.ok) {
      return {
        ok: false,
        error:
          `Could not resolve ${GHCR_REGISTRY}/${GHCR_NAMESPACE}/${service}:${tag} (${r.reason}).\n` +
          "Check the version exists at https://github.com/caelo-cms/caelo-cms/releases and pass it as --version x.y.z.",
      };
    }
    refs[service] = ghcrImageRef(service, r.digest);
  }
  const images: ReleaseImages = {
    mode: "release",
    admin: refs.admin ?? "",
    gateway: refs.gateway ?? "",
  };
  if (deps.skipVerify) return { ok: true, images };

  const probe = await deps.runner.run(["cosign", "version"]);
  if (probe.exitCode !== 0) {
    return {
      ok: false,
      error:
        "cosign is required to verify the Caelo release image signatures and was not found on PATH.\n" +
        "Install it (https://docs.sigstore.dev/cosign/system_config/installation/ — e.g. `brew install cosign`,\n" +
        "or the release binary for Linux), then re-run. --skip-verify skips the check (NOT for production).",
    };
  }
  for (const service of RELEASE_SERVICES) {
    deps.onProgress?.(`Verifying the signature of ${service}`);
    const v = await deps.runner.run(cosignVerifyArgv(images[service]));
    if (v.exitCode !== 0) {
      return {
        ok: false,
        error:
          `cosign verify FAILED for ${images[service]}: its signature does not match the Caelo release workflow.\n` +
          "Either the registry was compromised, the image is a fork's, or sigstore had an outage (retry).\n" +
          `cosign: ${v.stderr.trim().slice(0, 500)}`,
      };
    }
  }
  return { ok: true, images };
}
