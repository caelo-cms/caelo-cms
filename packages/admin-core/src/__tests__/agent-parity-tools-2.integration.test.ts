// SPDX-License-Identifier: MPL-2.0

/**
 * Integration tests for the agent-tool parity part-2 tools against real
 * Postgres: each tool dispatched through the default ToolRegistry as the AI
 * actor (on a chat branch where it matters), exactly as the chat-runner and
 * the Power-MCP dispatch it.
 *
 * Pins the contracts the tools rely on:
 *  - a queued needsApproval card shows up in list_pending_proposals (and the
 *    bell count) under domain `tool_approvals`;
 *  - pinned skills set by the AI land on the chat operator's user, and the AI
 *    outside a chat gets an actionable error instead of an FK failure;
 *  - the AI reads email config with transport secrets redacted;
 *  - get_plugin reports a plugin's 24h AI spend against its cap, never its source;
 *  - history / blast-radius / unpublished-changes reads see the AI's branch;
 *  - log_import_events appends to the ledger in one call; list_import_runs finds the run;
 *  - refresh_page_path recomputes a page URL.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { createDefaultToolRegistry, type ToolContext } from "../ai/tools/index.js";
import { registerAdminOps } from "../register.js";
import { ensureRoleUser } from "./fixtures/role-user.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const P = "parity2-int";
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: `${P}-sys`,
};
const OWNER: ExecutionContext = {
  actorId: "00000000-0000-4000-8000-0000000a2201",
  actorKind: "human",
  requestId: `${P}-owner`,
};
const AI_ACTOR = "00000000-0000-0000-0000-000000000a1a";
const AI_NO_CHAT: ExecutionContext = { actorId: AI_ACTOR, actorKind: "ai", requestId: `${P}-ai` };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let toolCtx: ToolContext;
const tools = createDefaultToolRegistry();
let templateId: string;

async function sqlAdmin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await sqlAdmin(async (tx) => {
    await tx`DELETE FROM tool_approval_actions WHERE tool_name LIKE ${`${P}%`}`;
    await tx`DELETE FROM skill_pin_defaults WHERE user_id = ${OWNER.actorId}::uuid`;
    await tx`DELETE FROM skills WHERE slug LIKE ${`${P}%`}`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${P}%`}`;
    await tx`DELETE FROM import_runs WHERE source_url LIKE ${`https://${P}%`}`;
    await tx`DELETE FROM ai_calls WHERE request_id LIKE ${`${P}%`}`;
    await tx`DELETE FROM plugins WHERE slug LIKE ${`${P}%`}`;
    await tx`DELETE FROM redirects WHERE from_path LIKE ${`/${P}%`}`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${P}%`}`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${P}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${P}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${P}%`}`;
  });
}

async function ok<T>(name: string, input: unknown, ctx: ExecutionContext = SYSTEM): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** A chat session opened BY the owner; the AI context the chat-runner builds for it. */
async function openOwnerChat(
  label: string,
): Promise<{ ai: ExecutionContext; chatSessionId: string }> {
  const s = await ok<{ chatSessionId: string; chatBranchId: string }>(
    "chat.create_session",
    { title: `${P}-${label}` },
    OWNER,
  );
  return {
    chatSessionId: s.chatSessionId,
    ai: {
      actorId: AI_ACTOR,
      actorKind: "ai",
      requestId: `${P}-${label}`,
      chatBranchId: s.chatBranchId,
      chatTaskId: s.chatSessionId,
    },
  };
}

