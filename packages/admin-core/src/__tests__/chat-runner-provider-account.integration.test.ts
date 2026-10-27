// SPDX-License-Identifier: MPL-2.0

/**
 * A provider ACCOUNT refusal (usage limit, credit, key) is not a Caelo bug.
 *
 * Before: the Anthropic answer "You have reached your specified API usage
 * limits…" failed the turn generically and filed a `blocking`
 * `ai_bug_reports` row ("AI turn failed: provider error"), which the bug
 * intake forwarded as a GitHub issue. Now the chat-runner tells the operator
 * in brand-free words what to do and files nothing — while a provider error
 * that IS our defect (a malformed request) still files its report.
 *
 * Real Postgres (CLAUDE.md §6). The provider refusal is scripted at the
 * model level (`doStream` throws the SDK's APICallError), so the real SDK →
 * `_sdk-shared` classification → chat-runner path runs.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { APICallError } from "ai";
import { SQL } from "bun";
import { runChatTurn } from "../ai/chat-runner.js";
import { PROVIDER_ACCOUNT_NOTICE_PREFIX } from "../ai/provider-account-error.js";
import { FixtureProvider } from "../ai/providers/anthropic.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "provider-account",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "provider-account-ai",
};

const USAGE_LIMIT =
  "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.";

/** Every model call is refused with `error` — the HTTP answer the SDK saw. */
class RefusingProvider extends FixtureProvider {
  calls = 0;
  constructor(private readonly error: APICallError) {
    super([], "claude-test-1");
  }
  protected override nextStepStream(): ReadableStream<unknown> | null {
    this.calls += 1;
    throw this.error;
  }
}

function anthropicError(statusCode: number, type: string, message: string): APICallError {
  const body = { type: "error", error: { type, message } };
  return new APICallError({
    message,
    url: "https://api.anthropic.com/v1/messages",
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify(body),
    data: body,
    isRetryable: false,
  });
}

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    let out: T | undefined;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      out = await fn(tx as unknown as SQL);
    });
    return out as T;
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    const ids = tx`SELECT id FROM chat_sessions WHERE title LIKE 'provider-account-%'`;
    await tx`DELETE FROM ai_bug_reports WHERE chat_session_id IN (${ids})`;
    await tx`DELETE FROM chat_messages WHERE chat_session_id IN (${ids})`;
    await tx`DELETE FROM ai_calls WHERE chat_session_id IN (${ids})`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE 'provider-account-%'`;
  });
}

async function runTurn(
  title: string,
  provider: FixtureProvider,
): Promise<{ chatSessionId: string; events: { kind: string; message?: string; text?: string }[] }> {
  const session = await execute(registry, adapter, HUMAN, "chat.create_session", { title });
  if (!session.ok) throw new Error("session");
  const { chatSessionId } = session.value as { chatSessionId: string };
  const events: { kind: string; message?: string; text?: string }[] = [];
  for await (const ev of runChatTurn(
    { adapter, registry, provider, tools: createDefaultToolRegistry(), aiCtx: AI, humanCtx: HUMAN },
    { chatSessionId, content: "build me a homepage", chips: [] },
  )) {
    events.push(ev as { kind: string; message?: string; text?: string });
  }
  return { chatSessionId, events };
}

async function bugReports(chatSessionId: string): Promise<{ title: string; severity: string }[]> {
  return withSql(
    async (tx) =>
      (await tx`
        SELECT title, severity FROM ai_bug_reports WHERE chat_session_id = ${chatSessionId}::uuid
      `) as unknown as { title: string; severity: string }[],
  );
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("chat-runner: provider account refusals", () => {
  it("a used-up usage limit files NO bug report and leaves a brand-free notice in the chat", async () => {
    const provider = new RefusingProvider(
      anthropicError(400, "invalid_request_error", USAGE_LIMIT),
    );
    const { chatSessionId, events } = await runTurn("provider-account-quota", provider);

    // One call, no retry: the answer would not change.
    expect(provider.calls).toBe(1);
    expect(await bugReports(chatSessionId)).toEqual([]);

    const errors = events.filter((e) => e.kind === "error").map((e) => e.message ?? "");
    expect(errors.length).toBe(1);
    expect(errors[0]?.startsWith(PROVIDER_ACCOUNT_NOTICE_PREFIX)).toBe(true);
    expect(errors[0]).toContain("Settings → AI");
    // The raw provider text never reaches the editor chat.
    expect(events.some((e) => (e.message ?? e.text ?? "").includes(USAGE_LIMIT))).toBe(false);

    const persisted = await withSql(
      async (tx) =>
        (await tx`
          SELECT content FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}::uuid AND role = 'assistant'
        `) as unknown as { content: string }[],
    );
    expect(persisted.length).toBe(1);
    expect(persisted[0]?.content.startsWith(PROVIDER_ACCOUNT_NOTICE_PREFIX)).toBe(true);
    expect(persisted[0]?.content.toLowerCase()).not.toMatch(/anthropic|claude/);
  });

  it("a refused key files NO bug report either", async () => {
    const provider = new RefusingProvider(
      anthropicError(401, "authentication_error", "invalid x-api-key"),
    );
    const { chatSessionId, events } = await runTurn("provider-account-key", provider);
    expect(await bugReports(chatSessionId)).toEqual([]);
    const error = events.find((e) => e.kind === "error")?.message ?? "";
    expect(error).toContain("API key");
  });

  it("a provider error that is OUR defect still files its blocking report", async () => {
    // Contrast case — proves the test above is not vacuous: a request Caelo
    // built wrong is a bug and must keep reaching the bug intake.
    const provider = new RefusingProvider(
      anthropicError(
        400,
        "invalid_request_error",
        "messages.4: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_1",
      ),
    );
    const { chatSessionId } = await runTurn("provider-account-defect", provider);
    expect(await bugReports(chatSessionId)).toEqual([
      { title: "AI turn failed: provider error", severity: "blocking" },
    ]);
  });
});
