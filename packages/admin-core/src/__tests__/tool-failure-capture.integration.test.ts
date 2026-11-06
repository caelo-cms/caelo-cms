// SPDX-License-Identifier: MPL-2.0

/**
 * #1484 — the chat's automatic bug capture filed tool errors where Caelo
 * reacted correctly. Each case below is the real failure of an `[ai-detected]`
 * issue closed as correct behaviour, driven through the real tool and op, plus
 * a real crash that must still be filed:
 *   - #1403 `upsert_lists_many` refused an empty `href`: names its path, kept;
 *   - #1425 `read_content` on a module id not in this view: a refusal;
 *   - #1462 a Stage the build refused (no English content), through the real
 *     `stage_changes`, `deploy.trigger` and the generator's error event;
 *   - a handler that throws, and a build that crashes: defects.
 * The same refusal repeating in one chat is the one expected failure that
 * still reports, once and at low severity.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, defineOperation, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { z } from "zod";
import {
  captureToolFailure,
  classifyToolFailure,
  REPEATED_REFUSAL_REPORT_AT,
  shouldAutoCaptureToolFailure,
} from "../ai/chat-runner/tool-failure-capture.js";
import { makeOpTool } from "../ai/tools/_list-tool-kit.js";
import { ToolRegistry, type ToolResult } from "../ai/tools/dispatch.js";
import { stageChangesTool } from "../ai/tools/draft-tools.js";
import { upsertListsManyTool } from "../ai/tools/list-tools.js";
import { readContentTool } from "../ai/tools/read-content.js";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const OWNER_ID = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "t1484" };
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "t1484-ai",
  actorRoles: ["ai"],
};
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1484-seed",
};

/** The text of #1462, as the generator's content-variant gate words it. */
const NO_ENGLISH_CONTENT =
  'static-generator: 1 page placement(s) have no content to ship in their page\'s variant — page "news" (page:content:2): content-variant:international-site:there is no English (en) version of "Demo" (shared content) yet. Next step: translate_chrome({localeCode: "en"}) creates it.';

/** A generator that refuses or crashes, by env, the way cli.ts reports each. */
const STUB_GENERATOR = `
for await (const line of console) {
  JSON.parse(line);
  const refused = process.env.CAELO_TEST_STUB_GENERATOR === "refuse";
  console.log(JSON.stringify({
    kind: "error",
    message: refused ? ${JSON.stringify(NO_ENGLISH_CONTENT)} : "Cannot read properties of undefined (reading 'html')",
    ...(refused ? { refusal: true } : {}),
  }));
  process.exit(1);
}
`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let tools: ToolRegistry;
let testRoot: string;
let chatSessionId = "";
let chatBranchId = "";
const savedEnv: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(values)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
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

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function newChat(): Promise<string> {
  const v = await op<{ chatSessionId: string }>(OWNER, "chat.create_session", { title: "t1484" });
  return v.chatSessionId;
}

interface ReportRow {
  title: string;
  severity: string;
  what_happened: string;
  evidence: string | null;
}

function reportsOf(chat: string): Promise<ReportRow[]> {
  return withSql(
    (tx) =>
      tx`SELECT title, severity, what_happened, evidence FROM ai_bug_reports
         WHERE chat_session_id = ${chat}::uuid ORDER BY created_at` as Promise<ReportRow[]>,
  );
}

/** One failed call as dispatch finishes it: cached, then through the capture. */
async function finishCall(
  chat: string,
  toolName: string,
  result: ToolResult,
  cachedContent = result.content,
): Promise<void> {
  await op(OWNER, "chat.cache_tool_result", {
    chatSessionId: chat,
    toolCallId: crypto.randomUUID(),
    toolName,
    ok: result.ok,
    content: cachedContent,
  });
  await captureToolFailure({
    registry,
    adapter,
    reportCtx: AI,
    readCtx: OWNER,
    chatSessionId: chat,
    toolName,
    toolArguments: { id: "x" },
    result,
    reason: result.content,
  });
}

beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "caelo-t1484-"));
  const stub = join(testRoot, "stub-generator.ts");
  await writeFile(stub, STUB_GENERATOR);
  setEnv({
    CAELO_GENERATOR_CLI: stub,
    CAELO_PROVIDER: undefined,
    CAELO_STATIC_OUTPUT_ROOT: testRoot,
  });
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  registry.register(
    defineOperation({
      name: "t1484.crash",
      readScope: "request",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.object({}).strict(),
      output: z.object({}),
      handler: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'moduleId')");
      },
    }),
  );
  setDeployBridge({ registry, adapter });
  tools = new ToolRegistry();
  tools.register(upsertListsManyTool);
  tools.register(readContentTool);
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name)
             VALUES (${OWNER_ID}::uuid, 'human', 't1484 owner') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash)
             VALUES (${OWNER_ID}::uuid, ${`t1484-${OWNER_ID}@test.local`}, 'test-only')
             ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO user_roles (user_id, role_id)
             SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner' ON CONFLICT DO NOTHING`;
  });
  const chat = await op<{ chatSessionId: string; chatBranchId: string }>(
    OWNER,
    "chat.create_session",
    { title: "t1484 stage" },
  );
  chatSessionId = chat.chatSessionId;
  chatBranchId = chat.chatBranchId;
  await op(SYSTEM, "list_types.upsert_many", {
    listTypes: [
      {
        slug: "t1484-menu",
        name: "Menu",
        purpose: "test",
        role: "navigation",
        root: { allow: ["entry"] },
        nodes: {
          entry: { label: "Entry", fields: [{ name: "link", label: "Link", type: "link" }] },
        },
      },
    ],
  });
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await withSql(async (tx) => {
    await tx`DELETE FROM deploy_runs`;
  });
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("#1484 — refusals the AI is meant to act on are not filed", () => {
  it("#1403 upsert_lists_many refusing an empty href keeps its path and is not filed", async () => {
    const r = await tools.dispatch(
      "upsert_lists_many",
      {
        lists: [
          {
            slug: "t1484-main-menu",
            type: "t1484-menu",
            name: "Main",
            purpose: "test",
            items: [{ node: "entry", values: { link: { href: "" } } }],
          },
        ],
      },
      AI,
      { adapter, registry },
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("href is empty");
    expect(r.failureKind).toBe("HandlerError");
    expect(r.errors?.[0]?.path).toEqual(["lists", 0, "items", 0, "values", "link"]);
    expect(classifyToolFailure(r)).toBe("expected");
    expect(shouldAutoCaptureToolFailure("upsert_lists_many", r)).toBe(false);
  });

  it("#1425 read_content on a module id not in this view is a refusal", async () => {
    const missing = crypto.randomUUID();
    const get = await execute(registry, adapter, AI, "modules.get", { moduleId: missing });
    expect(get.ok ? undefined : (get.error as { refusal?: true }).refusal).toBe(true);

    const r = await tools.dispatch(
      "read_content",
      { entityKind: "module", entityId: missing },
      AI,
      { adapter, registry },
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("list_modules");
    expect(r.refusal).toBe(true);
    expect(shouldAutoCaptureToolFailure("read_content", r)).toBe(false);
  });

  it("#1462 a Stage the build refused keeps the refusal through stage_changes", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: "refuse" });
    const r = await stageChangesTool.handler(
      AI,
      { scope: "this_chat" },
      {
        registry,
        adapter,
        chatSessionId,
        chatBranchId,
        humanCtx: { ...OWNER, chatBranchId },
        operatorBrowserAttached: true,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("translate_chrome");
    expect(r.refusal).toBe(true);
    expect(shouldAutoCaptureToolFailure("stage_changes", r)).toBe(false);
  });
});

describe("#1484 — a real defect is still filed", () => {
  it("a handler that throws: internal, and filed with its input", async () => {
    const tool = makeOpTool({
      name: "t1484_crash",
      description: "t",
      opName: "t1484.crash",
      input: z.object({}).strict(),
      format: () => "",
    });
    const r = await tool.handler(AI, {}, { adapter, registry });
    expect(r.ok).toBe(false);
    expect(r.failureKind).toBe("internal");
    expect(classifyToolFailure(r)).toBe("defect");

    const chat = await newChat();
    await finishCall(chat, "t1484_crash", r);
    const rows = await reportsOf(chat);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Tool t1484_crash returned an error");
    expect(rows[0]?.severity).toBe("degraded");
    expect(rows[0]?.what_happened).toContain("Cannot read properties of undefined");
    expect(rows[0]?.evidence).toContain("Tool input (t1484_crash)");
  });

  it("a crashed build is not a refusal, whatever Stage it came through", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: "crash" });
    const r = await stageChangesTool.handler(
      AI,
      { scope: "this_chat" },
      {
        registry,
        adapter,
        chatSessionId,
        chatBranchId,
        humanCtx: { ...OWNER, chatBranchId },
        operatorBrowserAttached: true,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("Cannot read properties of undefined");
    expect(r.refusal).toBeUndefined();
    expect(shouldAutoCaptureToolFailure("stage_changes", r)).toBe(true);
  });

  it("a failure with no structure is a defect; `internal` beats every other marker", () => {
    // What dispatch makes of a thrown tool, and what a plugin tool returns.
    expect(classifyToolFailure({})).toBe("defect");
    expect(classifyToolFailure({ failureKind: "HandlerError" })).toBe("defect");
    expect(classifyToolFailure({ failureKind: "RLSDenied" })).toBe("defect");
    expect(classifyToolFailure({ failureKind: "ActorScopeRejected" })).toBe("defect");
    expect(classifyToolFailure({ failureKind: "UnknownTool" })).toBe("defect");
    // A schema refusal is only expected once it is kept for a patch: see
    // ToolResult.refusal for why a malformed call can be our defect.
    expect(classifyToolFailure({ failureKind: "InvalidArguments" })).toBe("defect");
    expect(classifyToolFailure({ failureKind: "internal", refusal: true })).toBe("defect");
    expect(
      classifyToolFailure({ failureKind: "internal", errors: [{ path: ["a"], message: "m" }] }),
    ).toBe("defect");
  });

  it("the structure that says expected, kind by kind", () => {
    for (const failureKind of ["ValidationFailed", "Conflict", "Locked"] as const) {
      expect(classifyToolFailure({ failureKind })).toBe("expected");
    }
    expect(classifyToolFailure({ failureKind: "SiblingLeaseConflict" })).toBe("expected");
    expect(classifyToolFailure({ retryable: true })).toBe("expected");
    expect(classifyToolFailure({ nextAction: { tool: "list_layouts", reason: "r" } })).toBe(
      "expected",
    );
  });
});

