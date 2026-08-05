// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #376 — Power-MCP surface: token scope, catalogue filtering,
 * work sessions, single-tool execution (incl. the snapshot/branch/task
 * attribution the whole feature exists to preserve), the gated-tool
 * fallback, the needsApproval gate, and the cost cap at the
 * execute_tool boundary. Unlike mcp.integration.test.ts (which leaves
 * the AI half to the dogfood loop), the execute_tool happy path IS
 * covered here — it needs no AI provider, that being the point of the
 * feature.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { Screenshot, Screenshotter } from "@caelo-cms/site-importer";
import { SQL } from "bun";
import {
  PREVIEW_SCREENSHOT_TOKEN_HEADER,
  verifyPreviewScreenshotToken,
} from "../ai/preview-screenshot-token.js";
import { setExternalScreenshotterForTests } from "../ai/tools/_external-screenshotter.js";
import { resetPreviewScreenshotBudgetForTests } from "../ai/tools/_preview-screenshot-budget.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { POWER_MCP_EXCLUDED_TOOLS, powerToolCatalogue } from "../ops/security/mcp_power.js";
import { findExcludedToolMentions } from "../ops/security/mcp_power_prose.js";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "mcp-power-test",
};
const ownerCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000002",
  actorKind: "human",
  requestId: "mcp-power-test-owner",
};

async function ensureOwnerActor(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO actors (id, kind, display_name)
               VALUES (${ownerCtx.actorId}::uuid, 'human', 'mcp-power-test owner')
               ON CONFLICT (id) DO NOTHING`;
    });
  } finally {
    await sql.end();
  }
}

async function wipeOurRows(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM mcp_tokens WHERE actor_id = ${ownerCtx.actorId}::uuid`;
      await tx`DELETE FROM structured_sets WHERE slug LIKE 'mcp-power-test-%'`;
    });
  } finally {
    await sql.end();
  }
}

async function mintToken(scope: "chat" | "admin", cap?: number): Promise<string> {
  const r = await execute(registry, adapter, ownerCtx, "mcp_tokens.create", {
    displayName: `power-test-${scope}${cap !== undefined ? "-capped" : ""}`,
    scope,
    ...(cap !== undefined ? { aiCostCapMicrocents: cap } : {}),
  });
  if (!r.ok) throw new Error("token mint failed");
  return (r.value as { plaintextToken: string }).plaintextToken;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL!,
    publicDatabaseUrl: PUBLIC_URL!,
  });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await ensureOwnerActor();
  await wipeOurRows();
  // No provider: the Power-MCP path must work without one — reasoning
  // happens in the external agent. Only AI-spending tools would notice.
  configureMcpBridge({
    adapter,
    registry,
    resolveProvider: async () => null,
  });
});

afterAll(async () => {
  await wipeOurRows();
});

describe("powerToolCatalogue (no DB)", () => {
  it("filters the excluded loop/browser tools and keeps the rest, schemas intact", () => {
    const tools = powerToolCatalogue(createDefaultToolRegistry());
    const names = new Set(tools.map((t) => t.name));
    for (const excluded of POWER_MCP_EXCLUDED_TOOLS.keys()) {
      expect(names.has(excluded)).toBe(false);
    }
    expect(names.has("build_page")).toBe(true);
    expect(names.has("load_skill")).toBe(true);
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema).toBeDefined();
    }
    // Gated propose_* tools stay listed — they queue an Owner proposal.
    const gated = tools.find((t) => t.name === "propose_create_mcp_token");
    expect(gated?.gated).toBe(true);
  });
});

