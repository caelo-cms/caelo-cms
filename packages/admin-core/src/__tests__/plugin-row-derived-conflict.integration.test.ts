// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1705 — an approved plugin decision failed on rows the plugin's own
 * change consumer had written.
 *
 * consent-manager keeps one verdict row per module that reaches a third
 * party. Its change consumer rewrites the row on the chat's branch whenever
 * a module's embed changes (#1214, #1267): a write with no chat behind it,
 * which the draft conflict check counted as "another chat's change" the
 * caller had not seen. So the Owner approved `allow_external_embed`, and
 * the apply refused with "Conflict: pluginRow … was changed in the shared
 * draft by chat 'a change made outside a chat'" — also for the very chat
 * whose own module edit the row was derived from, and although the read the
 * AI made (list_external_embeds) showed exactly that row.
 *
 * Pinned here through the real change consumer, plugin host and lock path,
 * on the shared draft:
 *
 *   - a row the consumer derived is no chat's change: the chat's write over
 *     it lands, approved or not;
 *   - another chat's change still conflicts, and still clears only with
 *     the read the conflict names (the rule #620 / #1387 stands);
 *   - before the Owner is asked, `plugins.unseen_draft_rows` names the
 *     plugin's rows another chat changed since this chat last saw them
 *     (never the consumer's), so a stale view is refused before the card.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  drainChangeConsumers,
  loadedPlugins,
  type PluginHostInfra,
  pluginToolsRegistry,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import {
  definePlugin,
  type PluginAdminQuery,
  type PluginChangesArgs,
  type PluginInvocation,
} from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { preflightDraftBoundPluginCall } from "../ai/chat-runner/approval-preflight.js";
import { stalePluginViewBeforeApproval } from "../ai/plugin-approval-staleness.js";
import { queuePluginToolApproval } from "../ai/queued-tool-approval.js";
import { type ToolContext, ToolRegistry } from "../ai/tools/dispatch.js";
import { getPluginDraftRowsTool } from "../ai/tools/get-plugin-draft-rows.js";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SLUG = "t1705-verdicts";
const SCHEMA = "plugin_t1705_verdicts";
const PFX = "t1705-";
const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "t1705" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let tools: ToolRegistry;
let infra: PluginHostInfra;
let moduleCounter = 0;

const q = (ctx: unknown): PluginAdminQuery => {
  const handle = (ctx as { adminQuery?: PluginAdminQuery }).adminQuery;
  if (!handle) throw new Error("adminQuery missing");
  return handle;
};

/** The verdict row of a module, as the caller sees it. */
async function verdictOf(ctx: unknown, moduleId: string) {
  const rows = await q(ctx).list<string, { id: string; status: string }>("verdicts", {
    anyOf: { module_id: [moduleId] },
    limit: 2,
  });
  return rows[0];
}

/** Record `status` for the module: the row's update, or its first insert. */
async function record(ctx: unknown, moduleId: string, status: string) {
  const row = await verdictOf(ctx, moduleId);
  if (row) await q(ctx).update("verdicts", row.id, { status });
  else await q(ctx).insert("verdicts", { module_id: moduleId, status });
  return { status };
}

/**
 * consent-manager's shape in small: a verdict per module, re-derived by the
 * change consumer when a module changes (`syncGuards`), decided by a tool.
 */
const plugin = definePlugin({
  slug: SLUG,
  version: "0.1.0",
  tier: 1,
  schema: {},
  adminSchema: { verdicts: { module_id: "ref:modules", status: "string" } },
  aiReadableTables: ["verdicts"],
  requestedCapabilities: ["cms_admin_schema", "cms_admin", "change_journal", "chat_runner_tools"],
  tools: [
    {
      name: "allow_test_embed",
      description:
        "Let a module's embed render for every visitor. TWO-STEP: PAUSES for the Owner's Approve.",
      operationName: "decide",
      approvalMode: "user-approval",
      approvedOnChatBranch: true,
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["moduleId", "status"],
        properties: {
          moduleId: { type: "string", format: "uuid" },
          status: { type: "string", maxLength: 40 },
        },
      },
    },
  ],
  changeConsumer: {
    operationName: "module_changes",
    rebuildOperationName: "rebuild",
    kinds: ["module"],
    lines: "all",
  },
  operations: {
    module_changes: async (ctx, args) => {
      const { changes } = args as PluginChangesArgs;
      for (const c of changes) {
        if (c.kind === "module" && c.op !== "delete") await record(ctx, c.rowId, "pending");
      }
      return {};
    },
    rebuild: async () => ({}),
    decide: async (ctx, args) => {
      const a = args as { moduleId: string; status: string };
      return record(ctx, a.moduleId, a.status);
    },
    find: async (ctx, args) =>
      (await verdictOf(ctx, (args as { moduleId: string }).moduleId))?.id ?? null,
  },
});

async function withSystemSql<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  resetPluginHost();
  await withSystemSql(async (tx) => {
    await tx.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    const byPluginActor = `SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${SLUG}')`;
    await tx.unsafe(`DELETE FROM site_snapshots WHERE actor_id IN (${byPluginActor})`);
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (${byPluginActor})`);
    await tx.unsafe(
      `DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${SLUG}')`,
    );
    await tx.unsafe(`DELETE FROM plugins WHERE slug = '${SLUG}'`);
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
  });
}

