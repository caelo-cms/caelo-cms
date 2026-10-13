// SPDX-License-Identifier: MPL-2.0

/**
 * Step-up re-authentication with a fresh Google sign-in (epic #696,
 * maintainer decision 4). See security/step-up/google-oidc.ts for the
 * protocol and security/step-up/gate.ts for how guarded ops use the result.
 *
 *   step_up.status      is a Google client configured; is this session's
 *                       step-up fresh
 *   step_up.set_client  store the install's Google OAuth client (the first
 *                       time without a step-up — there is nothing to sign in
 *                       with yet —, afterwards only with one)
 *   step_up.begin       start a sign-in: challenge row + Google URL
 *   step_up.redeem      the callback takes its challenge back (single use)
 *   step_up.record      the callback records the verified sign-in on the
 *                       session, or the failed attempt (audited either way)
 *
 * Every op is human-only: a step-up proves a person is at the browser, so
 * neither the AI nor a system worker can hold or make one.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok, STEP_UP_MAX_AGE_SECONDS, STEP_UP_PURPOSES } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAuditFromCtx } from "../audit.js";
import { decryptSecret, encryptSecret } from "../security/secret-box.js";
import {
  consumeStepUp,
  guardedActionRefusal,
  readSessionStepUp,
  sessionHashSchema,
  stepUpProblem,
} from "../security/step-up/gate.js";
import { authorizationUrl, newChallengeSecrets } from "../security/step-up/google-oidc.js";
import { missingPermissions } from "./_approver-permission.js";

const GOOGLE_CLIENT_ID = /^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$/;

const handlerError = (operation: string, message: string) =>
  err({ kind: "HandlerError" as const, operation, message });

async function sha256Hex(value: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface ClientRow {
  client_id: string;
  client_secret_encrypted: Uint8Array;
  client_secret_iv: Uint8Array;
  client_secret_kek_fp: string;
  updated_at: Date | string;
}

async function readClient(tx: Parameters<typeof readSessionStepUp>[0]): Promise<ClientRow | null> {
  const rows = (await tx.execute(sql`
    SELECT client_id, client_secret_encrypted, client_secret_iv, client_secret_kek_fp, updated_at
      FROM step_up_google_client WHERE id = 1
  `)) as unknown as ClientRow[];
  return rows[0] ?? null;
}

const statusOutput = z.object({
  /** Whether the install has a Google OAuth client for step-up. */
  configured: z.boolean(),
  clientId: z.string().nullable(),
  /** Until when this session's step-up authorizes an action; null = none. */
  freshUntil: z.string().nullable(),
  /** Why the session has no usable step-up (null when fresh). */
  problem: z.string().nullable(),
});
export type StepUpStatus = z.infer<typeof statusOutput>;

export const stepUpStatusOp = defineOperation({
  name: "step_up.status",
  // Why human-only: describes the caller's own browser session; the AI and
  // workers have none, and must never learn whether a step-up is fresh.
  actorScope: ["human"],
  database: "cms_admin",
  input: z.object({ sessionHash: sessionHashSchema }).strict(),
  output: statusOutput,
  handler: async (ctx, input, tx) => {
    const client = await readClient(tx);
    const session = await readSessionStepUp(tx, ctx.actorId, input.sessionHash);
    const problem = stepUpProblem(session, new Date());
    return ok({
      configured: client !== null,
      clientId: client?.client_id ?? null,
      freshUntil:
        problem === null && session?.stepUpAt
          ? new Date(session.stepUpAt.getTime() + STEP_UP_MAX_AGE_SECONDS * 1000).toISOString()
          : null,
      problem,
    });
  },
});

