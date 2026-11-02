// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — Proof-of-Work captcha (default provider).
 *
 * Issue:    GET /api/captcha/challenge → { challenge, target, expiresAt }
 *           Stores `(challenge, target, expires_at)` in
 *           gateway_pow_challenges (cms_public, #635) so the verify side can
 *           reject replays.
 *
 * Verify:   client computes nonce s.t. sha256(`<challenge>|<slug>.<op>|<nonce>`)
 *           starts with `target` ({@link powPreimage}) and submits
 *           {challenge, nonce} as the `_caelo_captcha` field of THAT
 *           operation's request (#1332: a proof is bound to one operation,
 *           so work done for a consent click cannot pay for a signup).
 *           Verifier marks the row `used_at = now()` atomically — replay is
 *           rejected loudly.
 *
 * Costs:    issue = 1 INSERT; verify = 1 UPDATE + 1 SHA-256.
 *           Bot pays ~50ms of CPU per submission at target=0x000fff (24 bits).
 *           Real user pays the same 50ms once per submission, invisibly.
 *
 * Replay:   used_at flag prevents re-use; the gateway sweeps expired rows
 *           hourly itself (gc.ts).
 *
 * Binding:  to the operation (above), never to a visitor. A challenge is
 *           redeemable by whichever request presents it first, once.
 *           Binding it to the visitor cookie protected
 *           nothing — a bot that drops the cookie got unbound challenges —
 *           and made the captcha depend on a cookie the visitor may refuse.
 *           The protection is the work and the single use; the per-address
 *           rate limit on /api/captcha/challenge bounds how many a client
 *           can stockpile.
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
  args: { config: CaptchaConfig },
): Promise<CaptchaChallenge> {
  const challenge = randomChallenge();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SEC * 1000).toISOString();
  await adapter.withPublicTransaction(
    {
      actorId: "00000000-0000-0000-0000-00000000ffff",
      actorKind: "system",
      requestId: "pow-issue",
    },
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO gateway_pow_challenges (challenge, target_hex, expires_at)
        VALUES (${challenge}, ${args.config.powTargetPrefix}, ${expiresAt})
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

/**
 * What the proof-of-work hashes: the challenge, the operation it is spent
 * on (`<slug>.<operation>`) and the nonce. The component kit computes the
 * same string (`attachCaptchaProof`); the two must not drift.
 */
export function powPreimage(challenge: string, scope: string, nonce: string): string {
  return `${challenge}|${scope}|${nonce}`;
}

/**
 * Claim `proof`'s challenge (once) and check its work for `scope`.
 *
 * @param scope `<slug>.<operation>` of the request the proof came with
 */
export async function verifyPowProof(
  adapter: DatabaseAdapter,
  proof: CaptchaProof,
  scope: string,
): Promise<CaptchaVerifyResult> {
  if (
    typeof proof?.challenge !== "string" ||
    typeof proof.nonce !== "string" ||
    proof.nonce.length > 64
  ) {
    return { ok: false, reason: "malformed proof" };
  }
  const ctx = {
    actorId: "00000000-0000-0000-0000-00000000ffff",
    actorKind: "system" as const,
    requestId: "pow-verify",
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    TEXT_ENCODER.encode(powPreimage(proof.challenge, scope, proof.nonce)),
  );
  const hex = bufferToHex(digest);

  // Verify the challenge state and SHA-256 prefix before marking used_at = now(),
  // so a wrong nonce does not burn an otherwise valid challenge.
  return adapter.withPublicTransaction(ctx, async (tx) => {
    const stateRows = (await tx.execute(sql`
      SELECT target_hex,
             used_at IS NOT NULL AS used,
             expires_at <= now() AS expired
        FROM gateway_pow_challenges
       WHERE challenge = ${proof.challenge}
    `)) as unknown as (ChallengeState & { readonly target_hex: string })[];
    const state = stateRows[0] ?? null;
    if (!state || state.used || state.expired) {
      return { ok: false, reason: claimRejectionReason(state) };
    }
    if (!hex.startsWith(state.target_hex)) {
      return {
        ok: false,
        reason: `proof does not satisfy the target for "${scope}": solve the challenge for the operation it is sent with`,
      };
    }
    const claimed = (await tx.execute(sql`
      UPDATE gateway_pow_challenges
         SET used_at = now()
       WHERE challenge = ${proof.challenge}
         AND used_at IS NULL
         AND expires_at > now()
       RETURNING challenge
    `)) as unknown as { challenge: string }[];
    if (!claimed[0]) {
      return {
        ok: false,
        reason: claimRejectionReason({ used: true, expired: false }),
      };
    }
    return { ok: true };
  });
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

interface ChallengeState {
  readonly used: boolean;
  readonly expired: boolean;
}

/** Why a challenge could not be claimed, worded for the visitor's next step. */
function claimRejectionReason(state: ChallengeState | null): string {
  const renew = "request a new one from /api/captcha/challenge";
  if (!state) return `unknown captcha challenge: ${renew}`;
  if (state.used) {
    return `captcha challenge already used: each submission needs its own, so ${renew}`;
  }
  if (state.expired) {
    return `captcha challenge expired (valid for ${CHALLENGE_TTL_SEC} seconds): ${renew} and submit within that time`;
  }
  // Every claim condition holds as this read runs: a concurrent request
  // with the same proof claimed it first.
  return `captcha challenge already used: each submission needs its own, so ${renew}`;
}
