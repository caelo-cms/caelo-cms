// SPDX-License-Identifier: MPL-2.0

/**
 * Per-install state — every Caelo install gets its own
 * `~/.caelo-<install-id>/` directory with:
 *
 *   secrets/                — mode-700 dir for the install's secrets
 *     anthropic-api-key       (mode 600) — Anthropic API key (one-time prompt)
 *     pulumi-passphrase       (mode 600) — Pulumi local-backend passphrase
 *     sa-key.json             (mode 600) — GCP SA key (when local-deploy; absent
 *                                          when Workload Identity Federation
 *                                          deploys from CI)
 *   state/                  — Pulumi local backend state (per-install isolated)
 *   progress.json           — wizard checkpoint so re-runs resume cleanly
 *   install.json            — install metadata (provider, project id, region,
 *                             domain, owner email, install id, created_at)
 *
 * The CLAUDE.md §11.C contract: end-users never reach into this directory
 * by hand. The wizard + lifecycle commands wrap every read + write.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Provider = "self-hosted" | "gcp" | "gcp-firebase" | "aws" | "azure";

export interface InstallMetadata {
  installId: string;
  provider: Provider;
  /** Cloud-side project / account / subscription id. NULL for self-hosted. */
  projectId: string | null;
  domain: string;
  ownerEmail: string;
  region: string | null;
  createdAt: string;
  /**
   * sha256 digests of the release images the install runs, recorded by the
   * wizard after `pulumi up` and by `upgrade` after a roll. A wizard re-run
   * deploys these instead of re-resolving `:latest`, so it never undoes a
   * pinned or rc upgrade; versions change through `upgrade` only. Absent on
   * installs that predate it.
   */
  imageDigests?: ImageDigests;
}