interface Chat {
  readonly title: string;
  readonly ai: ExecutionContext;
  readonly invocation: PluginInvocation;
  /** The same chat's call after the Owner's click (`approvedOnChatBranch`). */
  readonly approved: PluginInvocation;
}

/** A new chat on the site's shared draft, as the AI acting in it. */
async function draftChat(name: string): Promise<Chat> {
  const title = `${PFX}${name}`;
  const r = await execute(registry, adapter, SYS, "chat.create_session", { title });
  if (!r.ok) throw new Error(`chat.create_session: ${JSON.stringify(r.error)}`);
  const { chatSessionId, chatBranchId, branchKind } = r.value as {
    chatSessionId: string;
    chatBranchId: string;
    branchKind: string;
  };
  expect(branchKind).toBe("draft");
  return {
    title,
    ai: {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: `t1705-${name}`,
      chatBranchId,
      chatTaskId: chatSessionId,
    },
    invocation: {
      origin: "chat",
      actorId: HUMAN,
      operatorActorId: HUMAN,
      chatBranchId,
      chatTaskId: chatSessionId,
    },
    approved: { origin: "approved", actorId: HUMAN, chatBranchId, chatTaskId: chatSessionId },
  };
}

/** A module the chat adds to the draft (an embed it wants to resolve next). */
async function addModule(chat: Chat): Promise<string> {
  moduleCounter += 1;
  const r = await execute(registry, adapter, chat.ai, "modules.create", {
    slug: `${PFX}video-${moduleCounter}`,
    displayName: `${PFX}video ${moduleCounter}`,
    html: `<iframe src="https://www.youtube.com/embed/v${moduleCounter}"></iframe>`,
    css: "",
    js: "",
    fields: [],
  });
  if (!r.ok) throw new Error(`modules.create: ${JSON.stringify(r.error)}`);
  return (r.value as { moduleId: string }).moduleId;
}

/** Let the change consumer catch up, as it does right after every commit. */
async function consume(): Promise<void> {
  const reports = await drainChangeConsumers(infra);
  for (const r of reports) if (r.error) throw new Error(`consumer ${r.slug}: ${r.error}`);
}

async function decide(invocation: PluginInvocation, moduleId: string, status: string) {
  return runPluginOperation({
    pluginSlug: SLUG,
    operationName: "decide",
    args: { moduleId, status },
    invocation,
  });
}

function landed(r: Awaited<ReturnType<typeof decide>>): void {
  if (!r.ok) throw new Error(`expected the write to land: ${r.error.message}`);
}

function conflictOf(r: Awaited<ReturnType<typeof decide>>): string {
  if (r.ok) throw new Error("expected a draft conflict, but the write went through");
  expect(r.error.message).toContain("Conflict:");
  return r.error.message;
}

/** The verdict row id of a module in the chat's view (a plugin read: records nothing). */
async function verdictRowId(chat: Chat, moduleId: string): Promise<string> {
  const r = await runPluginOperation({
    pluginSlug: SLUG,
    operationName: "find",
    args: { moduleId },
    invocation: chat.invocation,
  });
  if (!r.ok || typeof r.value !== "string") throw new Error(`no verdict row for ${moduleId}`);
  return r.value;
}

/** The read a conflict names, as the AI makes it (through the dispatcher). */
async function readRows(chat: Chat, rowIds: string[]): Promise<void> {
  const toolCtx: ToolContext = {
    adapter,
    registry,
    chatBranchId: chat.ai.chatBranchId as string,
    chatSessionId: chat.ai.chatTaskId as string,
  };
  const r = await tools.dispatch("get_plugin_draft_rows", { rowIds }, chat.ai, toolCtx);
  if (!r.ok) throw new Error(`get_plugin_draft_rows: ${r.content}`);
}

