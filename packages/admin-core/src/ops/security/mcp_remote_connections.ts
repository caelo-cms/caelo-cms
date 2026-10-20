// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — the Owner's controls over remote MCP connections
 * (`mcp_remote_connections`, migration 0310): one row per (user, surface),
 * created on the user's first remote request (see mcp_principal.ts).
 *
 *   mcp_remote_connections.list    — the connections the caller may see
 *                                    (an Owner: all; others: their own —
 *                                    RLS, migration 0316), with emails.
 *   mcp_remote_connections.revoke  — sticky: the user's next request is
 *                                    refused, and no request recreates it.
 *   mcp_remote_connections.restore — lift a revocation.
 *   mcp_remote_connections.set_cap — the AI cost cap and, on the admin
 *                                    surface, whether the agent may spend
 *                                    the install's own AI (#741).
 *
 * All human/system only, like the token registry: the AI must not be able
 * to enumerate or widen who reaches the site from outside.
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR_ID } from "../../audit.js";
import { withSystemRls } from "../_helpers.js";
import { mcpRemoteSurface } from "./mcp_credential.js";

const connectionRow = z.object({
  id: z.string(),
  actorId: z.string(),
  /** The user's email (null when the user was hard-deleted meanwhile). */
  email: z.string().nullable(),
  surface: mcpRemoteSurface,
  aiCostCapMicrocents: z.number().int().nonnegative().nullable(),
  allowCaeloAi: z.boolean(),
  /** The MCP client's self-reported name, e.g. "claude-ai". */
  clientLabel: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type McpRemoteConnectionRow = z.infer<typeof connectionRow>;

type RawRow = {
  id: string;
  actor_id: string;
  email: string | null;
  surface: "chat" | "admin";
  ai_cost_cap_microcents: bigint | string | number | null;
  allow_caelo_ai: boolean;
  client_label: string | null;
  created_at: string | Date;
  last_used_at: string | Date | null;
  revoked_at: string | Date | null;
};

const toIso = (v: string | Date | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);

function toRow(r: RawRow): McpRemoteConnectionRow {
  const cap = r.ai_cost_cap_microcents;
  return {
    id: r.id,
    actorId: r.actor_id,
    email: r.email,
    surface: r.surface,
    aiCostCapMicrocents:
      cap === null ? null : typeof cap === "string" ? Number.parseInt(cap, 10) : Number(cap),
    allowCaeloAi: r.allow_caelo_ai,
    clientLabel: r.client_label,
    createdAt: toIso(r.created_at) ?? "",
    lastUsedAt: toIso(r.last_used_at),
    revokedAt: toIso(r.revoked_at),
  };
}

async function selectRows(
  tx: TransactionRunner,
  ctx: Pick<ExecutionContext, "actorKind">,
  id?: string,
): Promise<McpRemoteConnectionRow[]> {
  // The connections themselves are read under the CALLER's RLS (migration
  // 0316): an Owner sees every user's, anyone else only their own. Only the
  // emails of those visible rows are then read with system RLS (users RLS
  // is self-or-system) — never a join under system RLS, which would lift the
  // connection scope too.
  const rows = (await tx.execute(sql`
    SELECT c.id::text AS id, c.actor_id::text AS actor_id, c.surface,
           c.ai_cost_cap_microcents, c.allow_caelo_ai, c.client_label,
           c.created_at, c.last_used_at, c.revoked_at
    FROM mcp_remote_connections c
    ${id === undefined ? sql`` : sql`WHERE c.id = ${id}::uuid`}
    ORDER BY c.last_used_at DESC NULLS LAST, c.created_at DESC
  `)) as unknown as Omit<RawRow, "email">[];
  const actorIds = [...new Set(rows.map((r) => r.actor_id))];
  const emails = new Map<string, string>();
  if (actorIds.length > 0) {
    const users = (await withSystemRls(tx, ctx, () =>
      tx.execute(sql`
        SELECT id::text AS id, email FROM users
        WHERE id IN (${sql.join(
          actorIds.map((a) => sql`${a}::uuid`),
          sql`, `,
        )})
      `),
    )) as unknown as { id: string; email: string }[];
    for (const u of users) emails.set(u.id, u.email);
  }
  return rows.map((r) => toRow({ ...r, email: emails.get(r.actor_id) ?? null }));
}

/**
 * Apply an Owner's change to one connection. RLS (0316) lets only system or
 * a human Owner update, so "no row updated" means the id is unknown OR not
 * the caller's to change — the same answer either way, like mcp_tokens.
 */
async function updateOne(
  tx: TransactionRunner,
  operation: string,
  id: string,
  set: SQL,
): Promise<{ ok: true } | ReturnType<typeof notFound>> {
  const updated = (await tx.execute(sql`
    UPDATE mcp_remote_connections SET ${set} WHERE id = ${id}::uuid RETURNING id
  `)) as unknown as { id: string }[];
  return updated.length === 1 ? { ok: true } : notFound(operation, id);
}

function notFound(operation: string, id: string) {
  return err({
    kind: "HandlerError" as const,
    operation,
    message: `remote connection ${id} not found, or not yours to change — only an Owner (settings.write) revokes, restores or caps remote connections. List the ones you can see with mcp_remote_connections.list.`,
  });
}

export const listMcpRemoteConnectionsOp = defineOperation({
  name: "mcp_remote_connections.list",
  // Why human-only: the registry of who reaches the site from outside is
  // Owner-controlled, like mcp_tokens.list — the AI must not enumerate it.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ connections: z.array(connectionRow) }),
  handler: async (ctx, _input, tx) => ok({ connections: await selectRows(tx, ctx) }),
});

export const revokeMcpRemoteConnectionOp = defineOperation({
  name: "mcp_remote_connections.revoke",
  // Why human-only: credential lifecycle (same as mcp_tokens.revoke).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ id: z.string().uuid() }).strict(),
  output: z.object({ connection: connectionRow }),
  handler: async (ctx, input, tx) => {
    // COALESCE keeps the first revocation's timestamp on a repeat.
    const updated = await updateOne(
      tx,
      "mcp_remote_connections.revoke",
      input.id,
      sql`revoked_at = COALESCE(revoked_at, now()), current_chat_session_id = NULL`,
    );
    if (!updated.ok) return updated;
    const [row] = await selectRows(tx, ctx, input.id);
    if (!row) return notFound("mcp_remote_connections.revoke", input.id);
    await recordAudit(tx, {
      actorId: ctx.actorId ?? SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "mcp_remote_connections.revoke",
      input,
      succeeded: true,
      entityId: input.id,
      resultSummary: `surface=${row.surface} user=${row.email ?? row.actorId}`,
    });
    return ok({ connection: row });
  },
});

export const restoreMcpRemoteConnectionOp = defineOperation({
  name: "mcp_remote_connections.restore",
  // Why human-only: re-opens remote access — the Owner's decision only.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ id: z.string().uuid() }).strict(),
  output: z.object({ connection: connectionRow }),
  handler: async (ctx, input, tx) => {
    const updated = await updateOne(
      tx,
      "mcp_remote_connections.restore",
      input.id,
      sql`revoked_at = NULL`,
    );
    if (!updated.ok) return updated;
    const [row] = await selectRows(tx, ctx, input.id);
    if (!row) return notFound("mcp_remote_connections.restore", input.id);
    await recordAudit(tx, {
      actorId: ctx.actorId ?? SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "mcp_remote_connections.restore",
      input,
      succeeded: true,
      entityId: input.id,
      resultSummary: `surface=${row.surface} user=${row.email ?? row.actorId}`,
    });
    return ok({ connection: row });
  },
});

export const setMcpRemoteConnectionCapOp = defineOperation({
  name: "mcp_remote_connections.set_cap",
  // Why human-only: spending limits on the install's AI are the Owner's
  // (mcp_tokens carry theirs from mint time, set by the Owner too).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      id: z.string().uuid(),
      /** Microcents (USD × 1e8); null = uncapped. */
      aiCostCapMicrocents: z.number().int().nonnegative().nullable(),
      /**
       * #741 — admin surface only: the agent may use the install's own AI
       * (image generation, Caelo-side translation runs). Omit to keep it.
       */
      allowCaeloAi: z.boolean().optional(),
    })
    .strict(),
  output: z.object({ connection: connectionRow }),
  handler: async (ctx, input, tx) => {
    const [current] = await selectRows(tx, ctx, input.id);
    if (!current) return notFound("mcp_remote_connections.set_cap", input.id);
    if (input.allowCaeloAi === true && current.surface !== "admin") {
      return err({
        kind: "HandlerError",
        operation: "mcp_remote_connections.set_cap",
        message:
          "allowCaeloAi applies to admin-surface connections only — a chat connection always runs Caelo's own agent. Drop the flag.",
      });
    }
    const updated = await updateOne(
      tx,
      "mcp_remote_connections.set_cap",
      input.id,
      sql`ai_cost_cap_microcents = ${input.aiCostCapMicrocents},
          allow_caelo_ai = ${input.allowCaeloAi ?? current.allowCaeloAi}`,
    );
    if (!updated.ok) return updated;
    const [row] = await selectRows(tx, ctx, input.id);
    if (!row) return notFound("mcp_remote_connections.set_cap", input.id);
    await recordAudit(tx, {
      actorId: ctx.actorId ?? SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "mcp_remote_connections.set_cap",
      input,
      succeeded: true,
      entityId: input.id,
      resultSummary: `cap=${row.aiCostCapMicrocents ?? "none"} allowCaeloAi=${row.allowCaeloAi}`,
    });
    return ok({ connection: row });
  },
});
