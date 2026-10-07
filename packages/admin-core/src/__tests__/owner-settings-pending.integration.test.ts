// SPDX-License-Identifier: MPL-2.0

/**
 * owner_settings.* (migration 0234) — the §11.A gate for AI budgets, AI
 * pricing and gateway settings, against a real Postgres.
 *
 * Per kind: propose (AI) lands a pending row with a before→after preview;
 * the AI cannot apply it itself; execute_proposal (Owner) applies the
 * existing op and flips the row to applied; re-executing fails loudly. Plus
 * the paths the operator actually uses: the chat's gated execute
 * (attachGatedExecute — propose + execute after the in-chat Approve), the
 * cross-domain inbox, reject, cancel and duplicate suppression.
 *
 * Mutates site-wide settings (budgets, gateway) — the originals are captured
 * in beforeAll and restored in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { attachGatedExecute } from "../ai/tools/gated-tools.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const OWNER: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000005e1",
  actorKind: "human",
  requestId: "owner-settings-test-owner",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000005e2",
  actorKind: "ai",
  requestId: "owner-settings-test-ai",
};
const PROVIDER = "owner-settings-test-provider";

interface BudgetRow {
  scope: string;
  operation_type: string;
  cap_microcents: string | null;
  warn_at_pct: string;
}
interface GatewayRow {
  gateway_max_body_bytes: number;
  auto_redeploy_enabled: boolean;
  auto_redeploy_debounce_ms: number;
  auto_redeploy_op_kinds: string[];
  captcha_provider: string;
  captcha_pow_target_prefix: string;
}
let savedBudgets: BudgetRow[] = [];
let savedGateway: GatewayRow | undefined;

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    let out!: T;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      out = await fn(tx as unknown as SQL);
    });
    return out;
  } finally {
    await sql.end();
  }
}

async function wipeTestRows(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM owner_settings_pending_actions WHERE proposed_by IN (${AI.actorId}::uuid, ${OWNER.actorId}::uuid)`;
    await tx`DELETE FROM ai_pricing WHERE provider = ${PROVIDER}`;
  });
}

function value<T>(r: { ok: boolean }): T {
  if (!r.ok) throw new Error(`op failed: ${JSON.stringify(r)}`);
  return (r as unknown as { value: T }).value;
}

beforeAll(async () => {
  await asSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER.actorId}::uuid, 'human', 'owner-settings-owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${AI.actorId}::uuid, 'ai', 'owner-settings-ai') ON CONFLICT DO NOTHING`;
    savedBudgets =
      (await tx`SELECT scope, operation_type, cap_microcents::text AS cap_microcents, warn_at_pct::text AS warn_at_pct FROM ai_budgets`) as BudgetRow[];
    const g = (await tx`
      SELECT gateway_max_body_bytes, auto_redeploy_enabled, auto_redeploy_debounce_ms,
             auto_redeploy_op_kinds, captcha_provider, captcha_pow_target_prefix
      FROM site_settings WHERE id = 1`) as GatewayRow[];
    savedGateway = g[0];
  });
  await wipeTestRows();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipeTestRows();
  await asSystem(async (tx) => {
    await tx`DELETE FROM ai_budgets`;
    for (const b of savedBudgets) {
      await tx`INSERT INTO ai_budgets (scope, operation_type, cap_microcents, warn_at_pct)
               VALUES (${b.scope}, ${b.operation_type}, ${b.cap_microcents}::bigint, ${b.warn_at_pct}::numeric)`;
    }
    const g = savedGateway;
    if (g) {
      await tx`UPDATE site_settings SET
        gateway_max_body_bytes = ${g.gateway_max_body_bytes},
        auto_redeploy_enabled = ${g.auto_redeploy_enabled},
        auto_redeploy_debounce_ms = ${g.auto_redeploy_debounce_ms},
        auto_redeploy_op_kinds = ${tx.array(g.auto_redeploy_op_kinds ?? [], "text")},
        captcha_provider = ${g.captcha_provider},
        captcha_pow_target_prefix = ${g.captcha_pow_target_prefix}
        WHERE id = 1`;
    }
  });
  await adapter.close();
});

async function pendingRow(id: string) {
  return asSystem(async (tx) => {
    const rows = (await tx`
      SELECT kind, status, payload_hash, preview FROM owner_settings_pending_actions WHERE id = ${id}::uuid`) as Array<{
      kind: string;
      status: string;
      payload_hash: string | null;
      preview: unknown;
    }>;
    return rows[0];
  });
}

describe("owner_settings — AI budget", () => {
  const input = {
    budgets: [
      { scope: "day-global", operationType: "image", capMicrocents: 500_000_000, warnAtPct: 0.5 },
    ],
  };
  let proposalId = "";

  it("AI proposes: pending row + from/to preview in USD", async () => {
    const v = value<{
      proposalId: string;
      preview: { changes: Array<{ to: { capUsd: string } }> };
    }>(await execute(registry, adapter, AI, "owner_settings.propose_set_ai_budget", input));
    proposalId = v.proposalId;
    expect(v.preview.changes[0]?.to.capUsd).toBe("$5.00");
    const row = await pendingRow(proposalId);
    expect(row?.kind).toBe("set_ai_budget");
    expect(row?.status).toBe("pending");
    expect(row?.payload_hash).toBeTruthy();
  });

  it("an identical proposal while one is pending is refused", async () => {
    const r = await execute(registry, adapter, AI, "owner_settings.propose_set_ai_budget", input);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("already pending");
  });

  it("the AI cannot apply its own proposal", async () => {
    const r = await execute(registry, adapter, AI, "owner_settings.execute_proposal", {
      proposalId,
    });
    expect(r.ok).toBe(false);
    expect((r as { error: { kind: string } }).error.kind).toBe("ActorScopeRejected");
  });

  it("Owner approve applies ai_budgets.set and marks the row applied", async () => {
    const v = value<{ kind: string }>(
      await execute(registry, adapter, OWNER, "owner_settings.execute_proposal", { proposalId }),
    );
    expect(v.kind).toBe("set_ai_budget");
    const budgets = value<{
      rows: Array<{ scope: string; operationType: string; capMicrocents: number | null }>;
    }>(await execute(registry, adapter, OWNER, "ai_budgets.list", {}));
    const cell = budgets.rows.find((b) => b.scope === "day-global" && b.operationType === "image");
    expect(cell?.capMicrocents).toBe(500_000_000);
    expect((await pendingRow(proposalId))?.status).toBe("applied");
  });

  it("re-executing an applied proposal fails loudly", async () => {
    const r = await execute(registry, adapter, OWNER, "owner_settings.execute_proposal", {
      proposalId,
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("already applied");
  });

  it("duplicate (scope, operationType) cells in one proposal are rejected", async () => {
    const cell = { scope: "session", operationType: "text", capMicrocents: 1, warnAtPct: 0.8 };
    const r = await execute(registry, adapter, AI, "owner_settings.propose_set_ai_budget", {
      budgets: [cell, cell],
    });
    expect(r.ok).toBe(false);
  });
});

describe("owner_settings — AI pricing", () => {
  it("propose → approve writes all rate columns + the validity window", async () => {
    const proposed = value<{
      proposalId: string;
      preview: { changes: Array<{ from: unknown; to: { input: string } }> };
    }>(
      await execute(registry, adapter, AI, "owner_settings.propose_set_ai_pricing", {
        rows: [
          {
            provider: PROVIDER,
            model: "m-1",
            operationType: "text",
            inputMicrocents: 300_000,
            outputMicrocents: 1_500_000,
            cachedMicrocents: 30_000,
            cacheCreationMicrocents: 375_000,
            effectiveFrom: "2026-01-01T00:00:00Z",
            validFrom: "2026-01-01T00:00:00Z",
            validTo: "2099-12-31T23:59:59Z",
          },
        ],
      }),
    );
    expect(proposed.preview.changes[0]?.from).toBeNull();
    expect(proposed.preview.changes[0]?.to.input).toBe("$3/MTok");

    value(
      await execute(registry, adapter, OWNER, "owner_settings.execute_proposal", {
        proposalId: proposed.proposalId,
      }),
    );
    const rows = await asSystem(
      (tx) =>
        tx`SELECT input_microcents::int AS input, cache_creation_microcents::int AS cw,
                  valid_to IS NOT NULL AS dated
           FROM ai_pricing WHERE provider = ${PROVIDER}` as Promise<
          Array<{ input: number; cw: number; dated: boolean }>
        >,
    );
    expect(rows).toEqual([{ input: 300_000, cw: 375_000, dated: true }]);
    expect((await pendingRow(proposed.proposalId))?.status).toBe("applied");
  });

  it("an inverted validity window never reaches the operator", async () => {
    const r = await execute(registry, adapter, AI, "owner_settings.propose_set_ai_pricing", {
      rows: [
        {
          provider: PROVIDER,
          model: "m-2",
          operationType: "text",
          inputMicrocents: 1,
          outputMicrocents: 1,
          cachedMicrocents: null,
          validFrom: "2027-01-01T00:00:00Z",
          validTo: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(r.ok).toBe(false);
  });
});

describe("owner_settings — gateway settings", () => {
  it("refuses deploy.trigger and no-op patches at propose time", async () => {
    const loop = await execute(
      registry,
      adapter,
      AI,
      "owner_settings.propose_set_gateway_settings",
      { autoRedeployOpKinds: ["deploy.trigger"] },
    );
    expect(loop.ok).toBe(false);
    const current = value<{ settings: { maxBodyBytes: number } }>(
      await execute(registry, adapter, OWNER, "gateway.get_settings", {}),
    );
    const noop = await execute(
      registry,
      adapter,
      AI,
      "owner_settings.propose_set_gateway_settings",
      { maxBodyBytes: current.settings.maxBodyBytes },
    );
    expect(noop.ok).toBe(false);
    expect(JSON.stringify(noop)).toContain("nothing to change");
  });

  it("applies only the proposed fields, merged onto the row as it is at approve time", async () => {
    const before = value<{ settings: Record<string, unknown> }>(
      await execute(registry, adapter, OWNER, "gateway.get_settings", {}),
    ).settings;
    const newCaptcha = before.captchaProvider === "off" ? "pow" : "off";
    const proposed = value<{ proposalId: string; preview: { changes: Record<string, unknown> } }>(
      await execute(registry, adapter, AI, "owner_settings.propose_set_gateway_settings", {
        captchaProvider: newCaptcha,
      }),
    );
    expect(Object.keys(proposed.preview.changes)).toEqual(["captchaProvider"]);

    // The Owner edits a different knob between propose and approve.
    const { cookieSecretSet: _c, updatedAt: _u, ...full } = before;
    value(
      await execute(registry, adapter, OWNER, "gateway.set_settings", {
        ...full,
        maxBodyBytes: 4096,
      }),
    );

    value(
      await execute(registry, adapter, OWNER, "owner_settings.execute_proposal", {
        proposalId: proposed.proposalId,
      }),
    );
    const after = value<{ settings: Record<string, unknown> }>(
      await execute(registry, adapter, OWNER, "gateway.get_settings", {}),
    ).settings;
    expect(after.captchaProvider).toBe(newCaptcha);
    expect(after.maxBodyBytes).toBe(4096);
  });
});

describe("owner_settings — queue plumbing", () => {
  it("shows in the cross-domain inbox; Owner reject + AI cancel both close it", async () => {
    const a = value<{ proposalId: string }>(
      await execute(registry, adapter, AI, "owner_settings.propose_set_gateway_settings", {
        autoRedeployDebounceMs: 45_000,
      }),
    );
    const inbox = value<{
      items: Array<{ domain: string; proposalId: string }>;
      byDomain: Record<string, number>;
    }>(await execute(registry, adapter, OWNER, "pending_proposals.list", { limit: 200 }));
    expect(
      inbox.items.some((i) => i.proposalId === a.proposalId && i.domain === "owner_settings"),
    ).toBe(true);
    expect(inbox.byDomain.owner_settings).toBeGreaterThanOrEqual(1);

    value(
      await execute(registry, adapter, OWNER, "owner_settings.reject_proposal", {
        proposalId: a.proposalId,
        reason: "not now",
      }),
    );
    expect((await pendingRow(a.proposalId))?.status).toBe("rejected");

    const b = value<{ proposalId: string }>(
      await execute(registry, adapter, AI, "owner_settings.propose_set_gateway_settings", {
        autoRedeployDebounceMs: 46_000,
      }),
    );
    const cancelled = value<{ domain: string }>(
      await execute(registry, adapter, AI, "pending_proposals.cancel", {
        proposalId: b.proposalId,
      }),
    );
    expect(cancelled.domain).toBe("owner_settings");
    expect((await pendingRow(b.proposalId))?.status).toBe("cancelled");
  });
});

describe("owner_settings — chat gated execute (the in-chat Approve path)", () => {
  it("propose_set_ai_budget applies end to end once the SDK runs the approved execute", async () => {
    const tool = createDefaultToolRegistry()
      .catalogue()
      .find((t) => t.name === "propose_set_ai_budget");
    expect(tool?.gated).toEqual({
      proposeOp: "owner_settings.propose_set_ai_budget",
      executeOp: "owner_settings.execute_proposal",
    });
    if (!tool) throw new Error("propose_set_ai_budget not registered");
    const gated = attachGatedExecute(tool, registry, adapter, AI, OWNER);
    const out = (await gated.execute?.({
      budgets: [
        { scope: "day-per-actor", operationType: "text", capMicrocents: null, warnAtPct: 0.9 },
      ],
    })) as { ok: boolean; value?: { kind: string } };
    expect(out.ok).toBe(true);
    expect(out.value?.kind).toBe("set_ai_budget");
    const budgets = value<{
      rows: Array<{ scope: string; operationType: string; warnAtPct: number }>;
    }>(await execute(registry, adapter, OWNER, "ai_budgets.list", {}));
    const cell = budgets.rows.find(
      (b) => b.scope === "day-per-actor" && b.operationType === "text",
    );
    expect(cell?.warnAtPct).toBeCloseTo(0.9);
  });
});

describe("Owner panel writes (regressions fixed alongside the gate)", () => {
  it("ai_budgets.set and ai_pricing.set succeed for a human actor (0234 RLS fix)", async () => {
    // Before 0234 both tables' WITH CHECK admitted only actor_kind=system,
    // so the /security/ai/budgets and /security/ai/pricing forms (human
    // actor) were RLS-denied on every save.
    value(
      await execute(registry, adapter, OWNER, "ai_budgets.set", {
        scope: "session",
        operationType: "image",
        capMicrocents: 123,
        warnAtPct: 0.8,
      }),
    );
    value(
      await execute(registry, adapter, OWNER, "ai_pricing.set", {
        provider: PROVIDER,
        model: "panel",
        operationType: "image",
        inputMicrocents: 1,
        outputMicrocents: null,
        cachedMicrocents: null,
      }),
    );
  });

  it("the AI still cannot write ai_budgets directly", async () => {
    const r = await execute(registry, adapter, AI, "ai_budgets.set", {
      scope: "session",
      operationType: "image",
      capMicrocents: 1,
      warnAtPct: 0.8,
    });
    expect((r as { error?: { kind: string } }).error?.kind).toBe("ActorScopeRejected");
  });

  it("gateway.set_settings saves a non-empty autoRedeployOpKinds list", async () => {
    // The text[] column used to receive a drizzle-expanded row constructor
    // and Postgres rejected every save with a non-empty list.
    const {
      cookieSecretSet: _c,
      updatedAt: _u,
      ...full
    } = value<{
      settings: Record<string, unknown>;
    }>(await execute(registry, adapter, OWNER, "gateway.get_settings", {})).settings;
    value(
      await execute(registry, adapter, OWNER, "gateway.set_settings", {
        ...full,
        autoRedeployOpKinds: ["pages.update", "media.publish"],
      }),
    );
    const after = value<{ settings: { autoRedeployOpKinds: string[] } }>(
      await execute(registry, adapter, OWNER, "gateway.get_settings", {}),
    ).settings;
    expect(after.autoRedeployOpKinds).toEqual(["pages.update", "media.publish"]);
  });
});
