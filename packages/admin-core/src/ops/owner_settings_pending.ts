// SPDX-License-Identifier: MPL-2.0

/**
 * owner_settings.{propose_set_ai_budget, propose_set_ai_pricing,
 * propose_set_gateway_settings, execute_proposal, reject_proposal,
 * list_pending} — the §11.A gate for Owner settings the agent had no path
 * to at all.
 *
 * `ai_budgets.set`, `ai_pricing.set` and `gateway.set_settings` stay
 * human+system (see the `Why human-only` notes at each op): a spend cap, a
 * billing rate and the public write surface's abuse defences are decisions
 * whose mistakes cost money or let abuse through before anyone notices. So
 * the AI proposes and the operator approves in the chat (CLAUDE.md §11.A,
 * Plan B); `execute_proposal` then runs the existing op's handler on the
 * queued payload inside the same transaction, so the apply logic (pricing
 * cache invalidation, gateway pg_notify, the deploy.trigger guard, audit)
 * is the one the Owner panel already uses, not a copy of it.
 *
 * Every propose op validates the payload against exactly what the apply
 * step accepts and computes a before→after preview, so the click is never
 * spent on a proposal that could not apply and the operator sees what
 * changes. The gateway proposal is a PATCH: only the named fields change,
 * merged onto the row as it is at approve time, so an Owner edit made in
 * between is not reverted by an old proposal.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  err,
  ok,
  type ProposalStatus,
  proposalStatus,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { jsonbParam } from "../sql-helpers.js";
import { requiresApproverPermission } from "./_approver-permission.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  parsePayload,
  resolveChatSessionId,
} from "./_propose-helpers.js";
import { gatewaySettingsInput, getGatewaySettingsOp, setGatewaySettingsOp } from "./gateway.js";
import { aiBudgetCellInput, listAiBudgetsOp, setAiBudgetOp } from "./security/ai_budgets.js";
import { aiPricingRowInput, listAiPricingOp, setAiPricingOp } from "./security/ai_pricing.js";

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];
type Ctx = ExecutionContext;

const ownerSettingsKind = z.enum(["set_ai_budget", "set_ai_pricing", "set_gateway_settings"]);
type OwnerSettingsKind = z.infer<typeof ownerSettingsKind>;

/** Microcents (1e-8 USD) → "$1.23" for previews the operator reads. */
function usd(microcents: number | null): string | null {
  return microcents === null ? null : `$${(microcents / 100_000_000).toFixed(2)}`;
}

/** Microcents → "$0.04" with sub-cent precision kept (image prices). */
function usdExact(microcents: number): string {
  return `$${Number((microcents / 100_000_000).toFixed(6))}`;
}

/** Per-1K-token microcents → "$3/MTok", the unit providers publish. */
function perMTok(microcents: number | null | undefined): string | null {
  return microcents === null || microcents === undefined
    ? null
    : `$${Number((microcents / 100_000).toFixed(4))}/MTok`;
}

// ─── inputs ──────────────────────────────────────────────────────────

/**
 * A proposed budget cell. `warnAtPct` is optional here (unlike the Owner
 * form's default of 0.8): omitted means "keep the cell's current
 * threshold", resolved at propose time and stored, so asking only for a
 * new cap never silently resets a customised warning level.
 */
const proposedBudgetCell = aiBudgetCellInput.extend({
  warnAtPct: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Fraction of the cap at which the chat warns. Omit to keep the current threshold."),
});

export const proposeAiBudgetInput = z
  .object({ budgets: z.array(proposedBudgetCell).min(1).max(6) })
  .strict()
  .refine(
    (v) => new Set(v.budgets.map((b) => `${b.scope}/${b.operationType}`)).size === v.budgets.length,
    { message: "each (scope, operationType) may appear only once", path: ["budgets"] },
  );

export const proposeAiPricingInput = z
  .object({ rows: z.array(aiPricingRowInput).min(1).max(20) })
  .strict()
  .refine(
    (v) =>
      new Set(
        v.rows.map((r) => `${r.provider}/${r.model}/${r.operationType}/${r.effectiveFrom ?? ""}`),
      ).size === v.rows.length,
    {
      message: "each (provider, model, operationType, effectiveFrom) may appear only once",
      path: ["rows"],
    },
  );