export const stepUpSetClientOp = defineOperation({
  name: "step_up.set_client",
  // Why human-only: the Owner's Google OAuth client credentials — what every
  // later step-up signs in with. Changing them needs a step-up itself.
  actorScope: ["human"],
  database: "cms_admin",
  input: z
    .object({
      clientId: z
        .string()
        .trim()
        .regex(GOOGLE_CLIENT_ID, "expected a Google client ID (…apps.googleusercontent.com)"),
      clientSecret: z.string().trim().min(10).max(200),
      sessionHash: sessionHashSchema,
    })
    .strict(),
  output: z.object({ replaced: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const op = "step_up.set_client";
    const existing = await readClient(tx);
    if (existing) {
      // Replacing the client is itself a guarded action.
      const refusal = await guardedActionRefusal(tx, ctx, {
        operation: "replace the Google sign-in client",
        permission: "platform.update",
        sessionHash: input.sessionHash,
      });
      if (refusal) return handlerError(op, refusal);
    } else {
      const missing = await missingPermissions(tx, ctx.actorId, ["platform.update"]);
      if (missing.length > 0) {
        return handlerError(
          op,
          "permission_denied: setting up the Google sign-in needs the platform.update permission (the Owner has it).",
        );
      }
    }
    const enc = await encryptSecret(input.clientSecret);
    await tx.execute(sql`
      INSERT INTO step_up_google_client (
        id, client_id, client_secret_encrypted, client_secret_iv, client_secret_kek_fp,
        updated_by, updated_at
      ) VALUES (
        1, ${input.clientId}, ${Buffer.from(enc.ciphertext)}, ${Buffer.from(enc.iv)},
        ${enc.kekFingerprint}, ${ctx.actorId}::uuid, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        client_id = EXCLUDED.client_id,
        client_secret_encrypted = EXCLUDED.client_secret_encrypted,
        client_secret_iv = EXCLUDED.client_secret_iv,
        client_secret_kek_fp = EXCLUDED.client_secret_kek_fp,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
    `);
    if (existing) await consumeStepUp(tx, ctx.actorId, input.sessionHash);
    await recordAuditFromCtx(tx, ctx, {
      operation: op,
      input: { clientId: input.clientId },
      succeeded: true,
      resultSummary: existing ? "replaced" : "configured",
    });
    return ok({ replaced: existing !== null });
  },
});

export const stepUpBeginOp = defineOperation({
  name: "step_up.begin",
  // Why human-only: starts a Google sign-in in the caller's own browser.
  actorScope: ["human"],
  database: "cms_admin",
  input: z
    .object({
      sessionHash: sessionHashSchema,
      purpose: z.enum(STEP_UP_PURPOSES),
      returnTo: z
        .string()
        .regex(/^\/[A-Za-z0-9/_-]*$/, "expected an admin path")
        .max(200),
      /** The admin origin's callback URL — registered on the OAuth client. */
      redirectUri: z.string().url().max(500),
    })
    .strict(),
  output: z.object({ authorizationUrl: z.string() }),
  handler: async (ctx, input, tx) => {
    const op = "step_up.begin";
    const missing = await missingPermissions(tx, ctx.actorId, ["platform.update"]);
    if (missing.length > 0) {
      return handlerError(
        op,
        "permission_denied: only someone with the platform.update permission (the Owner) can confirm update actions.",
      );
    }
    const client = await readClient(tx);
    if (!client) {
      return handlerError(
        op,
        "Google sign-in for confirming updates is not set up for this install yet. Set it up under Settings → Updates first.",
      );
    }
    const session = await readSessionStepUp(tx, ctx.actorId, input.sessionHash);
    if (!session) return handlerError(op, "this browser session is not signed in any more");
    const secrets = await newChallengeSecrets();
    // Old attempts of this user are dead weight; one live attempt each time.
    await tx.execute(sql`
      DELETE FROM step_up_challenges
       WHERE user_id = ${ctx.actorId}::uuid AND (expires_at < now() OR session_hash = ${input.sessionHash})
    `);
    await tx.execute(sql`
      INSERT INTO step_up_challenges (
        user_id, session_hash, state_hash, nonce, code_verifier, purpose, return_to, redirect_uri
      ) VALUES (
        ${ctx.actorId}::uuid, ${input.sessionHash}, ${await sha256Hex(secrets.state)},
        ${secrets.nonce}, ${secrets.codeVerifier}, ${input.purpose}, ${input.returnTo},
        ${input.redirectUri}
      )
    `);
    return ok({
      authorizationUrl: authorizationUrl({
        clientId: client.client_id,
        redirectUri: input.redirectUri,
        state: secrets.state,
        nonce: secrets.nonce,
        codeChallenge: secrets.codeChallenge,
        loginHint: session.userEmail,
      }),
    });
  },
});

const redeemOutput = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  codeVerifier: z.string(),
  nonce: z.string(),
  redirectUri: z.string(),
  returnTo: z.string(),
  purpose: z.enum(STEP_UP_PURPOSES),
  /** When the step-up began: Google's auth_time must not be earlier. */
  startedAt: z.string(),
});
export type StepUpRedeemed = z.infer<typeof redeemOutput>;

