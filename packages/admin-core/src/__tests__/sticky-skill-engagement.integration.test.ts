// SPDX-License-Identifier: MPL-2.0

/**
 * Regression (2026-07-12): the skill auto-matcher scores ONLY the
 * current user message, so a mid-flow answer like "B — Light refresh"
 * carries no keywords and the skill that owned the flow silently
 * dropped out between turns — the site-migrate skill vanished for the
 * scope turn and the AI queued a full crawl without asking. 0125 adds
 * chat_sessions.auto_engaged_skills; buildSkillsContext re-engages
 * previously auto-engaged skills on later turns ("sticky"), still
 * subject to manual disengagement.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { buildSkillsContext } from "../ai/chat-runner/context/skills.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let chatSessionId: string;

const TITLE = "sticky-engagement-regression";
const ACTOR_EMAIL = "sticky-engagement-actor@example.com";

// chat_sessions rows carry FK-enforced actor references — the ctx
// actor must be a real users row (CI's fresh DB caught the fake uuid).
let ctx: ExecutionContext;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title = ${TITLE})`;
      await tx`DELETE FROM chat_sessions WHERE title = ${TITLE}`;
      await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ${ACTOR_EMAIL})`;
      await tx`DELETE FROM users WHERE email = ${ACTOR_EMAIL}`;
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
  // 0003 seeds the Caelo System actor — the only uuid guaranteed to
  // satisfy audit/actor FKs on a fresh DB.
  const bootstrapCtx: ExecutionContext = {
    actorId: "00000000-0000-0000-0000-00000000ffff",
    actorKind: "system",
    requestId: "sticky-bootstrap",
  };
  const user = await execute(registry, adapter, bootstrapCtx, "users.create", {
    email: ACTOR_EMAIL,
    password: "sticky-test-pass",
    displayName: "Sticky Test Actor",
    roleNames: [],
  });
  if (!user.ok) throw new Error(`users.create failed: ${user.error.kind}`);
  ctx = {
    actorId: (user.value as { userId: string }).userId,
    actorKind: "system",
    requestId: "sticky-test",
  };
  const created = await execute(registry, adapter, ctx, "chat.create_session", { title: TITLE });
  if (!created.ok) throw new Error(`chat.create_session failed: ${created.error.kind}`);
  chatSessionId = (created.value as { chatSessionId: string }).chatSessionId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("sticky skill engagement (0125)", () => {
  it("keyword turn engages site-migrate; keywordless follow-up keeps it via stickiness", async () => {
    // Turn 1: matches the seeded site-migrate keywords.
    const t1 = await buildSkillsContext(registry, adapter, ctx, {
      userMessage: "I want to migrate my existing website to Caelo",
      chipCount: 0,
      chatSessionId,
    });
    const migrate1 = t1.engagedSkills.find((e) => e.slug === "site-migrate");
    expect(migrate1).toBeDefined();
    expect(migrate1?.source).toBe("auto");

    // Turn 2: a mid-flow answer with zero keywords — pre-0125 this
    // dropped the skill; now it re-engages as sticky.
    const t2 = await buildSkillsContext(registry, adapter, ctx, {
      userMessage: "B — Light refresh",
      chipCount: 0,
      chatSessionId,
    });
    const migrate2 = t2.engagedSkills.find((e) => e.slug === "site-migrate");
    expect(migrate2).toBeDefined();
    expect(migrate2?.rationale).toBe("engaged earlier in this chat");
  });

  it("a fresh chat without prior engagement does NOT engage on a keywordless message", async () => {
    const created = await execute(registry, adapter, ctx, "chat.create_session", {
      title: TITLE,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const freshId = (created.value as { chatSessionId: string }).chatSessionId;
    const t = await buildSkillsContext(registry, adapter, ctx, {
      userMessage: "B — Light refresh",
      chipCount: 0,
      chatSessionId: freshId,
    });
    expect(t.engagedSkills.find((e) => e.slug === "site-migrate")).toBeUndefined();
  });
});