export const proposeGatewaySettingsInput = gatewaySettingsInput
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "name at least one setting to change" });

// ─── shared queue insert ─────────────────────────────────────────────

async function queueProposal(
  tx: Tx,
  ctx: Ctx,
  kind: OwnerSettingsKind,
  payload: unknown,
  preview: Record<string, unknown>,
  opName: string,
  summary: string,
): Promise<
  | { ok: true; value: { proposalId: string; preview: Record<string, unknown> } }
  | { ok: false; error: { kind: "HandlerError"; operation: string; message: string } }
> {
  const payloadHash = await hashProposalPayload({ kind, payload });
  const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId);
  let rows: { id: string }[];
  try {
    rows = (await tx.execute(sql`
      INSERT INTO owner_settings_pending_actions
        (kind, proposed_by, payload, preview, status, chat_session_id, payload_hash)
      VALUES (
        ${kind},
        ${ctx.actorId}::uuid,
        ${jsonbParam(payload)},
        ${jsonbParam(preview)},
        'pending',
        ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`},
        ${payloadHash}
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
  } catch (e) {
    if (isDuplicatePendingError(e)) {
      return handlerError(opName, DUPLICATE_PROPOSAL_MESSAGE);
    }
    throw e;
  }
  const proposalId = rows[0]?.id;
  if (!proposalId) {
    return handlerError(opName, "insert returned no id");
  }
  await recordAudit(tx, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    operation: opName,
    input: payload,
    succeeded: true,
    entityId: proposalId,
    resultSummary: summary,
  });
  return ok({ proposalId, preview });
}

const proposeOutput = z.object({
  proposalId: z.string(),
  preview: z.record(z.string(), z.unknown()),
});

function handlerError(operation: string, message: string) {
  return err({ kind: "HandlerError" as const, operation, message });
}

function errorMessage(e: unknown): string {
  return typeof e === "object" && e && "message" in e
    ? String((e as { message: unknown }).message)
    : "unknown";
}

// ─── propose_set_ai_budget ───────────────────────────────────────────

export const proposeSetAiBudgetOp = defineOperation({
  name: "owner_settings.propose_set_ai_budget",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeAiBudgetInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const current = await listAiBudgetsOp.handler(ctx, {}, tx);
    if (!current.ok) return handlerError("owner_settings.propose_set_ai_budget", "read failed");
    const byKey = new Map(current.value.rows.map((r) => [`${r.scope}/${r.operationType}`, r]));
    const resolved = {
      budgets: input.budgets.map((b) => ({
        ...b,
        warnAtPct: b.warnAtPct ?? byKey.get(`${b.scope}/${b.operationType}`)?.warnAtPct ?? 0.8,
      })),
    };
    const changes = resolved.budgets.map((b) => {
      const cur = byKey.get(`${b.scope}/${b.operationType}`);
      return {
        scope: b.scope,
        operationType: b.operationType,
        from: cur
          ? {
              capMicrocents: cur.capMicrocents,
              capUsd: usd(cur.capMicrocents) ?? "unlimited",
              warnAtPct: cur.warnAtPct,
            }
          : null,
        to: {
          capMicrocents: b.capMicrocents,
          capUsd: usd(b.capMicrocents) ?? "unlimited",
          warnAtPct: b.warnAtPct,
        },
      };
    });
    const summary = changes
      .map((c) => `${c.scope}/${c.operationType} cap → ${c.to.capUsd}`)
      .join("; ");
    return queueProposal(
      tx,
      ctx,
      "set_ai_budget",
      resolved,
      { changes, summary },
      "owner_settings.propose_set_ai_budget",
      summary,
    );
  },
});

// ─── propose_set_ai_pricing ──────────────────────────────────────────

