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

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Provider = "self-hosted" | "gcp" | "aws" | "azure";

export interface InstallMetadata {
  installId: string;
  provider: Provider;
  /** Cloud-side project / account / subscription id. NULL for self-hosted. */
  projectId: string | null;
  domain: string;
  ownerEmail: string;
  region: string | null;
  createdAt: string;
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
