// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #971 — credentials an approved proposal produces never reach the AI.
 *
 * The in-chat approval gate (CLAUDE.md §11.A) hands an executor's output to
 * the model as the tool result, and over remote MCP that model belongs to a
 * third party. So an executor that creates something with a credential (a
 * user's temporary password, an MCP bearer token) creates it WITHOUT a usable
 * credential and records a handoff instead: a row addressed to the human who
 * approved, holding no secret at all. That human issues the credential from
 * the admin (`credentials.issue`, human-only): it is generated at that moment,
 * returned once to their browser, and the row is stamped. Nothing secret is
 * ever stored, so there is nothing for a backup, a log or an AI-reachable read
 * to leak.
 *
 * The AI's result carries only {@link CredentialHandoffRef} plus
 * {@link describeCredentialHandoffForAi} — where the operator finds the
 * credential, never the value.
 *
 * Adding a credential-producing executor: add its kind to
 * {@link CREDENTIAL_KINDS} (and the 0342 CHECK), an issuer in `issueFor`, an
 * operator-facing location in {@link HANDOFF_LOCATIONS}, and declare
 * `producesCredential` on its gated tool (`makeProposeTool`) — the catalogue
 * test (credential-free-ai-results.test.ts) fails until all four line up.
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { hashPassword } from "../password.js";
import { withSystemRls } from "./_helpers.js";
import { issueResetToken } from "./auth.js";
import { mintMcpTokenSecret } from "./security/mcp_token_secret.js";

/** Every kind of credential a handoff can issue. */
export const CREDENTIAL_KINDS = ["user_temporary_password", "mcp_token"] as const;
export const credentialKind = z.enum(CREDENTIAL_KINDS);
export type CredentialKind = z.infer<typeof credentialKind>;

/** What an executor's output (and so the AI's tool result) carries instead of the secret. */
export const credentialHandoffRef = z.object({
  handoffId: z.string().uuid(),
  kind: credentialKind,
  expiresAt: z.string(),
});
export type CredentialHandoffRef = z.infer<typeof credentialHandoffRef>;

/** Where in the admin the approving operator issues each kind (outside the chat strip). */
export const HANDOFF_LOCATIONS: Readonly<Record<CredentialKind, { label: string; path: string }>> =
  {
    user_temporary_password: { label: "Settings → Users", path: "/settings/users" },
    mcp_token: { label: "Settings → MCP", path: "/settings/mcp" },
  };

/**
 * The sentence the AI reads in place of the credential. It names where the
 * operator gets it and forbids the AI from offering it — the model must not
 * say "tell me if you need it", because it never has it.
 */
export function describeCredentialHandoffForAi(ref: CredentialHandoffRef): string {
  const where = HANDOFF_LOCATIONS[ref.kind];
  const what =
    ref.kind === "user_temporary_password"
      ? "The new user's one-time password was NOT generated into this result"
      : "The new MCP token was NOT put into this result";
  const extra =
    ref.kind === "user_temporary_password"
      ? " — or have it emailed to the new user as a set-password link when email is set up"
      : "";
  return (
    `${what}: you cannot see, ask for, store or relay credentials, and must not offer to. ` +
    `Tell the operator that the person who clicked Approve gets it in the Caelo admin, shown once: ` +
    `the "One-time credentials" box in the Live Edit chat or ${where.label} (${where.path})${extra}. ` +
    `It can be collected until ${ref.expiresAt}.`
  );
}

const HANDOFF_TTL_DAYS = 7;

/**
 * Record a handoff for `ctx`'s actor (the approver) inside the approving
 * transaction. The recipient is always `ctx.actorId`, which the RLS policy
 * accepts both in a human transaction and in one an executor already
 * switched to system (users.execute_proposal does) — so this leaves the
 * transaction's actor kind alone.
 */
export async function recordCredentialHandoff(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  args: { kind: CredentialKind; subjectId: string; label: string; proposalId: string | null },
): Promise<CredentialHandoffRef> {
  const rows = (await tx.execute(sql`
    INSERT INTO credential_handoffs (kind, subject_id, label, recipient_actor_id, proposal_id, expires_at)
    VALUES (${args.kind}, ${args.subjectId}::uuid, ${args.label}, ${ctx.actorId}::uuid,
            ${args.proposalId === null ? null : sql`${args.proposalId}::uuid`},
            now() + make_interval(days => ${HANDOFF_TTL_DAYS}))
    RETURNING id::text AS id, expires_at
  `)) as unknown as { id: string; expires_at: string | Date }[];
  const row = rows[0];
  if (!row) throw new Error("credential_handoffs insert returned no row");
  return {
    handoffId: row.id,
    kind: args.kind,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** A random password nobody ever sees: the account exists, but cannot sign in until issued. */
export function unusablePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

// ─── credentials.list_handoffs ───────────────────────────────────────

const handoffRow = z.object({
  id: z.string(),
  kind: credentialKind,
  label: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export const listCredentialHandoffsOp = defineOperation({
  name: "credentials.list_handoffs",
  // Why human-only: the queue of credentials waiting for the human who
  // approved them (#971). The rows hold no secret, but the AI has no use for
  // them — it is told where the operator finds them, and RLS hides them from
  // an `ai` actor anyway.
  actorScope: ["human"],
  database: "cms_admin",
  input: z.object({ kind: credentialKind.optional() }).strict(),
  output: z.object({ handoffs: z.array(handoffRow) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, label, created_at, expires_at
      FROM credential_handoffs
      WHERE issued_at IS NULL AND expires_at > now()
        ${input.kind ? sql`AND kind = ${input.kind}` : sql``}
      ORDER BY created_at DESC
      LIMIT 50
    `)) as unknown as {
      id: string;
      kind: CredentialKind;
      label: string;
      created_at: string | Date;
      expires_at: string | Date;
    }[];
    return ok({
      handoffs: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        label: r.label,
        createdAt: new Date(r.created_at).toISOString(),
        expiresAt: new Date(r.expires_at).toISOString(),
      })),
    });
  },
});

// ─── credentials.issue ───────────────────────────────────────────────

const issueVia = z.enum(["reveal", "email"]);

export const issueCredentialOp = defineOperation({
  name: "credentials.issue",
  // Why human-only: generates a credential and returns it in plain text
  // (#971). Only the human who approved its proposal may call it (RLS binds
  // the row to them); no AI or MCP surface ever reaches it.
  actorScope: ["human"],
  database: "cms_admin",
  input: z.object({ handoffId: z.string().uuid(), via: issueVia.default("reveal") }).strict(),
  output: z.object({
    kind: credentialKind,
    label: z.string(),
    /** The credential, shown once — `via: "reveal"` only. */
    secret: z.string().nullable(),
    /** The set-password link to email the new user — `via: "email"` only. */
    emailDelivery: z
      .object({ email: z.string(), displayName: z.string(), token: z.string() })
      .nullable(),
  }),
  handler: async (ctx, input, tx) => {
    const op = "credentials.issue";
    // Claim first: the stamp makes a second click (or a second tab) fail
    // instead of minting a second credential.
    const claimed = (await tx.execute(sql`
      UPDATE credential_handoffs
         SET issued_at = now(), issued_via = ${input.via}
       WHERE id = ${input.handoffId}::uuid
         AND recipient_actor_id = ${ctx.actorId}::uuid
         AND issued_at IS NULL
         AND expires_at > now()
      RETURNING kind, subject_id::text AS subject_id, label
    `)) as unknown as { kind: CredentialKind; subject_id: string; label: string }[];
    const row = claimed[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: op,
        message:
          "This credential was already collected, has expired, or was approved by someone else. " +
          "Reset the user's password under Settings → Users, or mint a new MCP token under Settings → MCP.",
      });
    }
    if (input.via === "email" && row.kind !== "user_temporary_password") {
      return err({
        kind: "HandlerError",
        operation: op,
        message: "Only a new user's password can be sent by email; reveal this credential instead.",
      });
    }
    const issued = await issueFor(tx, ctx, row.kind, row.subject_id, input.via);
    if (!issued.ok) return err({ kind: "HandlerError", operation: op, message: issued.message });
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input,
      succeeded: true,
      entityId: row.subject_id,
      // Never the credential itself.
      resultSummary: `${row.kind} issued via ${input.via}`,
    });
    return ok({
      kind: row.kind,
      label: row.label,
      secret: issued.secret,
      emailDelivery: issued.emailDelivery,
    });
  },
});

type Issued =
  | {
      ok: true;
      secret: string | null;
      emailDelivery: { email: string; displayName: string; token: string } | null;
    }
  | { ok: false; message: string };

/**
 * Generate the credential for one handoff. Writes another user's row
 * (`users`, `sessions`) or a token row, so it runs under the system RLS
 * bypass; the claim above is what authorised it.
 */
async function issueFor(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  kind: CredentialKind,
  subjectId: string,
  via: z.infer<typeof issueVia>,
): Promise<Issued> {
  return withSystemRls(tx, ctx, async (): Promise<Issued> => {
    if (kind === "user_temporary_password") {
      const users = (await tx.execute(sql`
        SELECT u.email AS email, a.display_name AS display_name
        FROM users u JOIN actors a ON a.id = u.id
        WHERE u.id = ${subjectId}::uuid AND u.deleted_at IS NULL
      `)) as unknown as { email: string; display_name: string }[];
      const user = users[0];
      if (!user) return { ok: false, message: "That user was deleted; nothing to issue." };
      if (via === "email") {
        const { token } = await issueResetToken(tx, subjectId);
        return {
          ok: true,
          secret: null,
          emailDelivery: { email: user.email, displayName: user.display_name, token },
        };
      }
      // 16 random bytes → ~22 base64url chars: easy to paste, strong enough
      // for a password the user replaces after signing in.
      const password = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
        "base64url",
      );
      await tx.execute(
        sql`UPDATE users SET password_hash = ${await hashPassword(password)} WHERE id = ${subjectId}::uuid`,
      );
      await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${subjectId}::uuid`);
      return { ok: true, secret: password, emailDelivery: null };
    }
    // mcp_token: re-key the token minted at approval (its first secret was
    // discarded unseen) and hand out the new one.
    const { plaintext, hash } = await mintMcpTokenSecret();
    const updated = (await tx.execute(sql`
      UPDATE mcp_tokens SET token_hash = ${hash}
       WHERE id = ${subjectId}::uuid AND revoked_at IS NULL AND expires_at > now()
      RETURNING id
    `)) as unknown as { id: string }[];
    if (updated.length === 0) {
      return { ok: false, message: "That MCP token was revoked or has expired; mint a new one." };
    }
    return { ok: true, secret: plaintext, emailDelivery: null };
  });
}
