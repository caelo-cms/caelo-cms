// SPDX-License-Identifier: MPL-2.0

/**
 * Sealed values for the stateless OAuth broker (issue #806).
 *
 * The broker keeps no database rows: every value it hands a client (the
 * Google `state`, the authorization `code`, the `refresh_token`, a DCR
 * `client_id`) is its own payload encrypted with AES-256-GCM under
 * `CAELO_MCP_OAUTH_SEAL_KEY`. GCM authenticates, so a client can neither
 * read nor alter one.
 *
 * Purpose binding: each kind is sealed with its own additional
 * authenticated data (`caelo-mcp-oauth/v1/<purpose>`). A `state` presented
 * as a `code`, or a `client_id` as a `refresh_token`, fails authentication
 * exactly like a forged value, so no kind can stand in for another even
 * though they share a key.
 *
 * Envelope: `v2.<kid>.<iv>.<ciphertext+tag>` (base64url, 12-byte random
 * IV, 16-byte tag). `kid` names the key that sealed the value (a hash
 * prefix, never the key), so during a key rotation `open` picks the
 * previous key for values still in clients' hands — a refresh token lives
 * up to 30 days — without trial-decrypting under every key. The version
 * prefix lets a later format coexist. Expiry is the payload's `exp` (Unix
 * seconds), checked on open; kinds that must expire carry it in their
 * schema.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { z } from "zod";

/** The kinds of sealed values; each is bound to its own AAD. */
export type SealPurpose = "state" | "code" | "refresh" | "client" | "consent";

const VERSION = "v2";
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Longest sealed value accepted; anything longer is not ours (and not worth decrypting). */
export const MAX_SEALED_LENGTH = 8192;

function aad(purpose: SealPurpose): Buffer {
  return Buffer.from(`caelo-mcp-oauth/${VERSION}/${purpose}`, "utf8");
}

/**
 * The key id carried in the envelope: 8 base64url characters of a
 * domain-separated SHA-256 of the key. Public by design; it only says
 * which of the configured keys to try.
 */
export function keyId(key: Uint8Array): string {
  return createHash("sha256")
    .update("caelo-mcp-oauth/kid/")
    .update(key)
    .digest("base64url")
    .slice(0, 8);
}

/** Seal `payload` for `purpose` under `key` (always the current key). */
export function seal(key: Uint8Array, purpose: SealPurpose, payload: object): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(purpose));
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${VERSION}.${keyId(key)}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

/** Why a sealed value was refused. Deliberately coarse: callers answer one generic error. */
export type OpenFailure = "malformed" | "forged" | "expired" | "invalid_payload";

export type OpenResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: OpenFailure };

const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Open a sealed value of `purpose` and validate its payload with `schema`.
 *
 * @param keys - the keys a value may have been sealed under: the current
 *   one, plus the previous one while a rotation is in progress. A single
 *   key is accepted for convenience.
 * @param nowSeconds - current Unix time; a payload whose `exp` is not in the
 *   future is `expired`.
 */
export function open<S extends z.ZodType>(
  keys: Uint8Array | readonly Uint8Array[],
  purpose: SealPurpose,
  token: string,
  schema: S,
  nowSeconds: number,
): OpenResult<z.infer<S>> {
  if (token.length > MAX_SEALED_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return { ok: false, reason: "malformed" };
  const [, kid, ivPart, bodyPart] = parts as [string, string, string, string];
  if (!B64URL.test(ivPart) || !B64URL.test(bodyPart)) return { ok: false, reason: "malformed" };
  const ring = keys instanceof Uint8Array ? [keys] : keys;
  // An unknown kid is a value sealed under a key this install no longer
  // (or never) had: indistinguishable from a forgery for the caller.
  const key = ring.find((k) => keyId(k) === kid);
  if (!key) return { ok: false, reason: "forged" };
  const iv = Buffer.from(ivPart, "base64url");
  const body = Buffer.from(bodyPart, "base64url");
  if (iv.byteLength !== IV_BYTES || body.byteLength <= TAG_BYTES) {
    return { ok: false, reason: "malformed" };
  }
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(purpose));
    decipher.setAuthTag(body.subarray(body.byteLength - TAG_BYTES));
    plain = Buffer.concat([
      decipher.update(body.subarray(0, body.byteLength - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    return { ok: false, reason: "forged" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(plain.toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid_payload" };
  }
  if (raw && typeof raw === "object" && "exp" in raw) {
    const exp = (raw as { exp: unknown }).exp;
    if (typeof exp !== "number" || exp <= nowSeconds) return { ok: false, reason: "expired" };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid_payload" };
  return { ok: true, value: parsed.data };
}
