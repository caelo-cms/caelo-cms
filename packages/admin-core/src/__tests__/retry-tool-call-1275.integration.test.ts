// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1275 — a failed write call is kept and fixed with a patch
 * (`retry_tool_call`) instead of a resend.
 *
 *   - chat path (runChatTurn): a build_page with ~10 KB of HTML and a wrong
 *     page type is kept; one `set` builds the page, with the same page,
 *     snapshots and audit as a direct valid call;
 *   - a second failure keeps the id retryable with the new errors; success
 *     clears the kept arguments; `replace` fixes text inside one string;
 *   - two parallel retries of one id: exactly one dispatches;
 *   - another actor (RLS) or another session (a subagent's) cannot retry;
 *   - Power-MCP: a kept call is fixed the same way, and a patch that crosses
 *     delete_pages_many's approval threshold queues the approval.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { runChatTurn } from "../ai/chat-runner.js";
import type { ProviderEvent } from "../ai/provider.js";
import { FixtureProvider } from "../ai/providers/anthropic.js";
import { keptCallArgs, withKeptCallNotice } from "../ai/tools/_retry-keep.js";
import type { ToolContext, ToolResult } from "../ai/tools/dispatch.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const TYPE = `t1275-article-${TS}`;
const OWNER: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000001275",
  actorKind: "human",
  requestId: "t1275-owner",
};
const OTHER: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000012750",
  actorKind: "human",
  requestId: "t1275-other",
};
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1275-system",
};
const AI_ACTOR_ID = "00000000-0000-0000-0000-000000000a1a";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
/** The brand state the cold-start gate reads (preserved seed tables): restored after. */
let savedBrand: {
  activeThemeId: string | null;
  siteName: string | null;
  sitePurpose: string | null;
};