/** What the approval preflight says before the Owner would be asked to allow the module. */
async function beforeCard(chat: Chat, moduleId: string): Promise<string | null> {
  return stalePluginViewBeforeApproval({
    registry,
    adapter,
    aiCtx: chat.ai,
    pluginSlug: SLUG,
    toolName: "allow_test_embed",
    args: { moduleId, status: "allowed" },
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  tools = new ToolRegistry();
  tools.register(getPluginDraftRowsTool);
  await wipe();
  infra = { adapter, registry, lockPluginRow };
  const report = await bootstrap({
    infra,
    pluginsRoot: "/dev/null/unused",
    systemActorId: HUMAN,
    testPlugins: [{ definition: plugin }],
  });
  expect(report.failed).toEqual([]);
  expect(loadedPlugins.bySlug(SLUG)).toBeDefined();
  // First sight of the consumer runs its rebuild; changes arrive after it.
  await consume();
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("a plugin row its change consumer derived on the draft (#1705)", () => {
  it("is no chat's change: the approved decision of the chat that added the module lands", async () => {
    const a = await draftChat("own-a");
    const moduleId = await addModule(a);
    await consume();
    // The consumer wrote the row on the shared draft, with no chat behind it.
    const head = await withSystemSql(
      (tx) => tx`
        SELECT d.owner_chat_session_id FROM draft_pending_entities d
        WHERE d.entity_kind = 'pluginRow' AND d.table_name = 'verdicts'
          AND d.chat_branch_id = ${a.ai.chatBranchId as string}::uuid
      `,
    );
    expect(head.length).toBeGreaterThan(0);
    expect(
      head.every((r: { owner_chat_session_id: string | null }) => r.owner_chat_session_id === null),
    ).toBe(true);

    landed(await decide(a.approved, moduleId, "allowed"));
  });

  it("is no chat's change for another chat either, and the preflight lets the card through", async () => {
    const a = await draftChat("other-a");
    const b = await draftChat("other-b");
    const moduleId = await addModule(a);
    await consume();
    expect(await beforeCard(b, moduleId)).toBeNull();
    landed(await decide(b.approved, moduleId, "allowed"));
  });

  it("re-derived after the chat's own decision, it still lets the chat's next decision land", async () => {
    const a = await draftChat("again-a");
    const moduleId = await addModule(a);
    await consume();
    landed(await decide(a.invocation, moduleId, "gated"));
    // The module's embed changes; the consumer re-derives the row after
    // the chat's decision.
    const edit = await execute(registry, adapter, a.ai, "modules.update", {
      moduleId,
      html: '<iframe src="https://player.vimeo.com/video/1"></iframe>',
    });
    if (!edit.ok) throw new Error(`modules.update: ${JSON.stringify(edit.error)}`);
    await consume();
    landed(await decide(a.approved, moduleId, "allowed"));
  });

  it("another chat's decision still conflicts, is named before the card, and clears with the named read", async () => {
    const a = await draftChat("chat-a");
    const b = await draftChat("chat-b");
    const moduleId = await addModule(a);
    await consume();
    landed(await decide(a.invocation, moduleId, "gated"));
    const rowId = await verdictRowId(a, moduleId);

    // Before the Owner is asked: the stale view is refused, naming the read.
    const refusal = await beforeCard(b, moduleId);
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("allow_test_embed was NOT shown to the operator");
    expect(refusal).toContain(`get_plugin_draft_rows({rowIds:["${rowId}"]})`);
    expect(refusal).toContain(a.title);
    // And the apply refuses too, should a card have been shown anyway.
    expect(conflictOf(await decide(b.approved, moduleId, "allowed"))).toContain(a.title);

    // A call about another module is not held up by it.
    expect(await beforeCard(b, await addModule(b))).toBeNull();
    await readRows(b, [rowId]);
    expect(await beforeCard(b, moduleId)).toBeNull();
    landed(await decide(b.approved, moduleId, "allowed"));
  });

  it("the chat's approval preflight and the MCP queue both refuse the stale card", async () => {
    const a = await draftChat("paths-a");
    const b = await draftChat("paths-b");
    const moduleId = await addModule(a);
    await consume();
    landed(await decide(a.invocation, moduleId, "gated"));
    const args = { moduleId, status: "allowed" };

    // In the chat: the gated call is declined before its card (loop.ts).
    const inChat = await preflightDraftBoundPluginCall(
      registry,
      adapter,
      b.ai,
      "allow_test_embed",
      args,
    );
    expect(inChat?.reason).toContain("was NOT shown to the operator");

    // Over MCP: nothing is queued.
    const pluginTool = pluginToolsRegistry.resolve("allow_test_embed");
    if (!pluginTool) throw new Error("allow_test_embed is not registered");
    const queue = () =>
      queuePluginToolApproval({
        registry,
        adapter,
        aiCtx: b.ai,
        operatorActorId: HUMAN,
        chatSessionId: b.ai.chatTaskId as string,
        pluginTool,
        args,
      });
    const refused = await queue();
    expect(refused.ok).toBe(false);
    expect(refused.content).toContain("get_plugin_draft_rows");

    await readRows(b, [await verdictRowId(a, moduleId)]);
    expect(
      await preflightDraftBoundPluginCall(registry, adapter, b.ai, "allow_test_embed", args),
    ).toBeNull();
    expect(await queue()).toMatchObject({ ok: true });
  });

  it("the preflight names nothing outside a draft chat", async () => {
    const r = await stalePluginViewBeforeApproval({
      registry,
      adapter,
      aiCtx: SYS,
      pluginSlug: SLUG,
      toolName: "allow_test_embed",
      args: { moduleId: crypto.randomUUID() },
    });
    expect(r).toBeNull();
  });
});
