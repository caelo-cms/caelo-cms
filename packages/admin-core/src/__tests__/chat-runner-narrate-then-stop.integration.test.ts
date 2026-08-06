// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 — narrate-then-stop recovery in the chat-runner loop.
 *
 * Step-13's browser walk caught the footer path failing because the model
 * narrated the action ("A site-wide footer belongs on the layout's footer
 * block ... adding it there now.") and then ended the turn with ZERO tool
 * calls (loopStop='end_turn'). The operator had to manually type "go ahead"
 * to get `add_module_to_layout` to fire. Per CLAUDE.md §4 that's a real
 * defect in our layer, not model nondeterminism.
 *
 * Note the shape: the model narrates on the FIRST call, having run no tools
 * at all. That is why the structural pre-filter must NOT require "this turn
 * used tools" — an earlier revision of the redesign did, and would have left
 * exactly the originally-reported failure unrecovered.
 *
 * Recovery re-runs the step with the SDK's `toolChoice: "required"` once,
 * gated on a completeness judge (turn-completeness-judge.ts). The judge is
 * stubbed here — these tests pin the LOOP's response to a verdict against a
 * real Postgres, not the judge's own accuracy:
 *  1. verdict "not finished" → one forced re-run → the tool fires.
 *  2. verdict "finished" (a clarifying question) → NO retry (the v0.5.9
 *     false-positive class must not come back).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { z } from "zod";
import type { JudgeTurnCompleteness } from "../ai/chat-runner/turn-completeness-judge.js";
import { runChatTurn } from "../ai/chat-runner.js";
import type { ProviderEvent } from "../ai/provider.js";
import { FixtureProvider } from "../ai/providers/anthropic.js";
import { ToolRegistry } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue106-passive",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue106-passive-ai",
};

/**
 * Loop 0: announce an action + end_turn with NO tool call (the passive
 * failure). Loop 1 (only reached if the runner re-prompts after the nudge):
 * emit the tool call. Loop 2: end. `calls` records how many times
 * generate() ran so the control test can assert "no retry".
 */
class AnnouncedThenToolProvider extends FixtureProvider {
  calls = 0;
  constructor() {
    super([], "claude-test-1");
  }
  protected override nextStepEvents(): readonly ProviderEvent[] {
    const loop = this.calls;
    this.calls += 1;
    if (loop === 0) {
      return [
        { kind: "text-delta", text: "Adding the footer to the layout now." },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "end_turn" },
      ];
    }
    if (loop === 1) {
      return [
        { kind: "tool-call", id: "tc-footer", name: "record_footer", arguments: {} },
        { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ];
    }
    return [
      { kind: "text-delta", text: "Footer added." },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ];
  }
}

/** Loop 0: a clarifying QUESTION + end_turn, no tool. Must NOT be retried. */
class ClarifyingQuestionProvider extends FixtureProvider {
  calls = 0;
  constructor() {
    super([], "claude-test-1");
  }
  protected override nextStepEvents(): readonly ProviderEvent[] {
    this.calls += 1;
    return [
      {
        kind: "text-delta",
        text: "Want me to add a footer with Home, About, and Contact links?",
      },
      { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      { kind: "done", stopReason: "end_turn" },
    ];
  }
}

/**
 * A judge with a fixed verdict. The real one asks a small model; these tests
 * pin what the LOOP does once a verdict exists, so the model is out of scope.
 */
function fixedJudge(finished: boolean): { fn: JudgeTurnCompleteness; calls: number } {
  const state = {
    calls: 0,
    fn: (async () => {
      state.calls += 1;
      return {
        finished,
        reason: "fixture",
        providerName: "anthropic",
        model: "stub-judge",
        inputTokens: 1,
        outputTokens: 1,
      };
    }) as JudgeTurnCompleteness,
  };
  return state;
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'issue106-passive-%')`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'issue106-passive-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'issue106-passive-%'`;
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

describe("chat-runner narrate-then-stop recovery (issue #106)", () => {
  it("forces one re-run and the announced tool call fires on it", async () => {
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "issue106-passive-announced",
    });
    if (!session.ok) throw new Error("session create failed");
    const { chatSessionId } = session.value as { chatSessionId: string };

    let toolRan = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "record_footer",
      description: "records that the footer add fired",
      schema: z.object({}),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => {
        toolRan += 1;
        return { ok: true, content: "footer recorded" };
      },
    });

    // Neutral user content — keyword-matching skills can engage an
    // allowlist that filters out this test's synthetic tool, which would
    // make filteredTools empty and mask the behaviour under test. The
    // detector keys on the ASSISTANT text (from the provider), not this.
    const provider = new AnnouncedThenToolProvider();
    // The announced work never happened → the judge reports "not finished".
    const judge = fixedJudge(false);
    const events: { kind: string; ok?: boolean }[] = [];
    for await (const ev of runChatTurn(
      {
        adapter,
        registry,
        provider,
        tools,
        aiCtx: AI,
        humanCtx: HUMAN,
        judgeTurnCompleteness: judge.fn,
      },
      { chatSessionId, content: "Please proceed.", chips: [] },
    )) {
      events.push({ kind: ev.kind, ok: (ev as { ok?: boolean }).ok });
    }

    // The forced re-run happened: generate ran 3× (narration → forced retry
    // that emits the tool → post-tool summary).
    expect(provider.calls).toBe(3);
    // The announced tool actually fired.
    expect(toolRan).toBe(1);
    const toolResult = events.find((e) => e.kind === "tool-result");
    expect(toolResult).toBeDefined();
    expect(toolResult?.ok).toBe(true);

    // Recovery must leave NO synthetic operator turn behind. The old nudge
    // injected a `role:"user"` message (in-memory only, but one bad persist
    // away from corrupting history); `toolChoice` adds nothing to history at
    // all. This assertion is what keeps that property honest. Scope to OPERATOR turns: the runner
    // also injects a cold-start "[Site status …]" note on a session's first
    // turn as a role='user', origin='system' row (deliberate — see index.ts
    // injectNote), which is not an operator message and must not count here.
    const sql = new SQL(ADMIN_URL!);
    let userMsgs: string[] = [];
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT content FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}::uuid
            AND role = 'user'
            AND origin IS DISTINCT FROM 'system'
          ORDER BY created_at ASC
        `) as unknown as { content: string }[];
        userMsgs = rows.map((r) => r.content);
      });
    } finally {
      await sql.end();
    }
    expect(userMsgs).toEqual(["Please proceed."]);
  });

  it("does NOT retry a clarifying question (no v0.5.9 false-positive)", async () => {
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: "issue106-passive-question",
    });
    if (!session.ok) throw new Error("session create failed");
    const { chatSessionId } = session.value as { chatSessionId: string };

    let toolRan = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "record_footer",
      description: "records that the footer add fired",
      schema: z.object({}),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => {
        toolRan += 1;
        return { ok: true, content: "footer recorded" };
      },
    });

    const provider = new ClarifyingQuestionProvider();
    // Asking the operator a real question IS a finished turn.
    const judge = fixedJudge(true);
    for await (const _ev of runChatTurn(
      {
        adapter,
        registry,
        provider,
        tools,
        aiCtx: AI,
        humanCtx: HUMAN,
        judgeTurnCompleteness: judge.fn,
      },
      { chatSessionId, content: "Please proceed.", chips: [] },
    )) {
      // drain
    }

    // No nudge: a clarifying question is a legitimate text-only turn.
    expect(provider.calls).toBe(1);
    expect(toolRan).toBe(0);
  });
});