describe("#1484 — the same refusal over and over is still a signal", () => {
  const refused: ToolResult = {
    ok: false,
    content: "no module 1 in this view — list_modules shows the modules (ids).",
    failureKind: "HandlerError",
    refusal: true,
  };

  it("files nothing below the threshold, then one cosmetic report", async () => {
    const chat = await newChat();
    for (let i = 1; i < REPEATED_REFUSAL_REPORT_AT; i++)
      await finishCall(chat, "read_content", refused);
    expect(await reportsOf(chat)).toEqual([]);

    await finishCall(chat, "read_content", refused);
    await finishCall(chat, "read_content", refused);
    const rows = await reportsOf(chat);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe(
      `Tool read_content gave one chat the same refusal ${REPEATED_REFUSAL_REPORT_AT} times`,
    );
    expect(rows[0]?.severity).toBe("cosmetic");
    expect(rows[0]?.what_happened).toBe(refused.content);
  });

  it("counts a kept call although its cached text ends in its own call id", async () => {
    const chat = await newChat();
    for (let i = 0; i < REPEATED_REFUSAL_REPORT_AT; i++) {
      await finishCall(chat, "build_page", refused, `${refused.content}\nkept as call-${i}`);
    }
    expect(await reportsOf(chat)).toHaveLength(1);
  });

  it("different refusals, or the same one from another tool, do not add up", async () => {
    const chat = await newChat();
    for (let i = 0; i < REPEATED_REFUSAL_REPORT_AT; i++) {
      await finishCall(chat, "build_page", { ...refused, content: `refused ${i}` });
      await finishCall(chat, i % 2 === 0 ? "read_content" : "update_pages_many", refused);
    }
    expect(await reportsOf(chat)).toEqual([]);
  });

  it("bug_report is never captured, not even repeated", async () => {
    const chat = await newChat();
    expect(shouldAutoCaptureToolFailure("bug_report", { ok: false } as ToolResult)).toBe(false);
    for (let i = 0; i <= REPEATED_REFUSAL_REPORT_AT; i++) {
      await finishCall(chat, "bug_report", i % 2 === 0 ? refused : { ok: false, content: "boom" });
    }
    expect(await reportsOf(chat)).toEqual([]);
  });
});