describe("Power-MCP token scope", () => {
  it("defaults new tokens to scope 'chat' and lists the scope", async () => {
    const r = await execute(registry, adapter, ownerCtx, "mcp_tokens.create", {
      displayName: "power-test-default-scope",
    });
    expect(r.ok).toBe(true);
    const list = await execute(registry, adapter, ownerCtx, "mcp_tokens.list", {});
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const row = (
      list.value as { tokens: Array<{ displayName: string; scope: string }> }
    ).tokens.find((t) => t.displayName === "power-test-default-scope");
    expect(row?.scope).toBe("chat");
  });

  it("rejects a chat-scoped token on the admin surface with an actionable auth error", async () => {
    const chatToken = await mintToken("chat");
    for (const op of ["mcp.list_tools", "mcp.get_context"]) {
      const r = await execute(registry, adapter, systemCtx, op, { plaintextToken: chatToken });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      const msg = "message" in r.error ? String(r.error.message) : "";
      expect(msg).toMatch(/^auth_error: token scope 'chat'/);
      expect(msg).toContain("/security/mcp");
    }
    const exec = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      plaintextToken: chatToken,
      chatSessionId: crypto.randomUUID(),
      toolName: "list_pages",
    });
    expect(exec.ok).toBe(false);
    if (!exec.ok) {
      expect("message" in exec.error ? exec.error.message : "").toMatch(
        /^auth_error: token scope 'chat'/,
      );
    }
  });
});

