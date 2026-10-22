// SPDX-License-Identifier: MPL-2.0

/**
 * #770 — the self-hosted install's `/api/internal/*` secret,
 * `.caelo/internal-secret.json` (`{ "secret": "<hex>" }`).
 *
 * `init` has written it since P15.1, but until #770 nothing handed it to the
 * admin container, so the admin's internal endpoints answered "not set" on
 * every self-hosted install. The Compose file now carries it as the admin's
 * `CAELO_INTERNAL_SECRET`, and the host-side commands that call those
 * endpoints (`owner-reset`) sign their tokens with the same file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "./private-file.js";

/** The admin refuses shorter secrets (apps/admin internal-jwt.ts). */
const MIN_LENGTH = 32;

/** `<caeloDir>/internal-secret.json`. */
export function internalSecretPath(caeloDir: string): string {
  return join(caeloDir, "internal-secret.json");
}

/**
 * The install's internal secret, or null when the file does not exist.
 * Throws on a malformed file rather than guessing a value: a wrong secret
 * would only surface later as every internal call failing its signature.
 */
export function readInternalSecret(caeloDir: string): string | null {
  const path = internalSecretPath(caeloDir);
  if (!existsSync(path)) return null;
  let secret: unknown;
  try {
    secret = (JSON.parse(readFileSync(path, "utf8")) as { secret?: unknown }).secret;
  } catch (e) {
    throw new Error(
      `${path} is not valid JSON (${String(e)}); fix it or delete it and run \`cms-provision up\`.`,
    );
  }
  if (typeof secret !== "string" || secret.length < MIN_LENGTH) {
    throw new Error(
      `${path} has no "secret" of at least ${MIN_LENGTH} characters; fix it or delete it and run \`cms-provision up\`.`,
    );
  }
  return secret;
}

/** Write a new internal secret (`init`, or {@link ensureInternalSecret}). */
export function writeInternalSecret(caeloDir: string, secret: string): void {
  if (secret.length < MIN_LENGTH) throw new Error(`internal secret shorter than ${MIN_LENGTH}`);
  writePrivateFile(internalSecretPath(caeloDir), JSON.stringify({ secret }, null, 2));
}

/**
 * The secret the Compose file gives the admin. An install whose directory
 * has none (made by a CLI that did not write the file, or with it deleted)
 * gets one created here, and `report` says so.
 *
 * This is creation of a missing secret, not a fallback (CLAUDE.md §2): no
 * stored state depends on a previous value — before #770 the admin never
 * received the secret, so no token was ever signed with it — and the value
 * is written to disk before the Compose file that uses it, so every later
 * render and every host-side command read the same one. Same pattern as
 * the `caeloSecretKek` back-fill in the CLI's `emitConfig`.
 */
export function ensureInternalSecret(
  caeloDir: string,
  deps: { readonly randomSecret: () => string; readonly report: (line: string) => void },
): string {
  const existing = readInternalSecret(caeloDir);
  if (existing !== null) return existing;
  const secret = deps.randomSecret();
  writeInternalSecret(caeloDir, secret);
  deps.report(
    `Created ${internalSecretPath(caeloDir)} — this install had no internal secret; the admin now gets it as CAELO_INTERNAL_SECRET (needed by \`cms-provision owner-reset\`).`,
  );
  return secret;
}
