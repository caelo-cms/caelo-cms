// SPDX-License-Identifier: MPL-2.0

/**
 * issue #264 — per-entity sub-leases guard concurrent same-branch writers.
 *
 * The gap PR #291 found: the branch lock (`chat_entity_locks`) keys on the
 * branch SESSION, so parallel sibling subagents — which all run on the
 * PARENT chat's branch via `chatBranchIdOverride` — resolve to one session
 * and the branch lock permits ALL of them to write the SAME entity. Two
 * siblings touching one module was then a silent last-writer-wins lost
 * update.
 *
 * This test drives two writers that share a branch but carry DISTINCT
 * `chatTaskId`s (each subagent's own ephemeral session id — its lease
 * holder). Concurrent writes to the same module must resolve to exactly
 * one winner + one clean `SiblingLeaseConflict`; a same-holder re-edit is
 * a no-op refresh; and once the winner's lease is released on
 * `subagent_runs.finish`, the loser can take the entity.
 *
 * Integration tier (needs a real Postgres for the `FOR UPDATE` race);
 * never run against a dev DB.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const PFX = "issue264-leases-";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM entity_leases WHERE branch_id IN (SELECT chat_branch_id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM subagent_runs WHERE subagent_chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM chat_entity_locks WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

const sysCtx: ExecutionContext = {
  actorId: HUMAN,
  actorKind: "system",
  requestId: "issue264-setup",
};

/** A sibling writer's ctx: shared branch, its OWN session as the holder. */
function siblingCtx(branchId: string, holderSessionId: string, rid: string): ExecutionContext {
  return {
    actorId: HUMAN,
    actorKind: "system",
    requestId: rid,
    chatBranchId: branchId,
    chatTaskId: holderSessionId,
  };
}

describe("issue #264 — entity leases refuse concurrent same-branch writers", () => {
  it("two siblings writing the same module → one wins, one SiblingLeaseConflict; refresh + release work", async () => {
    // Seed the shared module the siblings both target.
    const modRes = await execute(registry, adapter, sysCtx, "modules.create", {
      slug: `${PFX}hero`,
      displayName: "Hero",
      html: "<p>v0</p>",
    });
    if (!modRes.ok) throw new Error(`seed module: ${JSON.stringify(modRes.error)}`);
    const moduleId = (modRes.value as { moduleId: string }).moduleId;

    // Parent orchestrator chat → its branch is the shared preview branch.
    const parent = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}parent`,
    });
    if (!parent.ok) throw new Error("seed parent chat");
    const parentBranch = (parent.value as { chatBranchId: string }).chatBranchId;
    const parentSessionId = (parent.value as { chatSessionId: string }).chatSessionId;

    // Two ephemeral "subagent" sessions — their ids are the lease holders.
    const s1 = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}sub1`,
    });
    const s2 = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}sub2`,
    });
    if (!s1.ok || !s2.ok) throw new Error("seed subagent sessions");
    const holder1 = (s1.value as { chatSessionId: string }).chatSessionId;
    const holder2 = (s2.value as { chatSessionId: string }).chatSessionId;

    const ctx1 = siblingCtx(parentBranch, holder1, "issue264-w1");
    const ctx2 = siblingCtx(parentBranch, holder2, "issue264-w2");

    // Concurrent writes to the SAME module on the SAME branch. The
    // FOR UPDATE lease race must resolve to exactly one winner.
    const [r1, r2] = await Promise.all([
      execute(registry, adapter, ctx1, "modules.update", { moduleId, html: "<p>from-s1</p>" }),
      execute(registry, adapter, ctx2, "modules.update", { moduleId, html: "<p>from-s2</p>" }),
    ]);

    const okCount = [r1, r2].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    const refused = [r1, r2].find((r) => !r.ok);
    if (!refused || refused.ok) throw new Error("expected exactly one refusal");
    expect((refused.error as { kind: string }).kind).toBe("SiblingLeaseConflict");

    const winnerHolder = r1.ok ? holder1 : holder2;
    const loserCtx = r1.ok ? ctx2 : ctx1;

    // Same-holder re-edit is a no-op refresh, never refused — the
    // parent-session / single-writer path stays unaffected.
    const winnerCtx = r1.ok ? ctx1 : ctx2;
    const refresh = await execute(registry, adapter, winnerCtx, "modules.update", {
      moduleId,
      html: "<p>from-winner-again</p>",
    });
    expect(refresh.ok).toBe(true);

    // The loser is still blocked while the winner holds the lease.
    const loserBlocked = await execute(registry, adapter, loserCtx, "modules.update", {
      moduleId,
      html: "<p>loser-retry</p>",
    });
    expect(loserBlocked.ok).toBe(false);
    if (loserBlocked.ok) return;
    expect((loserBlocked.error as { kind: string }).kind).toBe("SiblingLeaseConflict");

    // Winner's subagent finishes → its leases auto-release.
    const runRow = await execute(registry, adapter, sysCtx, "subagent_runs.create_pending", {
      parentChatSessionId: parentSessionId,
      parentMessageId: null,
      subagentChatSessionId: winnerHolder,
      batchId: null,
      role: "rebuild:hero",
      task: "rebuild the hero",
    });
    if (!runRow.ok) throw new Error(`create_pending: ${JSON.stringify(runRow.error)}`);
    const runId = (runRow.value as { id: string }).id;
    const finish = await execute(registry, adapter, sysCtx, "subagent_runs.finish", {
      id: runId,
      status: "completed",
      resultJson: { summary: "done" },
      costMicrocents: 0,
      durationMs: 1,
      errorMessage: null,
    });
    expect(finish.ok).toBe(true);

    // With the winner's lease released, the loser can now take the entity.
    const loserNow = await execute(registry, adapter, loserCtx, "modules.update", {
      moduleId,
      html: "<p>loser-finally</p>",
    });
    expect(loserNow.ok).toBe(true);
  });
});