async function admin<T>(run: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return run(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

class ScriptProvider extends FixtureProvider {
  readonly #steps: ProviderEvent[][];
  #i = 0;
  constructor(steps: ProviderEvent[][]) {
    super([], "claude-test-1");
    this.#steps = steps;
  }
  protected override nextStepEvents(): readonly ProviderEvent[] {
    const events = this.#steps[this.#i] ?? [
      { kind: "done" as const, stopReason: "end_turn" as const },
    ];
    this.#i += 1;
    return events;
  }
}

function toolStep(id: string, name: string, args: unknown): ProviderEvent[] {
  return [
    { kind: "tool-call", id, name, arguments: args },
    { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    { kind: "done", stopReason: "tool_use" },
  ];
}

const END: ProviderEvent[] = [
  { kind: "text-delta", text: "done" },
  { kind: "usage", inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
  { kind: "done", stopReason: "end_turn" },
];

/** A ~10 KB section — the resend #1275 saves. */
const BIG_HTML = `<section class="t1275"><h2>{{heading}}</h2><p>${"Plain prose that a resend would emit again. ".repeat(230)}</p></section>`;

function buildPageArgs(slug: string, pageType: string) {
  return {
    page: { slug, title: `T1275 ${slug}`, pageType, metaDescription: "A test page for #1275." },
    modules: [
      {
        blockName: "content",
        displayName: `T1275 Big ${slug}`,
        description: "A long prose section for the retry test.",
        kind: "content",
        html: BIG_HTML,
        fields: [{ name: "heading", kind: "text", label: "Heading" }],
        content: { source: "inline", values: { heading: "Hello" } },
      },
    ],
  };
}

async function newSession(owner: ExecutionContext, title: string) {
  const s = await execute(registry, adapter, owner, "chat.create_session", { title });
  if (!s.ok) throw new Error(`session: ${JSON.stringify(s.error)}`);
  return s.value as { chatSessionId: string; chatBranchId: string };
}

function aiCtxFor(session: { chatSessionId: string; chatBranchId: string }): ExecutionContext {
  return {
    actorId: AI_ACTOR_ID,
    actorKind: "ai",
    requestId: `t1275-ai-${session.chatSessionId.slice(0, 8)}`,
    chatBranchId: session.chatBranchId,
    chatTaskId: session.chatSessionId,
  };
}

/** Dispatch like the chat-runner does: run, keep a fixable failure, cache. */
async function dispatchAndKeep(
  session: { chatSessionId: string; chatBranchId: string },
  owner: ExecutionContext,
  toolCallId: string,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const tools = createDefaultToolRegistry();
  const toolCtx: ToolContext = {
    adapter,
    registry,
    chatSessionId: session.chatSessionId,
    chatBranchId: session.chatBranchId,
    tools,
    humanCtx: owner,
    toolCallId,
  };
  let result = await tools.dispatch(name, args, aiCtxFor(session), toolCtx);
  const kept = keptCallArgs(result, tools);
  if (kept) result = withKeptCallNotice(toolCallId, result);
  await execute(registry, adapter, owner, "chat.cache_tool_result", {
    chatSessionId: session.chatSessionId,
    toolCallId,
    toolName: name,
    ok: result.ok,
    content: result.content,
    ...(kept ? { args: kept } : {}),
  });
  return result;
}

async function keptRow(chatSessionId: string, toolCallId: string) {
  const rows = await admin(
    (sql) =>
      sql`
      SELECT tool_name, result_ok, result_content, args, args_actor_id::text AS args_actor_id,
             retry_claimed_at
      FROM chat_tool_results WHERE chat_session_id = ${chatSessionId}::uuid AND tool_call_id = ${toolCallId}
    ` as Promise<
        {
          tool_name: string;
          result_ok: boolean;
          result_content: string;
          args: Record<string, unknown> | null;
          args_actor_id: string | null;
          retry_claimed_at: Date | null;
        }[]
      >,
  );
  return rows[0];
}

async function pageOf(slug: string) {
  const rows = await admin(
    (sql) =>
      sql`
      SELECT p.id::text AS id, pt.slug AS page_type
      FROM pages p JOIN page_types pt ON pt.id = p.page_type_id
      WHERE p.slug = ${slug} AND p.deleted_at IS NULL
    ` as Promise<{ id: string; page_type: string }[]>,
  );
  return rows[0];
}

/** Snapshot rows + successful build audits a page build left behind. */
async function footprint(pageId: string) {
  const [counts] = await admin(
    (sql) =>
      sql`
      SELECT
        (SELECT count(*)::int FROM page_snapshots WHERE page_id = ${pageId}::uuid) AS page_snaps,
        (SELECT count(*)::int FROM page_modules WHERE page_id = ${pageId}::uuid) AS placements,
        (SELECT count(*)::int FROM audit_events
           WHERE operation = 'pages.build_page' AND succeeded AND entity_id = ${pageId}::uuid) AS builds
    ` as Promise<{ page_snaps: number; placements: number; builds: number }[]>,
  );
  return counts;
}

async function retry(
  session: { chatSessionId: string; chatBranchId: string },
  owner: ExecutionContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tools = createDefaultToolRegistry();
  return tools.dispatch("retry_tool_call", args, aiCtxFor(session), {
    adapter,
    registry,
    chatSessionId: session.chatSessionId,
    chatBranchId: session.chatBranchId,
    tools,
    humanCtx: owner,
    toolCallId: `retry-${crypto.randomUUID()}`,
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  configureMcpBridge({ adapter, registry, resolveProvider: async () => null });
  await admin(async (sql) => {
    for (const [id, name] of [
      [OWNER.actorId, "t1275 owner"],
      [OTHER.actorId, "t1275 other"],
    ] as const) {
      await sql`INSERT INTO actors (id, kind, display_name) VALUES (${id}::uuid, 'human', ${name})
                ON CONFLICT (id) DO NOTHING`;
      await sql`INSERT INTO users (id, email, password_hash)
                VALUES (${id}::uuid, ${`${id}@t1275.test`}, 'test-only') ON CONFLICT DO NOTHING`;
      await sql`INSERT INTO user_roles (user_id, role_id)
                SELECT ${id}::uuid, id FROM roles WHERE name = 'owner' ON CONFLICT DO NOTHING`;
    }
  });
  // build_page's cold-start gate wants a site identity and a described,
  // non-seed theme before an AI builds; the state is restored in afterAll.
  savedBrand = await admin(async (sql) => {
    const active = (await sql`SELECT id::text AS id FROM themes WHERE is_active`) as {
      id: string;
    }[];
    const ids = (await sql`SELECT site_name, site_purpose FROM site_defaults WHERE id = 1`) as {
      site_name: string | null;
      site_purpose: string | null;
    }[];
    await sql`UPDATE site_defaults SET site_name = 'T1275', site_purpose = 'Retry test site.' WHERE id = 1`;
    await sql`UPDATE themes SET is_active = false WHERE is_active`;
    await sql`INSERT INTO themes (slug, display_name, origin, is_active, description, tokens)
              VALUES (${`t1275-theme-${TS}`}, 'T1275', 'ai', true, 'Test brand.', '{}'::jsonb)`;
    return {
      activeThemeId: active[0]?.id ?? null,
      siteName: ids[0]?.site_name ?? null,
      sitePurpose: ids[0]?.site_purpose ?? null,
    };
  });
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: `t1275-tpl-${TS}`,
    displayName: "T1275 TPL",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
    newPageType: { slug: TYPE, name: "T1275 Article", purpose: "Articles of the #1275 test." },
  });
  if (!tpl.ok) throw new Error(`template: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await admin(async (sql) => {
    await sql`UPDATE site_defaults SET site_name = ${savedBrand.siteName},
                site_purpose = ${savedBrand.sitePurpose} WHERE id = 1`;
    await sql`UPDATE themes SET is_active = false WHERE is_active`;
    await sql`DELETE FROM themes WHERE slug = ${`t1275-theme-${TS}`}`;
    if (savedBrand.activeThemeId) {
      await sql`UPDATE themes SET is_active = true WHERE id = ${savedBrand.activeThemeId}::uuid`;
    }
  });
  await adapter.close();
});

describe("retry_tool_call — chat path", () => {
  it("keeps a build_page with a wrong page type; one set builds it like a direct valid call", async () => {
    const session = await newSession(OWNER, `t1275-chat-${TS}`);
    const slug = `t1275-chat-${TS}`;
    const provider = new ScriptProvider([
      toolStep("tc-1275-build", "build_page", buildPageArgs(slug, "t1275-nope")),
      toolStep("tc-1275-retry", "retry_tool_call", {
        toolCallId: "tc-1275-build",
        set: [{ path: ["page", "pageType"], value: TYPE }],
      }),
      END,
    ]);
    const tools = createDefaultToolRegistry();
    const results: { id: string; ok: boolean; content: string }[] = [];
    for await (const ev of runChatTurn(
      {
        adapter,
        registry,
        provider,
        tools,
        aiCtx: { actorId: AI_ACTOR_ID, actorKind: "ai", requestId: "t1275-chat" },
        humanCtx: OWNER,
      },
      { chatSessionId: session.chatSessionId, content: "build it", chips: [] },
    )) {
      const e = ev as { kind: string; toolCallId?: string; ok?: boolean; content?: string };
      if (e.kind === "tool-result") {
        results.push({ id: e.toolCallId ?? "", ok: e.ok ?? false, content: e.content ?? "" });
      }
    }
    const failed = results.find((r) => r.id === "tc-1275-build");
    expect(failed?.ok).toBe(false);
    expect(failed?.content).toContain("`page.pageType`");
    expect(failed?.content).toContain('retry_tool_call({toolCallId:"tc-1275-build"');
    const retried = results.find((r) => r.id === "tc-1275-retry");
    expect(retried?.ok).toBe(true);

    const row = await keptRow(session.chatSessionId, "tc-1275-build");
    expect(row?.args).toBeNull();
    expect(row?.result_ok).toBe(true);
    expect(row?.args_actor_id).toBe(OWNER.actorId);

    const built = await pageOf(slug);
    expect(built?.page_type).toBe(TYPE);

    // The same build, made directly with valid arguments.
    const direct = await newSession(OWNER, `t1275-direct-${TS}`);
    const directSlug = `t1275-direct-${TS}`;
    const ok = await dispatchAndKeep(
      direct,
      OWNER,
      "tc-1275-direct",
      "build_page",
      buildPageArgs(directSlug, TYPE),
    );
    expect(ok.ok).toBe(true);
    const directPage = await pageOf(directSlug);
    expect(directPage?.page_type).toBe(TYPE);
    expect(await footprint(built?.id ?? "")).toEqual(await footprint(directPage?.id ?? ""));
  });
});

describe("retry_tool_call — kept-call lifecycle", () => {
  it("a second failure keeps the id retryable with the new errors; replace fixes inside a string", async () => {
    const session = await newSession(OWNER, `t1275-life-${TS}`);
    const slug = `t1275-life-${TS}`;
    const first = await dispatchAndKeep(
      session,
      OWNER,
      "tc-life",
      "build_page",
      buildPageArgs(slug, "t1275-nope"),
    );
    expect(first.ok).toBe(false);
    expect((await keptRow(session.chatSessionId, "tc-life"))?.args).not.toBeNull();

    // Still wrong: fails again, the PATCHED call stays kept.
    const second = await retry(session, OWNER, {
      toolCallId: "tc-life",
      set: [{ path: ["page", "pageType"], value: "t1275-still-nope" }],
    });
    expect(second.ok).toBe(false);
    expect(second.errors?.map((e) => JSON.stringify(e.path))).toContain(
      JSON.stringify(["page", "pageType"]),
    );
    expect(second.content).toContain('retry_tool_call({toolCallId:"tc-life"');
    const after2 = await keptRow(session.chatSessionId, "tc-life");
    expect((after2?.args?.page as { pageType?: string } | undefined)?.pageType).toBe(
      "t1275-still-nope",
    );
    expect(after2?.retry_claimed_at).toBeNull();

    // `replace` zero / several matches: actionable, nothing changes.
    const zero = await retry(session, OWNER, {
      toolCallId: "tc-life",
      replace: [{ path: ["modules", 0, "html"], old: "<blink>", new: "<b>" }],
    });
    expect(zero.ok).toBe(false);
    expect(zero.content).toContain("does not occur");
    const many = await retry(session, OWNER, {
      toolCallId: "tc-life",
      replace: [{ path: ["modules", 0, "html"], old: "prose", new: "text" }],
    });
    expect(many.ok).toBe(false);
    expect(many.content).toContain("more than once");
    expect((await keptRow(session.chatSessionId, "tc-life"))?.retry_claimed_at).toBeNull();

    // One fragment of the big html + the page type, in one retry.
    const fixed = await retry(session, OWNER, {
      toolCallId: "tc-life",
      set: [{ path: ["page", "pageType"], value: TYPE }],
      replace: [
        { path: ["modules", 0, "html"], old: "<h2>{{heading}}</h2>", new: "<h3>{{heading}}</h3>" },
      ],
    });
    expect(fixed.ok).toBe(true);
    expect((await keptRow(session.chatSessionId, "tc-life"))?.args).toBeNull();
    const page = await pageOf(slug);
    expect(page?.page_type).toBe(TYPE);
    const html = await admin(
      (sql) =>
        sql`
        SELECT html FROM modules WHERE display_name = ${`T1275 Big ${slug}`} AND deleted_at IS NULL
      ` as Promise<{ html: string }[]>,
    );
    expect(html[0]?.html).toContain("<h3>{{heading}}</h3>");

    // A fixed call cannot be retried again.
    const again = await retry(session, OWNER, { toolCallId: "tc-life" });
    expect(again.ok).toBe(false);
    expect(again.content).toContain("already succeeded");
  });

  it("two parallel retries of one id: exactly one dispatches", async () => {
    const session = await newSession(OWNER, `t1275-race-${TS}`);
    const slug = `t1275-race-${TS}`;
    await dispatchAndKeep(
      session,
      OWNER,
      "tc-race",
      "build_page",
      buildPageArgs(slug, "t1275-nope"),
    );
    const patch = { toolCallId: "tc-race", set: [{ path: ["page", "pageType"], value: TYPE }] };
    const [a, b] = await Promise.all([retry(session, OWNER, patch), retry(session, OWNER, patch)]);
    const oks = [a, b].filter((r) => r.ok);
    expect(oks.length).toBe(1);
    const loser = [a, b].find((r) => !r.ok);
    expect(loser?.content).toMatch(/already being retried|already succeeded/);
    const pages = await admin(
      (sql) => sql`SELECT 1 FROM pages WHERE slug = ${slug}` as Promise<unknown[]>,
    );
    expect(pages.length).toBe(1);
  });

  it("another actor (RLS) and another session (a subagent's) cannot retry the call", async () => {
    const session = await newSession(OWNER, `t1275-iso-${TS}`);
    await dispatchAndKeep(
      session,
      OWNER,
      "tc-iso",
      "build_page",
      buildPageArgs(`t1275-iso-${TS}`, "t1275-nope"),
    );
    // Row level: the other actor does not see the kept row at all.
    const seen = async (actorId: string) => {
      const sql = new SQL(ADMIN_URL!);
      try {
        return await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'human'");
          await tx.unsafe(`SET LOCAL caelo.actor_id = '${actorId}'`);
          return (await tx`
            SELECT 1 FROM chat_tool_results
            WHERE chat_session_id = ${session.chatSessionId}::uuid AND tool_call_id = 'tc-iso'
          `) as unknown[];
        });
      } finally {
        await sql.end();
      }
    };
    expect((await seen(OWNER.actorId)).length).toBe(1);
    expect((await seen(OTHER.actorId)).length).toBe(0);

    const asOther = await retry(session, OTHER, { toolCallId: "tc-iso" });
    expect(asOther.ok).toBe(false);
    expect(asOther.content).toContain("no kept call");

    const child = await newSession(OWNER, `t1275-child-${TS}`);
    const fromChild = await retry(child, OWNER, { toolCallId: "tc-iso" });
    expect(fromChild.ok).toBe(false);
    expect(fromChild.content).toContain("no kept call");
    expect((await keptRow(session.chatSessionId, "tc-iso"))?.args).not.toBeNull();
  });
});

describe("retry_tool_call — Power-MCP", () => {
  it("keeps a schema-rejected delete_pages_many; the fixed retry queues the approval it now needs", async () => {
    const minted = await execute(registry, adapter, OWNER, "mcp_tokens.create", {
      displayName: `t1275-${TS}`,
      scope: "admin",
    });
    if (!minted.ok) throw new Error(`token: ${JSON.stringify(minted.error)}`);
    const plaintextToken = (minted.value as { plaintextToken: string }).plaintextToken;
    const opened = await execute(registry, adapter, SYSTEM, "mcp.open_session", {
      plaintextToken,
      newSession: true,
      title: `t1275-mcp-${TS}`,
    });
    if (!opened.ok) throw new Error(`open: ${JSON.stringify(opened.error)}`);
    const { chatSessionId } = opened.value as { chatSessionId: string };

    const pageIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const p = await execute(registry, adapter, SYSTEM, "pages.create", {
        slug: `t1275-del-${i}-${TS}`,
        title: `T1275 del ${i}`,
        pageType: TYPE,
      });
      if (!p.ok) throw new Error(`page: ${JSON.stringify(p.error)}`);
      pageIds.push((p.value as { pageId: string }).pageId);
    }
    const items = pageIds.map((pageId, i) => ({
      pageId: i === 4 ? "not-a-uuid" : pageId,
      disposition: "404",
    }));
    const first = await execute(registry, adapter, SYSTEM, "mcp.execute_tool", {
      plaintextToken,
      chatSessionId,
      toolName: "delete_pages_many",
      args: { items },
    });
    if (!first.ok) throw new Error(`execute: ${JSON.stringify(first.error)}`);
    const v1 = first.value as { ok: boolean; content: string; toolCallId: string };
    expect(v1.ok).toBe(false);
    expect(v1.content).toContain(`retry_tool_call({toolCallId:"${v1.toolCallId}"`);
    expect((await keptRow(chatSessionId, v1.toolCallId))?.args).not.toBeNull();

    const second = await execute(registry, adapter, SYSTEM, "mcp.execute_tool", {
      plaintextToken,
      chatSessionId,
      toolName: "retry_tool_call",
      args: {
        toolCallId: v1.toolCallId,
        set: [{ path: ["items", 4, "pageId"], value: pageIds[4] }],
      },
    });
    if (!second.ok) throw new Error(`retry: ${JSON.stringify(second.error)}`);
    const v2 = second.value as { ok: boolean; content: string };
    expect(v2.content).toMatch(/^Queued proposal/);
    expect(v2.ok).toBe(true);
    // Five pages cross the approval threshold: queued, not deleted.
    expect(v2.content).toMatch(/^Queued proposal [0-9a-f-]{36}:/);
    const live = await admin(
      (sql) =>
        sql`
        SELECT count(*)::int AS n FROM pages
        WHERE id IN ${sql(pageIds)} AND deleted_at IS NULL
      ` as Promise<{ n: number }[]>,
    );
    expect(live[0]?.n).toBe(5);
    expect((await keptRow(chatSessionId, v1.toolCallId))?.args).toBeNull();
  });
});