export const proposeSetAiPricingOp = defineOperation({
  name: "owner_settings.propose_set_ai_pricing",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeAiPricingInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const current = await listAiPricingOp.handler(ctx, {}, tx);
    if (!current.ok) return handlerError("owner_settings.propose_set_ai_pricing", "read failed");
    const byKey = new Map(
      current.value.rows.map((r) => [`${r.provider}/${r.model}/${r.operationType}`, r]),
    );
    // Text rates are per 1K tokens (shown $/MTok); an image row's input
    // rate is the price of ONE generated image (call-cost.ts multiplies it
    // by imageCount), so it is shown per image.
    const rate = (r: {
      operationType: "text" | "image";
      inputMicrocents: number;
      outputMicrocents: number | null;
      cachedMicrocents: number | null;
      cacheCreationMicrocents?: number | null;
    }) =>
      r.operationType === "image"
        ? { perImage: `${usdExact(r.inputMicrocents)}/image` }
        : {
            input: perMTok(r.inputMicrocents),
            output: perMTok(r.outputMicrocents),
            cacheRead: perMTok(r.cachedMicrocents),
            cacheWrite: perMTok(r.cacheCreationMicrocents),
          };
    const changes = input.rows.map((r) => {
      const cur = byKey.get(`${r.provider}/${r.model}/${r.operationType}`);
      return {
        provider: r.provider,
        model: r.model,
        operationType: r.operationType,
        from: cur ? rate(cur) : null,
        to: rate(r),
        effectiveFrom: r.effectiveFrom ?? "on approval",
        validFrom: r.validFrom ?? null,
        validTo: r.validTo ?? null,
      };
    });
    const summary = changes
      .map(
        (c) =>
          `${c.provider}/${c.model} (${c.operationType}) ${"perImage" in c.to ? c.to.perImage : `input ${c.to.input}`}`,
      )
      .join("; ");
    return queueProposal(
      tx,
      ctx,
      "set_ai_pricing",
      input,
      { changes, summary },
      "owner_settings.propose_set_ai_pricing",
      summary,
    );
  },
});

// ─── propose_set_gateway_settings ────────────────────────────────────

type GatewayPatch = z.infer<typeof proposeGatewaySettingsInput>;

/** The current settings row merged with `patch`, validated as a full row. */
async function mergedGatewaySettings(ctx: Ctx, tx: Tx, patch: GatewayPatch) {
  const current = await getGatewaySettingsOp.handler(ctx, {}, tx);
  if (!current.ok) return { ok: false as const, message: "could not read gateway settings" };
  const { cookieSecretSet: _secret, updatedAt: _at, ...base } = current.value.settings;
  const merged = gatewaySettingsInput.safeParse({ ...base, ...patch });
  if (!merged.success) {
    return {
      ok: false as const,
      message: merged.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  return { ok: true as const, base, merged: merged.data };
}

export const proposeSetGatewaySettingsOp = defineOperation({
  name: "owner_settings.propose_set_gateway_settings",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeGatewaySettingsInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const op = "owner_settings.propose_set_gateway_settings";
    // Same guard as gateway.set_settings, moved forward to propose time so
    // the operator is never asked to approve an infinite redeploy loop.
    if (input.autoRedeployOpKinds?.includes("deploy.trigger")) {
      return handlerError(
        op,
        "autoRedeployOpKinds must not include 'deploy.trigger' (the redeploy orchestrator fires it; listing it loops forever). Remove it and propose again.",
      );
    }
    const m = await mergedGatewaySettings(ctx, tx, input);
    if (!m.ok) return handlerError(op, m.message);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, to] of Object.entries(input)) {
      const from = (m.base as Record<string, unknown>)[key];
      if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
    }
    if (Object.keys(changes).length === 0) {
      return handlerError(
        op,
        "every named setting already has that value — nothing to change. Read the current values with get_gateway_settings first.",
      );
    }
    const summary = Object.entries(changes)
      .map(([k, c]) => `${k}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`)
      .join("; ");
    return queueProposal(tx, ctx, "set_gateway_settings", input, { changes, summary }, op, summary);
  },
});

// ─── execute / reject / list_pending ─────────────────────────────────

