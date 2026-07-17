// SPDX-License-Identifier: MPL-2.0

/**
 * 2026-07 — e2e-only proposal auto-approve (`autoApproveChatProposals`).
 *
 * Autonomous live-edit runs have no human to click Approve, so any
 * propose_* the AI fires stalls forever (run-B5: the AI's correct
 * layout-CSS fix for the white band sat unapproved → the defect
 * persisted). The e2e hook executes each of THIS chat's pending
 * proposals as the Owner would, so the full propose→execute path runs.
 *
 * This test drives the helper directly against real Postgres (§6): a
 * chat session + a real layouts.propose_update, then auto-approve, then
 * assert the layout CSS actually changed and no pending rows remain.
 * The GATE is untouched — without the helper the proposal stays pending
 * (asserted first).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { autoApproveChatProposals } from "../ai/chat-runner/tool-dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const TAG = "e2eaa";
const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: TAG,
};
const AI_BASE: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: `${TAG}-ai`,
};

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM layout_pending_actions WHERE proposed_by = ${AI_BASE.actorId}::uuid`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${TAG}%`}`;
      await tx`DELETE FROM layout_blocks WHERE layout_id IN (SELECT id FROM layouts WHERE slug LIKE ${`${TAG}-%`})`;
      await tx`DELETE FROM layouts WHERE slug LIKE ${`${TAG}-%`}`;
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

async function layoutCss(layoutId: string): Promise<string> {
  const sql = new SQL(ADMIN_URL!);
  try {
    let css = "";
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`SELECT css FROM layouts WHERE id = ${layoutId}::uuid`) as unknown as {
        css: string;
      }[];
      css = rows[0]?.css ?? "";
    });
    return css;
  } finally {
    await sql.end();
  }
}

describe("e2e auto-approve — full propose→execute without a human", () => {
  it("executes this chat's pending layout proposal and applies the CSS", async () => {
    const layout = await execute(registry, adapter, HUMAN, "layouts.create", {
      slug: `${TAG}-layout`,
      displayName: "e2eaa L",
      html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
      css: ".caelo-layout-main{padding:2rem 0}",
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    if (!layout.ok) throw new Error(`layout: ${JSON.stringify(layout.error)}`);
    const layoutId = (layout.value as { layoutId: string }).layoutId;

    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: `${TAG}-session`,
    });
    if (!session.ok) throw new Error("session");
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };
    const aiCtx: ExecutionContext = { ...AI_BASE, chatBranchId };

    // The AI proposes the fix — as in the real run, it lands PENDING.
    const proposed = await execute(registry, adapter, aiCtx, "layouts.propose_update", {
      layoutId,
      css: ".caelo-layout-main{padding:0;background:var(--color-background)}",
    });
    expect(proposed.ok).toBe(true);

    // Gate intact: before approval, the CSS is unchanged.
    expect(await layoutCss(layoutId)).toContain("padding:2rem 0");

    // Simulate the Owner click for this chat.
    const summary = await autoApproveChatProposals(registry, adapter, HUMAN, chatSessionId);
    expect(summary).toContain("auto-approved");
    expect(summary).toContain("layouts");

    // Now the fix is live and no pending rows remain for this chat.
    expect(await layoutCss(layoutId)).toContain("background:var(--color-background)");
    const pending = await execute(registry, adapter, HUMAN, "pending_proposals.list", {});
    if (!pending.ok) throw new Error("pending list");
    const mine = (pending.value as { items: { chatSessionId: string | null }[] }).items.filter(
      (p) => p.chatSessionId === chatSessionId,
    );
    expect(mine.length).toBe(0);
  });

  it("does nothing for a chat with no pending proposals (returns null)", async () => {
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: `${TAG}-empty`,
    });
    if (!session.ok) throw new Error("session");
    const { chatSessionId } = session.value as { chatSessionId: string };
    const summary = await autoApproveChatProposals(registry, adapter, HUMAN, chatSessionId);
    expect(summary).toBeNull();
  });
});
