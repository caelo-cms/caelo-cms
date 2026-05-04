// SPDX-License-Identifier: MPL-2.0

/**
 * Site AI memory round-trip:
 *   - Owner sets brand-voice
 *   - System prompt composer pulls it via ai_memory.list and produces
 *     the expected text in the prompt
 *   - AI proposes an addition via ai_memory.propose (queued; memory
 *     unchanged)
 *   - Owner reviews the proposal: accept atomically updates site_ai_memory
 *     and stamps the proposal as accepted
 *   - The list now reflects the accepted body
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { composeSystemPrompt } from "../ai/system-prompt.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "p5-mem",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "p5-mem-ai",
};

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM site_memory_proposals WHERE rationale = 'p5-mem-test'`;
      await tx`DELETE FROM site_ai_memory WHERE slot = 'brand-voice'`;
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

describe("site_ai_memory round-trip", () => {
  it("Owner set → system-prompt composer renders the body", async () => {
    const r = await execute(registry, adapter, HUMAN, "ai_memory.set", {
      slot: "brand-voice",
      body: "be terse",
    });
    expect(r.ok).toBe(true);

    const list = await execute(registry, adapter, HUMAN, "ai_memory.list", {});
    if (!list.ok) return;
    const memory = (list.value as { memory: { slot: string; body: string }[] }).memory;
    const prompt = composeSystemPrompt(memory, []);
    expect(prompt).toContain("be terse");
  });

  it("AI proposes → queue length 1; memory unchanged", async () => {
    const before = await execute(registry, adapter, HUMAN, "ai_memory.list", {});
    const beforeBody = before.ok
      ? (before.value as { memory: { slot: string; body: string }[] }).memory.find(
          (m) => m.slot === "brand-voice",
        )?.body
      : undefined;

    const propose = await execute(registry, adapter, AI, "ai_memory.propose", {
      slot: "brand-voice",
      body: "be terse and warm",
      rationale: "p5-mem-test",
      chatSessionId: null,
    });
    expect(propose.ok).toBe(true);

    const queue = await execute(registry, adapter, HUMAN, "ai_memory.list_proposals", {
      status: "pending",
    });
    if (!queue.ok) return;
    const proposals = (
      queue.value as { proposals: { id: string; rationale: string; body: string }[] }
    ).proposals.filter((p) => p.rationale === "p5-mem-test");
    expect(proposals.length).toBe(1);

    // Memory body still the previous value.
    const after = await execute(registry, adapter, HUMAN, "ai_memory.list", {});
    if (!after.ok) return;
    const afterBody = (after.value as { memory: { slot: string; body: string }[] }).memory.find(
      (m) => m.slot === "brand-voice",
    )?.body;
    expect(afterBody).toBe(beforeBody ?? "");
  });

  it("Owner accepts proposal → memory updates, status=accepted, atomic", async () => {
    const queue = await execute(registry, adapter, HUMAN, "ai_memory.list_proposals", {
      status: "pending",
    });
    if (!queue.ok) return;
    const proposal = (
      queue.value as { proposals: { id: string; body: string; rationale: string }[] }
    ).proposals.find((p) => p.rationale === "p5-mem-test");
    expect(proposal).toBeTruthy();
    if (!proposal) return;

    const review = await execute(registry, adapter, HUMAN, "ai_memory.review", {
      proposalId: proposal.id,
      decision: "accept",
    });
    expect(review.ok).toBe(true);

    const after = await execute(registry, adapter, HUMAN, "ai_memory.list", {});
    if (!after.ok) return;
    const body = (after.value as { memory: { slot: string; body: string }[] }).memory.find(
      (m) => m.slot === "brand-voice",
    )?.body;
    expect(body).toBe(proposal.body);

    // Re-reviewing the same proposal fails — it's already accepted.
    const again = await execute(registry, adapter, HUMAN, "ai_memory.review", {
      proposalId: proposal.id,
      decision: "reject",
    });
    expect(again.ok).toBe(false);
  });

  it("ai_memory.set with empty body clears the slot", async () => {
    const clear = await execute(registry, adapter, HUMAN, "ai_memory.set", {
      slot: "brand-voice",
      body: "",
    });
    expect(clear.ok).toBe(true);
    const after = await execute(registry, adapter, HUMAN, "ai_memory.list", {});
    if (!after.ok) return;
    const present = (after.value as { memory: { slot: string }[] }).memory.some(
      (m) => m.slot === "brand-voice",
    );
    expect(present).toBe(false);
  });
});