describe("Power-MCP surface (admin token)", () => {
  let adminToken: string;
  let chatSessionId: string;
  let chatBranchId: string;

  beforeAll(async () => {
    adminToken = await mintToken("admin");
  });

  it("lists the filtered catalogue", async () => {
    const r = await execute(registry, adapter, systemCtx, "mcp.list_tools", {
      plaintextToken: adminToken,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = new Set((r.value as { tools: { name: string }[] }).tools.map((t) => t.name));
    expect(names.has("build_page")).toBe(true);
    expect(names.has("spawn_subagents")).toBe(false);
    // issue #412 — screenshot_page is SERVED now: the server-side backend
    // needs no operator browser, so external agents can self-verify.
    expect(names.has("screenshot_page")).toBe(true);
  });

  it("opens and resumes a work session", async () => {
    const created = await execute(registry, adapter, systemCtx, "mcp.open_session", {
      plaintextToken: adminToken,
      title: "mcp-power-test session",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const v = created.value as { chatSessionId: string; chatBranchId: string; resumed: boolean };
    expect(v.resumed).toBe(false);
    chatSessionId = v.chatSessionId;
    chatBranchId = v.chatBranchId;

    const resumed = await execute(registry, adapter, systemCtx, "mcp.open_session", {
      plaintextToken: adminToken,
      chatSessionId,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect((resumed.value as { resumed: boolean }).resumed).toBe(true);
    expect((resumed.value as { chatBranchId: string }).chatBranchId).toBe(chatBranchId);
  });

  it("refuses execute_tool without a valid session, pointing at open_session", async () => {
    const r = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      plaintextToken: adminToken,
      chatSessionId: crypto.randomUUID(),
      toolName: "list_pages",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect("message" in r.error ? r.error.message : "").toContain("open_session");
  });

  it("refuses excluded tools with the routing reason", async () => {
    const r = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      plaintextToken: adminToken,
      chatSessionId,
      toolName: "spawn_subagents",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect("message" in r.error ? r.error.message : "").toContain("not available over MCP");
  });

  it("executes screenshot_page headless and returns the image in the tool result (issue #412)", async () => {
    // The Playwright browser is faked through the shared seam; the REAL
    // pieces under test are the Power-MCP dispatch (no pushClientEvent →
    // server-side backend, no 30s timeout), the token minted for the
    // session's branch, and the image riding the execute_tool output the
    // MCP server turns into an image content block.
    const captured: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    const pngBytes = new Uint8Array(24);
    pngBytes[0] = 0x89;
    pngBytes[1] = 0x50;
    const fake: Screenshotter = {
      async capture(url, opts) {
        captured.push({ url, headers: opts?.sameOriginHeaders });
        const shot: Screenshot = {
          bytes: pngBytes,
          width: opts?.width ?? 1280,
          height: opts?.height ?? 800,
          finalUrl: url,
          finalStatus: 200,
        };
        return shot;
      },
      async renderHtml() {
        throw new Error("not used");
      },
      async query() {
        return [];
      },
      async dispose() {
        /* fake */
      },
    };
    setExternalScreenshotterForTests(async () => fake);
    const savedOrigin = process.env.CAELO_PREVIEW_SELF_ORIGIN;
    process.env.CAELO_PREVIEW_SELF_ORIGIN = "http://127.0.0.1:9";
    resetPreviewScreenshotBudgetForTests();
    try {
      const pageId = crypto.randomUUID();
      const r = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
        plaintextToken: adminToken,
        chatSessionId,
        toolName: "screenshot_page",
        args: { pageId },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const v = r.value as {
        ok: boolean;
        content: string;
        image: { base64: string; mediaType: string } | null;
      };
      expect(v.ok).toBe(true);
      expect(v.content).toContain("server-side renderer");
      expect(v.image?.mediaType).toBe("image/png");
      expect(v.image?.base64).toBe(Buffer.from(pngBytes).toString("base64"));
      // The capture hit the preview route for THIS page with a token
      // scoped to THIS session's branch — the acceptance criterion that
      // screenshots show preview-branch state, not published state.
      expect(captured[0]?.url).toBe(`http://127.0.0.1:9/_caelo/preview-screenshot/${pageId}`);
      const token = captured[0]?.headers?.[PREVIEW_SCREENSHOT_TOKEN_HEADER];
      const verified = verifyPreviewScreenshotToken(token ?? "", { expectedPageId: pageId });
      expect(verified).toEqual({ ok: true, pageId, chatBranchId });
    } finally {
      setExternalScreenshotterForTests(null);
      if (savedOrigin === undefined) delete process.env.CAELO_PREVIEW_SELF_ORIGIN;
      else process.env.CAELO_PREVIEW_SELF_ORIGIN = savedOrigin;
    }
  });

  it("executes a write tool as AI actor with branch + chat-task snapshot attribution", async () => {
    // set_structured_set rather than build_page: the latter is (correctly)
    // blocked by the cold-start identity/theme gate on a fresh install,
    // which is orthogonal to what this test proves — that a Power-MCP
    // write lands with the session's branch + chat-task attribution.
    const slug = `mcp-power-test-${Date.now().toString(36)}`;
    const r = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      plaintextToken: adminToken,
      chatSessionId,
      toolName: "set_structured_set",
      args: {
        kind: "nav-menu",
        slug,
        displayName: "Power MCP test nav",
        items: [{ label: "Home", href: "/" }],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { ok: boolean; content: string; cached: boolean };
    expect(v.ok).toBe(true);
    expect(v.cached).toBe(false);

    // The invariant the feature hangs on: the write's snapshot is grouped
    // under the session (chat-keyed undo) and scoped to its branch.
    // site_snapshots is RLS-FORCEd, so the probe needs an actor_kind.
    const sql = new SQL(ADMIN_URL!);
    try {
      const rows = (await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return await tx`
          SELECT chat_task_id::text AS task, chat_branch_id::text AS branch
          FROM site_snapshots
          WHERE chat_task_id = ${chatSessionId}::uuid
          ORDER BY created_at DESC
          LIMIT 1
        `;
      })) as unknown as Array<{ task: string; branch: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]?.branch).toBe(chatBranchId);
    } finally {
      await sql.end();
    }
  });

  it("caches repeats of a caller-supplied toolCallId", async () => {
    const toolCallId = `mcp-power-test-${crypto.randomUUID()}`;
    const call = () =>
      execute(registry, adapter, systemCtx, "mcp.execute_tool", {
        plaintextToken: adminToken,
        chatSessionId,
        toolName: "list_pages",
        args: {},
        toolCallId,
      });
    const first = await call();
    expect(first.ok).toBe(true);
    const second = await call();
    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) return;
    expect((first.value as { cached: boolean }).cached).toBe(false);
    expect((second.value as { cached: boolean }).cached).toBe(true);
    expect((second.value as { content: string }).content).toBe(
      (first.value as { content: string }).content,
    );
  });

  it("gated propose_* tools queue an Owner proposal instead of applying", async () => {
    const r = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      plaintextToken: adminToken,
      chatSessionId,
      toolName: "propose_create_mcp_token",
      args: { displayName: "power-test-proposed" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const content = (r.value as { content: string }).content;
    expect(content).toMatch(/^Queued proposal [0-9a-f-]{36}:/);

    const pending = await execute(registry, adapter, ownerCtx, "mcp_tokens.list_pending", {});
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    const rows = (
      pending.value as { proposals: Array<{ preview: Record<string, unknown> }> }
    ).proposals.filter((p) => p.preview.displayName === "power-test-proposed");
    expect(rows.length).toBe(1);

    // The apply half is not a tool — an external agent cannot reach it.
    const applied = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      plaintextToken: adminToken,
      chatSessionId,
      toolName: "mcp_tokens.execute_proposal",
      args: { proposalId: crypto.randomUUID() },
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect((applied.value as { ok: boolean }).ok).toBe(false);
    expect((applied.value as { content: string }).content).toContain("unknown tool");
  });

  it("routes delete_pages_many past the needsApproval threshold into the approval queue", async () => {
    const deletions = Array.from({ length: 5 }, () => ({
      pageId: crypto.randomUUID(),
      disposition: "404" as const,
    }));
    const r = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      plaintextToken: adminToken,
      chatSessionId,
      toolName: "delete_pages_many",
      args: { deletions },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { ok: boolean; content: string };
    expect(v.ok).toBe(true);
    expect(v.content).toMatch(/^Queued proposal [0-9a-f-]{36}:/);
  });

  it("enforces the per-token cost cap for AI-spending tools at the boundary", async () => {
    const cappedToken = await mintToken("admin", 1_000);
    const opened = await execute(registry, adapter, systemCtx, "mcp.open_session", {
      plaintextToken: cappedToken,
      title: "mcp-power-test capped session",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const cappedSession = (opened.value as { chatSessionId: string }).chatSessionId;

    const spend = await execute(registry, adapter, ownerCtx, "chat.record_ai_call", {
      chatSessionId: cappedSession,
      provider: "anthropic",
      model: "mcp-power-test",
      inputTokens: 1,
      outputTokens: 1,
      costEstimateMicrocents: 5_000,
    });
    expect(spend.ok).toBe(true);

    const blocked = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      plaintextToken: cappedToken,
      chatSessionId: cappedSession,
      toolName: "generate_image",
      args: { prompt: "a test image" },
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect("message" in blocked.error ? blocked.error.message : "").toContain("cost cap reached");

    // Non-AI tools keep working on the same capped token.
    const stillWorks = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      plaintextToken: cappedToken,
      chatSessionId: cappedSession,
      toolName: "list_pages",
      args: {},
    });
    expect(stillWorks.ok).toBe(true);
  });

  it("serves the composed context without the loop-specific blocks", async () => {
    const r = await execute(registry, adapter, systemCtx, "mcp.get_context", {
      plaintextToken: adminToken,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as {
      systemContext: string;
      statusLine: string | null;
      skills: Array<{ slug: string; body?: string }>;
    };
    expect(v.systemContext).toContain("## How Caelo fits together");
    expect(v.systemContext).toContain("## Module model");
    expect(v.systemContext).not.toContain("## Subagents");
    expect(v.systemContext).not.toContain("## Finishing a turn");
    // #413 — the playbook variant names the visual-inspection tools that DO
    // work here instead of the excluded chat-browser screenshot tool (#412
    // lifts that exclusion later; this may then relax to the chat wording).
    expect(v.systemContext).toContain("`inspect_built_page`");
    expect(v.systemContext).toContain("`screenshot_external_page`");
    for (const s of v.skills) expect(s.body).toBeUndefined();

    const withBodies = await execute(registry, adapter, systemCtx, "mcp.get_context", {
      plaintextToken: adminToken,
      includeSkillBodies: true,
    });
    expect(withBodies.ok).toBe(true);
    if (!withBodies.ok) return;
    for (const s of (withBodies.value as { skills: Array<{ body?: string }> }).skills) {
      expect(typeof s.body).toBe("string");
    }
  });

  // ── issue #413 — prompt↔catalog consistency ────────────────────────
  // The 2026-08-03 dogfood run probed for tools this surface refuses
  // because the served prose recommended them. These tests cover the
  // CLASS: every text the surface serves is scanned against the LIVE
  // exclusion map, so they keep passing when #412 removes
  // screenshot_page from POWER_MCP_EXCLUDED_TOOLS (its mentions simply
  // stop being violations) and keep biting for whatever stays excluded.

  it("serves no prose that recommends an excluded tool (#413)", async () => {
    const excluded = [...POWER_MCP_EXCLUDED_TOOLS.keys()];
    const r = await execute(registry, adapter, systemCtx, "mcp.get_context", {
      plaintextToken: adminToken,
      includeSkillBodies: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as {
      systemContext: string;
      statusLine: string | null;
      skills: Array<{ slug: string; description: string; body?: string }>;
    };
    const served: Array<readonly [string, string]> = [
      ["systemContext", v.systemContext],
      ["statusLine", v.statusLine ?? ""],
      ...powerToolCatalogue(createDefaultToolRegistry()).map(
        (t) => [`tool:${t.name}`, t.description] as const,
      ),
      ...v.skills.flatMap((s) => [
        [`skill:${s.slug}:description`, s.description] as const,
        [`skill:${s.slug}:body`, s.body ?? ""] as const,
      ]),
    ];
    const violations = served
      .map(([where, text]) => [where, findExcludedToolMentions(text, excluded)] as const)
      .filter(([, names]) => names.length > 0);
    expect(violations).toEqual([]);
  });

  it("annotates seeded skill bodies instead of dropping or rewriting skills (#413)", async () => {
    const excluded = [...POWER_MCP_EXCLUDED_TOOLS.keys()];
    // Raw bodies straight from the op the surface reads — the DB-seeded
    // skills mandate chat-only tools (design-quality: "call
    // screenshot_page for BOTH viewports"), which is exactly what the
    // serve-time annotation must neutralise without editing the rows.
    const raw = await execute(registry, adapter, ownerCtx, "skills.list", { status: "active" });
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;
    const rawSkills = (raw.value as { skills: Array<{ slug: string; body: string }> }).skills;

    const servedR = await execute(registry, adapter, systemCtx, "mcp.get_context", {
      plaintextToken: adminToken,
      includeSkillBodies: true,
    });
    expect(servedR.ok).toBe(true);
    if (!servedR.ok) return;
    const servedBySlug = new Map(
      (servedR.value as { skills: Array<{ slug: string; body?: string }> }).skills.map(
        (s) => [s.slug, s.body ?? ""] as const,
      ),
    );

    // Same skill set — the surface annotates; it never filters skills away.
    expect([...servedBySlug.keys()].sort()).toEqual(rawSkills.map((s) => s.slug).sort());

    for (const s of rawSkills) {
      const mentioned = findExcludedToolMentions(s.body, excluded);
      if (mentioned.length === 0) continue;
      const servedBody = servedBySlug.get(s.slug) ?? "";
      // Every mention still present (content honest, not censored) …
      for (const name of mentioned) expect(servedBody).toContain(name);
      // … but none left as a bare recommendation.
      expect(findExcludedToolMentions(servedBody, excluded)).toEqual([]);
      expect(servedBody).toContain("[not available on this surface — ");
    }
  });
});