async function dispatch(name: string, args: unknown, ctx: ExecutionContext) {
  return tools.dispatch(name, args, ctx, {
    ...toolCtx,
    ...(ctx.chatTaskId ? { chatSessionId: ctx.chatTaskId } : {}),
    ...(ctx.chatBranchId ? { chatBranchId: ctx.chatBranchId } : {}),
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  toolCtx = { adapter, registry };
  await ensureRoleUser(ADMIN_URL as string, OWNER.actorId, "owner");
  await wipe();
  const t = await ok<{ templateId: string }>("templates.create", {
    slug: `${P}-tpl`,
    displayName: "Parity2 template",
    html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  templateId = t.templateId;
  await ok("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("tool approvals in the pending-proposals aggregator", () => {
  it("a queued needsApproval card is listed for the agent and counted by the bell", async () => {
    const { ai, chatSessionId } = await openOwnerChat("approvals");
    const before = await ok<{ pendingProposals: number }>("notifications.aggregate", {});
    const q = await ok<{ proposalId: string }>(
      "tool_approvals.queue",
      { toolName: `${P}_gated`, args: {}, preview: {}, chatSessionId },
      ai,
    );
    const r = await dispatch("list_pending_proposals", {}, ai);
    expect(r.ok).toBe(true);
    expect(r.content).toContain(`tool_approvals,${P}_gated,${q.proposalId}`);
    const after = await ok<{ pendingProposals: number }>("notifications.aggregate", {});
    expect(after.pendingProposals).toBe(before.pendingProposals + 1);
  });
});

describe("skill pin defaults", () => {
  it("the AI pins skills for the operator its chat acts for", async () => {
    await sqlAdmin(async (tx) => {
      for (const slug of [`${P}-a`, `${P}-b`]) {
        await tx`
          INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
          VALUES (${slug}, ${slug}, 'test', 'body', '[]'::jsonb,
                  ${JSON.stringify({ keywords: [], chipTrigger: false, alwaysOn: false })}::jsonb, 'active')
          ON CONFLICT (slug) DO UPDATE SET status = 'active'`;
      }
    });
    const { ai } = await openOwnerChat("pins");
    const set = await dispatch("set_skill_pin_defaults", { slugs: [`${P}-b`, `${P}-a`] }, ai);
    expect(set.ok, set.content).toBe(true);
    const asOwner = await ok<{ pinDefaults: { slug: string }[] }>(
      "skills.list_pin_defaults",
      {},
      OWNER,
    );
    expect(asOwner.pinDefaults.map((p) => p.slug)).toEqual([`${P}-a`, `${P}-b`]);
    const listed = await dispatch("list_skill_pin_defaults", {}, ai);
    expect(listed.content).toContain(`${P}-a`);

    const cleared = await dispatch("set_skill_pin_defaults", { slugs: [] }, ai);
    expect(cleared.ok).toBe(true);
    const empty = await ok<{ pinDefaults: unknown[] }>("skills.list_pin_defaults", {}, OWNER);
    expect(empty.pinDefaults).toHaveLength(0);
  });

  it("outside a chat the AI gets an actionable error, not a foreign-key failure", async () => {
    const r = await dispatch("set_skill_pin_defaults", { slugs: [] }, AI_NO_CHAT);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("caelo_open_session");
  });
});

describe("operator dashboards", () => {
  it("get_email_config shows the transport with secrets redacted for the AI", async () => {
    await ok("email_config.set", {
      transport: "resend",
      fromAddress: `hello@${P}.test`,
      config: { apiKey: "re_super_secret_value" },
    });
    try {
      const r = await dispatch("get_email_config", {}, AI_NO_CHAT);
      expect(r.ok).toBe(true);
      expect(r.content).toContain("transport: resend");
      expect(r.content).toContain("[redacted]");
      expect(JSON.stringify(r)).not.toContain("re_super_secret_value");
    } finally {
      await ok("email_config.set", { transport: "none", fromAddress: "", config: {} });
    }
  });

  it("get_plugin reports 24h AI spend against the cap and never the source", async () => {
    const pluginId = await sqlAdmin(async (tx) => {
      const p = (await tx`
        INSERT INTO plugins (slug, version, tier, status, manifest_json, source_code, submitted_by, ai_cost_cap_microcents)
        VALUES (${`${P}-plug`}, '1.0.0', 2, 'awaiting_activation',
                ${JSON.stringify({ tools: [{ name: "plug_tool" }] })}::jsonb,
                'const SOURCE_MARKER = 1;', ${OWNER.actorId}::uuid, 200000000)
        RETURNING id::text AS id`) as { id: string }[];
      const id = p[0]?.id as string;
      await tx`INSERT INTO ai_calls (actor_id, provider, model, input_tokens, output_tokens,
                 cost_estimate_microcents, plugin_id, operation_type, request_id)
               VALUES (${SYSTEM.actorId}::uuid, 'anthropic', 'm', 1, 1, 150000000, ${id}::uuid, 'text', ${`${P}-call`})`;
      return id;
    });
    expect(pluginId).toBeTruthy();
    const r = await dispatch("get_plugin", { slug: `${P}-plug` }, AI_NO_CHAT);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("plug_tool");
    expect(r.content).toContain("AI spend last 24h: $1.50 over 1 calls; cap $2.00");
    expect(JSON.stringify(r)).not.toContain("SOURCE_MARKER");
    const spend = await dispatch("get_ai_spend", { sinceDays: 1 }, AI_NO_CHAT);
    expect(spend.ok).toBe(true);
    expect(spend.content).toContain("AI spend since");
  });

  it("gateway, bug-report, media and SEO reads run as the AI actor", async () => {
    for (const [name, args] of [
      ["get_gateway_analytics", {}],
      ["list_gateway_requests", { onlyErrors: true }],
      ["list_rate_limit_profiles", {}],
      ["list_bug_reports", {}],
      ["get_media_settings", {}],
      ["list_stale_seo_pages", {}],
      ["list_media_usages", { assetId: "11111111-1111-4111-8111-111111111111" }],
      ["get_page_seo", { pageId: "11111111-1111-4111-8111-111111111111" }],
    ] as const) {
      const r = await dispatch(name, args, AI_NO_CHAT);
      expect(r.ok, `${name}: ${r.content}`).toBe(true);
    }
  });
});

describe("history + unpublished changes", () => {
  it("the AI sees its branch edit as unpublished, finds the snapshot and inspects it", async () => {
    const { ai } = await openOwnerChat("history");
    const created = await ok<{ moduleId: string }>(
      "modules.create",
      {
        slug: `${P}-hist`,
        displayName: `${P} hist`,
        html: "<p>history</p>",
        fields: [{ name: "body", kind: "text", label: "Body" }],
      },
      ai,
    );
    const pending = await dispatch("list_unpublished_changes", {}, ai);
    expect(pending.ok).toBe(true);
    expect(pending.content).toContain("pending");
    expect(pending.content).toContain(`${P}-hist`);

    const listed = await dispatch(
      "list_snapshots",
      { forModuleId: created.moduleId, full: true },
      ai,
    );
    expect(listed.ok).toBe(true);
    const snapshotId = /([0-9a-f-]{36}),/.exec(listed.content)?.[1];
    expect(snapshotId).toBeTruthy();
    const snap = await dispatch("get_snapshot", { snapshotId }, ai);
    expect(snap.ok).toBe(true);
    expect(snap.content).toContain(`module ${created.moduleId}`);

    const impact = await dispatch("get_module_impact", { moduleId: created.moduleId }, ai);
    expect(impact.ok).toBe(true);
    expect(impact.content).toContain("0 page placement(s)");
  });
});

describe("import ledger + page URL repair", () => {
  it("log_import_events appends in one call and list_import_runs finds the run", async () => {
    const run = await ok<{ runId: string }>("imports.create_run", {
      sourceUrl: `https://${P}.example.com/`,
      depth: 1,
      maxPages: 5,
    });
    const r = await dispatch(
      "log_import_events",
      {
        events: [
          { runId: run.runId, severity: "warning", phase: "media", message: "skipped logo.svg" },
          { runId: run.runId, severity: "info", message: "done", detail: { pages: 1 } },
        ],
      },
      AI_NO_CHAT,
    );
    expect(r.ok).toBe(true);
    const count = await sqlAdmin(
      async (tx) =>
        (await tx`SELECT count(*)::int AS c FROM import_run_events WHERE run_id = ${run.runId}::uuid`) as {
          c: number;
        }[],
    );
    expect(count[0]?.c).toBe(2);
    const listed = await dispatch("list_import_runs", { filter: P, full: true }, AI_NO_CHAT);
    expect(listed.content).toContain(run.runId);
  });

  it("refresh_page_path recomputes a page's URL", async () => {
    const page = await ok<{ pageId: string }>("pages.create", {
      slug: `${P}-url`,
      title: "URL page",
      templateId,
    });
    const r = await dispatch("refresh_page_path", { pageId: page.pageId }, AI_NO_CHAT);
    expect(r.ok, r.content).toBe(true);
    expect(r.content).toContain(`/${P}-url`);
  });
});
