// SPDX-License-Identifier: MPL-2.0

/**
 * Keeps secret material out of the files the CLI writes under
 * `~/.caelo-<install-id>/` (#656).
 *
 * Only `secrets/` may hold secrets (CLAUDE.md §7, §11.C); `progress.json`
 * and `install.json` are plain bookkeeping that tooling, backups, sync
 * clients and agents read. Installs from before #576 checkpointed the full
 * Pulumi outputs, whose database URLs carried admin_role's and
 * public_role's passwords, and every install so far checkpointed the Owner
 * setup link with its token. This module
 *
 *   - finds secret material in a JSON value ({@link findSecrets}), which
 *     `markStepDone` / `writeMetadata` use to refuse writing it;
 *   - removes it from an existing checkpoint ({@link scrubProgressFile}),
 *     which `upgrade` and wizard re-runs call, and names the secrets to
 *     rotate ({@link rotationHints});
 *   - masks credentials in text the CLI prints ({@link redactCredentials}).
 *
 * Detection is by shape (a URL with a password, a URL with a token-like
 * query parameter) and by key name (password, secret, token, ...), so a
 * future secret output is caught without being listed here.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DATABASE_ROLE_SECRET, type DatabaseRole } from "./stack-contract.js";

/** One place a JSON value holds secret material. Never carries the secret itself. */
export interface SecretFinding {
  /** Dotted path to the offending value, e.g. `steps.pulumi-up-acme.outputs.adminDatabaseUrlOut`. */
  readonly path: string;
  /**
   * `credential-url`: a URL whose user-info carries a password.
   * `token-url`: a URL with a token / secret / password query parameter.
   * `secret-key`: a key whose name marks its value as secret.
   */
  readonly kind: "credential-url" | "token-url" | "secret-key";
  /** For a credential URL: the user whose password it carries. */
  readonly user?: string;
}

/** `scheme://user:password@` — the user-info of a URL that carries a password. */
const CREDENTIAL_URL = /[a-z][a-z0-9+.-]{0,31}:\/\/([^\s:@/]*):([^\s@/]+)@/gi;

/** A URL query parameter that carries a credential (the Owner setup link's `?token=`). */
const TOKEN_PARAM =
  /[?&](?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|sig|signature)=[^&\s#]+/i;

/**
 * Key names whose value is a secret, after lower-casing, dropping non
 * alphanumerics and a Pulumi `Out` suffix: `postgresPassword`,
 * `caeloSecretKek`, `bootstrap_token`, `anthropicApiKey`.
 */
const SECRET_KEY = /(password|passwd|passphrase|secret|secretkek|kek|token|apikey|privatekey)$/;

function isSecretKey(key: string): boolean {
  const k = key
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/out$/, "");
  return SECRET_KEY.test(k);
}

function urlUser(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function stringFindings(value: string, path: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  for (const m of value.matchAll(CREDENTIAL_URL)) {
    found.push({ path, kind: "credential-url", user: urlUser(m[1] ?? "") });
  }
  if (found.length === 0 && /:\/\//.test(value) && TOKEN_PARAM.test(value)) {
    found.push({ path, kind: "token-url" });
  }
  return found;
}

/**
 * Every place `value` holds secret material.
 *
 * @param value any JSON-shaped value (a checkpoint payload, install.json)
 * @param path the path prefix to report findings under
 */
export function findSecrets(value: unknown, path = ""): SecretFinding[] {
  if (typeof value === "string") return stringFindings(value, path || "(value)");
  const join = (k: string | number) => (path ? `${path}.${k}` : String(k));
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecrets(v, join(i)));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => {
      // A secret-named key is only a finding when it holds something; a
      // null / false / 0 marker is not secret material.
      if (isSecretKey(k) && v !== null && v !== undefined && v !== "" && typeof v !== "boolean") {
        return [{ path: join(k), kind: "secret-key" as const }];
      }
      return findSecrets(v, join(k));
    });
  }
  return [];
}

/**
 * Throw when `value` holds secret material. The message names the paths,
 * never the values, so the error itself cannot leak them.
 *
 * @param what what was about to be written, for the message
 */
export function assertNoSecrets(value: unknown, what: string): void {
  refuseFindings(findSecrets(value), what);
}

/** {@link assertNoSecrets} for a whole checkpoint (see {@link findCheckpointSecrets}). */
export function assertNoCheckpointSecrets(checkpoint: unknown, what: string): void {
  refuseFindings(findCheckpointSecrets(checkpoint), what);
}