/** Release image digest per Cloud Run service. */
export interface ImageDigests {
  readonly admin: string;
  readonly gateway: string;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The image digests recorded for an install, or null when none are. Throws
 * on a malformed record rather than deploying a guess.
 */
export function recordedImageDigests(meta: InstallMetadata): ImageDigests | null {
  const d = meta.imageDigests;
  if (d === undefined) return null;
  if (!DIGEST.test(d.admin ?? "") || !DIGEST.test(d.gateway ?? "")) {
    throw new Error(
      `install.json imageDigests is malformed (${JSON.stringify(d)}); fix or remove it, then re-run.`,
    );
  }
  return d;
}

/**
 * The metadata a non-interactive re-run of an existing install writes: the
 * inputs it was given over what install.json already holds. Everything else
 * (createdAt, region, the recorded `imageDigests`) survives, so the re-run
 * keeps the release the install runs instead of looking like a new install.
 */
export function resumedMetadata(
  existing: InstallMetadata,
  inputs: { domain: string; ownerEmail: string; projectId: string | null },
): InstallMetadata {
  return {
    ...existing,
    domain: inputs.domain,
    ownerEmail: inputs.ownerEmail,
    projectId: inputs.projectId ?? existing.projectId,
  };
}

/** Record the image digests an install now runs (see {@link InstallMetadata.imageDigests}). */
export function recordImageDigests(installId: string, digests: ImageDigests): void {
  const meta = readMetadata(installId);
  if (!meta) throw new Error(`No install.json for install '${installId}'.`);
  writeMetadata(installId, {
    ...meta,
    imageDigests: { admin: digests.admin, gateway: digests.gateway },
  });
}

export interface ProgressCheckpoint {
  /** Last completed wizard step. Used for resume-after-failure. */
  lastCompletedStep: string | null;
  /** Per-step state (e.g. createdProjectId, mintedSaKeyAt, etc.). */
  steps: Record<string, unknown>;
  /** ISO timestamp of last successful update. */
  updatedAt: string;
}

const ROOT_PREFIX = ".caelo-";

export function installRoot(installId: string): string {
  return join(homedir(), `${ROOT_PREFIX}${installId}`);
}

/**
 * Stable install id from the (provider, projectId-or-domain) pair so a re-run
 * with the same inputs always lands on the same `~/.caelo-<id>/` directory.
 * The id is short + readable — `gcp-caelo-website` / `self-hosted-mysite-com`.
 */
export function deriveInstallId(provider: Provider, projectIdOrDomain: string): string {
  const slug = projectIdOrDomain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${provider}-${slug}`;
}

/**
 * Ensure the install directory exists with the right mode + sub-dirs.
 * Idempotent.
 */
export function ensureInstallDir(installId: string): {
  root: string;
  secretsDir: string;
  stateDir: string;
} {
  const root = installRoot(installId);
  const secretsDir = join(root, "secrets");
  const stateDir = join(root, "state");

  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(secretsDir)) mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  // chmod every time in case the dirs existed with looser perms.
  chmodSync(root, 0o700);
  chmodSync(secretsDir, 0o700);
  chmodSync(stateDir, 0o700);

  return { root, secretsDir, stateDir };
}

/**
 * Scan `~/.caelo-*` for every install with a readable `install.json`.
 * Used by the wizard to offer "resume X" before prompting for the
 * domain / owner / project again. Silently skips dirs that fail to
 * parse — partial / orphaned dirs don't block the new-install flow.
 */
export function listInstalls(): InstallMetadata[] {
  const home = homedir();
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return [];
  }
  const out: InstallMetadata[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(ROOT_PREFIX)) continue;
    const installId = entry.slice(ROOT_PREFIX.length);
    const meta = readMetadata(installId);
    if (meta) out.push(meta);
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

/**
 * The install a command names on its argv: `--install <id or domain>` or
 * `--install=<…>`. `--install-id` is accepted as an alias, the spelling
 * older docs and code comments used.
 *
 * @returns the value, or undefined when no flag is given
 * @throws when the flag is given without a value
 */
export function installFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    for (const name of ["--install", "--install-id"]) {
      if (a === name) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("-")) {
          throw new Error(
            `${name} needs a value: the install id or domain (e.g. ${name} example.com)`,
          );
        }
        return v;
      }
      if (a.startsWith(`${name}=`)) {
        const v = a.slice(name.length + 1);
        if (v === "") throw new Error(`${name} needs a value: the install id or domain`);
        return v;
      }
    }
  }
  return undefined;
}

/** Outcome of {@link selectInstall}. */
export type InstallSelection = { ok: true; meta: InstallMetadata } | { ok: false; message: string };

/**
 * Pick the install a lifecycle command acts on. `wanted` (from `--install`)
 * matches an install id or its domain. Without it, exactly one install may
 * exist: with several, guessing would upgrade, back up or destroy the wrong
 * site, so the operator is asked to name one instead.
 *
 * @param installs every install on this machine (see {@link listInstalls})
 * @param wanted the `--install` value, if given
 */
export function selectInstall(
  installs: readonly InstallMetadata[],
  wanted: string | undefined,
): InstallSelection {
  const listed = (ms: readonly InstallMetadata[]): string =>
    ms.map((m) => `  ${m.installId}  (${m.domain}, ${m.provider})`).join("\n");
  if (wanted !== undefined) {
    const hits = installs.filter((m) => m.installId === wanted || m.domain === wanted);
    if (hits.length === 1 && hits[0]) return { ok: true, meta: hits[0] };
    if (hits.length === 0) {
      return {
        ok: false,
        message:
          installs.length === 0
            ? `No install "${wanted}" on this machine (no ~/.caelo-<install-id>/install.json found).`
            : `No install "${wanted}" on this machine. Installs found:\n${listed(installs)}\nPass one of these ids (or its domain) with --install.`,
      };
    }
    return {
      ok: false,
      message: `"${wanted}" matches several installs:\n${listed(hits)}\nPass the install id with --install.`,
    };
  }
  if (installs.length === 1 && installs[0]) return { ok: true, meta: installs[0] };
  if (installs.length === 0) {
    return { ok: false, message: "No Caelo install found on this machine." };
  }
  return {
    ok: false,
    message: `Several Caelo installs on this machine:\n${listed(installs)}\nPick one with --install <install-id or domain>.`,
  };
}

export function readMetadata(installId: string): InstallMetadata | null {
  const path = join(installRoot(installId), "install.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as InstallMetadata;
}

export function writeMetadata(installId: string, meta: InstallMetadata): void {
  const path = join(installRoot(installId), "install.json");
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

export function readProgress(installId: string): ProgressCheckpoint {
  const path = join(installRoot(installId), "progress.json");
  if (!existsSync(path)) {
    return { lastCompletedStep: null, steps: {}, updatedAt: new Date().toISOString() };
  }
  return JSON.parse(readFileSync(path, "utf8")) as ProgressCheckpoint;
}

export function writeProgress(installId: string, checkpoint: ProgressCheckpoint): void {
  const path = join(installRoot(installId), "progress.json");
  writeFileSync(
    path,
    `${JSON.stringify({ ...checkpoint, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/**
 * Mark a step complete. Wizard re-runs check `isStepDone(installId, name)` to
 * skip already-done steps.
 */
export function markStepDone(installId: string, stepName: string, payload?: unknown): void {
  const cur = readProgress(installId);
  cur.lastCompletedStep = stepName;
  if (payload !== undefined) cur.steps[stepName] = payload;
  writeProgress(installId, cur);
}

export function isStepDone(installId: string, stepName: string): boolean {
  return readProgress(installId).steps[stepName] !== undefined;
}

export function getStepPayload<T>(installId: string, stepName: string): T | null {
  const v = readProgress(installId).steps[stepName];
  return (v ?? null) as T | null;
}

/**
 * Read a secret file from the install's `secrets/` dir. Returns null if the
 * file doesn't exist; throws if the file exists but has the wrong mode (a
 * defence against the user copy-pasting a key into a 644 file by mistake).
 */
export function readSecret(installId: string, name: string): string | null {
  const path = join(installRoot(installId), "secrets", name);
  if (!existsSync(path)) return null;
  const contents = readFileSync(path, "utf8").trim();
  if (contents.length === 0) return null;
  return contents;
}

export function writeSecret(installId: string, name: string, value: string): void {
  ensureInstallDir(installId);
  const path = join(installRoot(installId), "secrets", name);
  writeFileSync(path, value.endsWith("\n") ? value : `${value}\n`, { mode: 0o600 });
}