export const stepUpRedeemOp = defineOperation({
  name: "step_up.redeem",
  // Why human-only: the OAuth callback of the caller's own sign-in; returns
  // the client secret for the code exchange, which only the server sees.
  actorScope: ["human"],
  database: "cms_admin",
  input: z.object({ sessionHash: sessionHashSchema, state: z.string().min(16).max(200) }).strict(),
  output: redeemOutput,
  handler: async (ctx, input, tx) => {
    const op = "step_up.redeem";
    const rows = (await tx.execute(sql`
      DELETE FROM step_up_challenges
       WHERE state_hash = ${await sha256Hex(input.state)}
         AND user_id = ${ctx.actorId}::uuid
       RETURNING session_hash, nonce, code_verifier, purpose, return_to, redirect_uri,
                 created_at, expires_at
    `)) as unknown as {
      session_hash: string;
      nonce: string;
      code_verifier: string;
      purpose: (typeof STEP_UP_PURPOSES)[number];
      return_to: string;
      redirect_uri: string;
      created_at: Date | string;
      expires_at: Date | string;
    }[];
    const c = rows[0];
    if (!c) {
      return handlerError(
        op,
        "This sign-in link is unknown or was already used. Start the confirmation again.",
      );
    }
    if (c.session_hash !== input.sessionHash) {
      return handlerError(op, "This sign-in was started in another browser session.");
    }
    if (new Date(c.expires_at).getTime() < Date.now()) {
      return handlerError(op, "This sign-in took longer than 10 minutes. Start it again.");
    }
    const client = await readClient(tx);
    if (!client) return handlerError(op, "The Google sign-in client was removed meanwhile.");
    const clientSecret = await decryptSecret({
      ciphertext: new Uint8Array(client.client_secret_encrypted),
      iv: new Uint8Array(client.client_secret_iv),
      kekFingerprint: client.client_secret_kek_fp,
    });
    return ok({
      clientId: client.client_id,
      clientSecret,
      codeVerifier: c.code_verifier,
      nonce: c.nonce,
      redirectUri: c.redirect_uri,
      returnTo: c.return_to,
      purpose: c.purpose,
      startedAt: new Date(c.created_at).toISOString(),
    });
  },
});

export const stepUpRecordOp = defineOperation({
  name: "step_up.record",
  // Why human-only: records the caller's own verified Google sign-in on
  // their session (or the failed attempt) — the proof guarded ops consume.
  actorScope: ["human"],
  database: "cms_admin",
  input: z
    .object({
      sessionHash: sessionHashSchema,
      purpose: z.enum(STEP_UP_PURPOSES),
      outcome: z.discriminatedUnion("ok", [
        z.object({
          ok: z.literal(true),
          email: z.string().email(),
          /** Google's auth_time, seconds since epoch. */
          authTime: z.number().int().positive(),
          startedAt: z.string().datetime(),
        }),
        z.object({ ok: z.literal(false), reason: z.string().min(1).max(1000) }),
      ]),
    })
    .strict(),
  output: z.object({ freshUntil: z.string() }),
  handler: async (ctx, input, tx) => {
    const op = "step_up.record";
    const audit = (succeeded: boolean, resultSummary: string) =>
      recordAuditFromCtx(tx, ctx, {
        operation: op,
        input: { purpose: input.purpose, ok: input.outcome.ok },
        succeeded,
        resultSummary,
      });
    const refuse = async (message: string) => {
      await audit(false, message.slice(0, 200));
      return handlerError(op, message);
    };
    if (!input.outcome.ok) return refuse(`Google sign-in failed: ${input.outcome.reason}`);
    const session = await readSessionStepUp(tx, ctx.actorId, input.sessionHash);
    if (!session) return refuse("this browser session is not signed in any more");
    const { email, authTime, startedAt } = input.outcome;
    if (email.toLowerCase() !== session.userEmail.toLowerCase()) {
      return refuse(
        `You signed in to Google as ${email}, but this Caelo account is ${session.userEmail}. Sign in with ${session.userEmail}.`,
      );
    }
    const authMs = authTime * 1000;
    // Same checks as verifyFreshSignIn, repeated where the data is stored.
    if (authMs + 30_000 < new Date(startedAt).getTime() || authMs > Date.now() + 30_000) {
      return refuse("the Google sign-in is not from this confirmation");
    }
    await tx.execute(sql`
      UPDATE sessions
         SET step_up_at = to_timestamp(${authTime}), step_up_email = ${email.toLowerCase()}
       WHERE encode(sha256(convert_to(token, 'UTF8')), 'hex') = ${input.sessionHash}
         AND user_id = ${ctx.actorId}::uuid
    `);
    await audit(true, `fresh Google sign-in for ${input.purpose}`);
    return ok({ freshUntil: new Date(authMs + STEP_UP_MAX_AGE_SECONDS * 1000).toISOString() });
  },
});