function refuseFindings(found: readonly SecretFinding[], what: string): void {
  if (found.length === 0) return;
  throw new Error(
    `Refusing to write secret material to ${what} (${found.map((f) => `${f.path}: ${f.kind}`).join(", ")}). ` +
      "Secrets belong in Secret Manager or the install's secrets/ directory; read them at the moment of use instead (#656).",
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * {@link findSecrets} for a progress.json checkpoint. Its step names are
 * derived from operator input (`project-<project id>`), so they are
 * identifiers, not field names: a project called `acme-token` must not read
 * as a secret. Only the step payloads (and the other top-level fields) are
 * inspected.
 */
export function findCheckpointSecrets(checkpoint: unknown): SecretFinding[] {
  if (!isRecord(checkpoint)) return findSecrets(checkpoint);
  const { steps, ...rest } = checkpoint;
  const inSteps = isRecord(steps)
    ? Object.entries(steps).flatMap(([name, payload]) => findSecrets(payload, `steps.${name}`))
    : findSecrets(steps, "steps");
  return [...findSecrets(rest), ...inSteps];
}

/** {@link withoutSecrets} for a checkpoint: every step is kept, its payload cleaned. */
function checkpointWithoutSecrets(checkpoint: unknown): unknown {
  if (!isRecord(checkpoint)) return withoutSecrets(checkpoint);
  const { steps, ...rest } = checkpoint;
  return {
    ...(withoutSecrets(rest) as Record<string, unknown>),
    steps: isRecord(steps)
      ? Object.fromEntries(Object.entries(steps).map(([n, p]) => [n, withoutSecrets(p)]))
      : withoutSecrets(steps),
  };
}

/**
 * `value` without its secret material: secret-named keys and strings that
 * hold a credential or token URL are dropped. Everything else is kept.
 */
export function withoutSecrets(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .filter((v) => typeof v !== "string" || findSecrets(v).length === 0)
      .map(withoutSecrets);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (findSecrets({ [k]: v }).length > 0 && (isSecretKey(k) || typeof v === "string")) continue;
      out[k] = withoutSecrets(v);
    }
    return out;
  }
  return value;
}

/**
 * The Pulumi outputs worth checkpointing: everything except outputs Pulumi
 * marks secret and anything else that holds secret material (the Owner
 * setup link). Nothing reads secrets back from the checkpoint; code that
 * needs one reads the stack (`readStackOutput`) when it needs it.
 *
 * @param outputs the stack outputs as the Automation API returns them
 */
export function checkpointableOutputs(
  outputs: Readonly<Record<string, { value: unknown; secret?: boolean }>>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [k, o] of Object.entries(outputs)) {
    if (o.secret) continue;
    if (findSecrets({ [k]: o.value }).length > 0) continue;
    kept[k] = o.value;
  }
  return kept;
}

/** Outcome of {@link scrubProgressFile}. */
export interface ScrubReport {
  /** What was removed (paths + kinds, never values). Empty when the file was clean or absent. */
  readonly removed: readonly SecretFinding[];
}

/**
 * Remove secret material from a `progress.json` in place. The rewrite is
 * atomic (temp file in the same directory, then rename) and the result is
 * mode 0600, so an interrupted scrub never leaves a truncated checkpoint
 * and wizard re-runs still find every completed step.
 *
 * @param path the checkpoint file; a missing file is a no-op
 */
export function scrubProgressFile(path: string): ScrubReport {
  if (!existsSync(path)) return { removed: [] };
  const checkpoint: unknown = JSON.parse(readFileSync(path, "utf8"));
  const removed = findCheckpointSecrets(checkpoint);
  if (removed.length === 0) return { removed };
  writeJsonAtomic(path, checkpointWithoutSecrets(checkpoint));
  return { removed };
}

/**
 * Write `value` as JSON to `path` atomically with mode 0600: a temp file in
 * the same directory (so the rename stays on one filesystem), then rename.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const ROLE_BY_USER = DATABASE_ROLE_SECRET as Readonly<Record<string, string | undefined>>;

/**
 * What the operator should do about secrets a scrub removed: one line per
 * affected secret, with the exact command where one exists.
 *
 * @param removed the scrub's findings
 * @param installId the install, named in each command so it acts on the right one
 */
export function rotationHints(removed: readonly SecretFinding[], installId: string): string[] {
  const rotate = (secret: string) =>
    `bunx @caelo-cms/provisioning rotate-secret ${secret} --install ${installId}`;
  const hints = new Set<string>();
  for (const f of removed) {
    if (f.kind === "credential-url") {
      const secret = f.user ? ROLE_BY_USER[f.user as DatabaseRole] : undefined;
      hints.add(
        secret
          ? `${f.user}'s password was stored in progress.json. Rotate it: ${rotate(secret)}`
          : `A password for database user "${f.user ?? "?"}" was stored in progress.json (${f.path}); change it.`,
      );
    } else if (f.kind === "token-url") {
      hints.add(
        "The Owner setup link (with its one-time token) was stored in progress.json. It expires 24 hours after it was issued and stops working once the Owner account exists; nothing to rotate.",
      );
    } else {
      hints.add(
        `A secret value was stored in progress.json (${f.path}). Rotate whatever it belongs to.`,
      );
    }
  }
  return [...hints];
}

/**
 * `text` with every URL password masked (`postgresql://admin_role:***@`),
 * for anything the CLI prints that could carry one (errors from Pulumi or
 * gcloud, for instance). Same masking as the API gateway's error log.
 */
export function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]*):[^\s@/]+@/gi, "$1:***@");
}
