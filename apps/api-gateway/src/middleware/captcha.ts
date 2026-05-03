// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — Proof-of-Work captcha (default provider).
 *
 * Issue:    GET /api/captcha/challenge → { challenge, target, expiresAt }
 *           Stores `(challenge, target, expires_at, visitor_id_hash)` in
 *           pow_challenges so the verify side can reject replays.
 *
 * Verify:   client computes nonce s.t. sha256(challenge + nonce) starts with
 *           `target`. Submits {challenge, nonce} as `_caelo_captcha` field.
 *           Verifier marks the row `used_at = now()` atomically — replay is
 *           rejected loudly.
 *
 * Costs:    issue = 1 INSERT; verify = 1 UPDATE + 1 SHA-256.
 *           Bot pays ~50ms of CPU per submission at target=0x000fff (24 bits).
 *           Real user pays the same 50ms once per submission, invisibly.
 *
 * Replay:   used_at flag prevents re-use; cron sweeps expired rows hourly
 *           (the redeploy-orchestrator's GC step in PR2).
 */

import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

const TEXT_ENCODER = new TextEncoder();
const CHALLENGE_TTL_SEC = 60;

export type CaptchaProvider = "off" | "pow" | "turnstile" | "hcaptcha";

export interface CaptchaConfig {
  readonly provider: CaptchaProvider;
  /** Hex prefix the SHA-256 must match. Default `000fff` ≈ 24-bit difficulty. */
  readonly powTargetPrefix: string;
}

export interface CaptchaChallenge {
  readonly challenge: string;
  readonly target: string;
  readonly expiresAt: string;
}

export async function issuePowChallenge(
  adapter: DatabaseAdapter,
  args: { config: CaptchaConfig; visitorIdHash: string },
): Promise<CaptchaChallenge> {
  const challenge = randomChallenge();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SEC * 1000).toISOString();
  await adapter.withAdminTransaction(
    {
      actorId: "00000000-0000-0000-0000-00000000ffff",
      actorKind: "system",
      requestId: "pow-issue",
    },
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO pow_challenges (challenge, target_hex, expires_at, visitor_id_hash)
        VALUES (${challenge}, ${args.config.powTargetPrefix}, ${expiresAt}, ${args.visitorIdHash})
      `);
    },
  );
  return { challenge, target: args.config.powTargetPrefix, expiresAt };
}

export interface CaptchaProof {
  readonly challenge: string;
  readonly nonce: string;
}

export type CaptchaVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export async function verifyPowProof(
  adapter: DatabaseAdapter,
  proof: CaptchaProof,
): Promise<CaptchaVerifyResult> {
  if (typeof proof.challenge !== "string" || typeof proof.nonce !== "string") {
    return { ok: false, reason: "malformed proof" };
  }
  // Atomic claim — one UPDATE returns the row only if it was unused +
  // unexpired. Replay → 0 rows → reject.
  const row = await adapter.withAdminTransaction(
    {
      actorId: "00000000-0000-0000-0000-00000000ffff",
      actorKind: "system",
      requestId: "pow-verify",
    },
    async (tx) => {
      const rs = (await tx.execute(sql`
        UPDATE pow_challenges
           SET used_at = now()
         WHERE challenge = ${proof.challenge}
           AND used_at IS NULL
           AND expires_at > now()
         RETURNING target_hex
      `)) as unknown as { target_hex: string }[];
      return rs[0] ?? null;
    },
  );
  if (!row) return { ok: false, reason: "challenge missing, expired, or already used" };
  // Verify the SHA-256 prefix.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(`${proof.challenge}${proof.nonce}`),
  );
  const hex = bufferToHex(digest);
  if (!hex.startsWith(row.target_hex)) {
    return { ok: false, reason: "proof does not satisfy target prefix" };
  }
  return { ok: true };
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomChallenge(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hashVisitorId(visitorId: string): string {
  // Cheap deterministic hash for analytics + PoW binding without storing
  // the raw cookie. Not cryptographic — bcrypt happens at higher layers.
  let h = 5381;
  for (let i = 0; i < visitorId.length; i++) {
    h = (h * 33) ^ visitorId.charCodeAt(i);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * P13 audit re-pass — extract a stable IP-derived hash from the
 * request. Honours common proxy headers (X-Forwarded-For,
 * X-Real-IP) when present; falls back to a constant when none are.
 * Same djb2 shape as hashVisitorId — not cryptographic, just used as
 * a rate-limit bucket key (no PII written).
 */
export function clientIpHash(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const xri = req.headers.get("x-real-ip");
  // X-Forwarded-For: client, proxy1, proxy2 — first hop is the client.
  const raw = (xff?.split(",")[0]?.trim() ?? xri ?? "0.0.0.0").trim();
  return hashVisitorId(raw);
}