const executeOwnerSettingsProposalOpDefinition = defineOperation({
  name: "owner_settings.execute_proposal",
  // Why human-only (+system): §11.A — this is the operator's Approve. The
  // AI reaches it only through the gated tool, after the click.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({ kind: ownerSettingsKind, summary: z.string() }),
  handler: async (ctx, input, tx) => {
    const op = "owner_settings.execute_proposal";
    const rows = (await tx.execute(sql`
      SELECT kind, payload, preview, status
      FROM owner_settings_pending_actions
      WHERE id = ${input.proposalId}::uuid
      FOR UPDATE
    `)) as unknown as Array<{
      kind: OwnerSettingsKind;
      payload: unknown;
      preview: unknown;
      status: string;
    }>;
    const row = rows[0];
    if (!row) return handlerError(op, "proposal not found");
    if (row.status !== "pending") return handlerError(op, `proposal is already ${row.status}`);

    if (row.kind === "set_ai_budget") {
      const payload = proposeAiBudgetInput.parse(parsePayload(row.payload));
      for (const cell of payload.budgets) {
        const r = await setAiBudgetOp.handler(
          ctx,
          { ...cell, warnAtPct: cell.warnAtPct ?? 0.8 },
          tx,
        );
        if (!r.ok) return handlerError(op, `ai_budgets.set failed: ${errorMessage(r.error)}`);
      }
    } else if (row.kind === "set_ai_pricing") {
      const payload = proposeAiPricingInput.parse(parsePayload(row.payload));
      for (const pricing of payload.rows) {
        const r = await setAiPricingOp.handler(ctx, pricing, tx);
        if (!r.ok) return handlerError(op, `ai_pricing.set failed: ${errorMessage(r.error)}`);
      }
    } else {
      const patch = proposeGatewaySettingsInput.parse(parsePayload(row.payload));
      const m = await mergedGatewaySettings(ctx, tx, patch);
      if (!m.ok) return handlerError(op, m.message);
      const r = await setGatewaySettingsOp.handler(ctx, m.merged, tx);
      if (!r.ok) return handlerError(op, `gateway.set_settings failed: ${errorMessage(r.error)}`);
    }

    await tx.execute(sql`
      UPDATE owner_settings_pending_actions
      SET status = 'applied', decided_at = now(), decided_by = ${ctx.actorId}::uuid
      WHERE id = ${input.proposalId}::uuid
    `);
    const summary = String(parsePayload<{ summary?: unknown }>(row.preview).summary ?? row.kind);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: `${row.kind}: ${summary}`.slice(0, 500),
    });
    return ok({ kind: row.kind, summary });
  },
});

/** #589 — the approver must hold settings.write (see _approver-permission.ts). */
export const executeOwnerSettingsProposalOp = requiresApproverPermission(
  ["settings.write"],
  executeOwnerSettingsProposalOpDefinition,
);

export const rejectOwnerSettingsProposalOp = defineOperation({
  name: "owner_settings.reject_proposal",
  // Why human-only (+system): §11.A — the operator's Reject.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE owner_settings_pending_actions
      SET status = 'rejected',
          decided_at = now(),
          decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "owner_settings.reject_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.reason ?? "(no reason)",
    });
    return ok({});
  },
});

const proposalRowSchema = z.object({
  id: z.string(),
  kind: ownerSettingsKind,
  proposedBy: z.string(),
  payload: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.unknown()),
  status: proposalStatus,
  createdAt: z.string(),
  chatSessionId: z.string().nullable(),
});

export const listPendingOwnerSettingsProposalsOp = defineOperation({
  name: "owner_settings.list_pending",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
  output: z.object({ proposals: z.array(proposalRowSchema) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, proposed_by::text AS proposed_by, payload, preview,
             status, created_at, chat_session_id::text AS chat_session_id
      FROM owner_settings_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${input.limit ?? 50}
    `)) as unknown as Array<{
      id: string;
      kind: OwnerSettingsKind;
      proposed_by: string;
      payload: unknown;
      preview: unknown;
      status: ProposalStatus;
      created_at: string | Date;
      chat_session_id: string | null;
    }>;
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        proposedBy: r.proposed_by,
        payload: parsePayload<Record<string, unknown>>(r.payload),
        preview: parsePayload<Record<string, unknown>>(r.preview),
        status: r.status,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        chatSessionId: r.chat_session_id,
      })),
    });
  },
});
