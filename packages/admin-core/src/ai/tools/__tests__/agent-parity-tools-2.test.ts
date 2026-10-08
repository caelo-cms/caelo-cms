// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for the agent-tool parity part-2 tools (operator dashboards,
 * history, content maintenance): Zod schema at the tool boundary + handler
 * logic (op inputs, result copy, what stays out of the transcript) against
 * STUB ops. Behaviour against Postgres is pinned in
 * `src/__tests__/agent-parity-tools-2.integration.test.ts`.
 *
 * The stub adapter runs the registered stub handler directly — `execute`
 * still does the real lookup, actorScope check and input validation.
 */

import { describe, expect, it } from "bun:test";
import {
  type DatabaseAdapter,
  defineOperation,
  type OperationDefinition,
  OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, err } from "@caelo-cms/shared";
import { z } from "zod";

import {
  getPageSeoTool,
  listImportRunsTool,
  listMediaUsagesTool,
  listSkillPinDefaultsTool,
  listStaleSeoPagesTool,
  logImportEventsTool,
  refreshPagePathTool,
  setSkillPinDefaultsTool,
} from "../content-maintenance-tools.js";
import { type ToolContext, ToolRegistry, type ToolResult } from "../dispatch.js";
import {
  getModuleImpactTool,
  getSnapshotTool,
  listSnapshotsTool,
  listUnpublishedChangesTool,
} from "../history-tools.js";
import { createDefaultToolRegistry } from "../index.js";
import {
  getAiSpendTool,
  getEmailConfigTool,
  getGatewayAnalyticsTool,
  getMediaSettingsTool,
  getPluginTool,
  listBugReportsTool,
  listGatewayRequestsTool,
  listRateLimitProfilesTool,
} from "../operator-dashboard-tools.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "ai",
  requestId: "agent-parity-tools-2-test",
};

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

type Call = { op: string; input: unknown; ctx: ExecutionContext };

/** A registry of stub ops + a stub adapter that runs their handlers directly. */
function harness(
  stubs: Record<string, (input: never, ctx: ExecutionContext) => unknown>,
  extra: Partial<ToolContext> = {},
) {
  const calls: Call[] = [];
  const registry = new OperationRegistry();
  for (const [name, fn] of Object.entries(stubs)) {
    registry.register(
      defineOperation({
        name,
        actorScope: ["human", "ai", "system"],
        database: "cms_admin",
        input: z.any(),
        output: z.any(),
        handler: async (ctx, input) => {
          calls.push({ op: name, input, ctx });
          const r = fn(input as never, ctx);
          return (r && typeof r === "object" && "ok" in r ? r : { ok: true, value: r }) as never;
        },
      }),
    );
  }
  const adapter = {
    runOperation: (op: OperationDefinition, ctx: ExecutionContext, input: unknown) =>
      op.handler(ctx, input, {} as never),
  } as unknown as DatabaseAdapter;
  const toolCtx: ToolContext = { adapter, registry, ...extra };
  return { calls, toolCtx };
}

async function run(
  tool: Parameters<ToolRegistry["register"]>[0],
  args: unknown,
  toolCtx: ToolContext,
): Promise<ToolResult> {
  const reg = new ToolRegistry();
  reg.register(tool);
  return reg.dispatch(tool.name, args, AI, toolCtx);
}

const NEW_TOOLS = [
  "get_ai_spend",
  "get_plugin",
  "get_gateway_analytics",
  "list_gateway_requests",
  "list_rate_limit_profiles",
  "get_email_config",
  "list_bug_reports",
  "get_media_settings",
  "list_snapshots",
  "get_snapshot",
  "get_module_impact",
  "list_unpublished_changes",
  "list_media_usages",
  "get_page_seo",
  "list_stale_seo_pages",
  "refresh_page_path",
  "list_import_runs",
  "log_import_events",
  "list_skill_pin_defaults",
  "set_skill_pin_defaults",
];

describe("registration", () => {
  it("every part-2 tool is in the default registry with a strict JSON Schema", () => {
    const tools = createDefaultToolRegistry();
    const byName = new Map(tools.list().map((t) => [t.name, t]));
    for (const name of NEW_TOOLS) {
      const t = byName.get(name);
      expect(t, name).toBeDefined();
      const schema = t?.inputSchema as { additionalProperties?: unknown } | undefined;
      expect(schema?.additionalProperties).toBe(false);
    }
  });
});

describe("get_ai_spend", () => {
  const AGG = {
    totals: { calls: 4, inputTokens: 100, outputTokens: 50, cachedTokens: 10, costUsd: 1.5 },
    perDay: [{ day: "2026-10-01", calls: 4, inputTokens: 100, outputTokens: 50, costUsd: 1.5 }],
    perProvider: [
      { provider: "anthropic", model: "m", operationType: "text", calls: 4, costUsd: 1.5 },
    ],
    perOperationType: [{ operationType: "text", calls: 4, costUsd: 1.5 }],
    perPlugin: [],
    perAttribution: [{ kind: "user", label: "o@x.test", calls: 4, costUsd: 1.5 }],
  };

  it("passes the window as `since` and renders spend + AI activity", async () => {
    const h = harness({
      "ai_calls.aggregate": () => AGG,
      "audit_events.aggregate_by_op_prefix": () => ({
        windowSinceIso: "x",
        rows: [{ opPrefix: "pages", opCount: 9, successRate: 1, failureCount: 0 }],
      }),
    });
    const before = Date.now();
    const r = await run(getAiSpendTool, { sinceDays: 7 }, h.toolCtx);
    expect(r.ok).toBe(true);
    const since = Date.parse((h.calls[0]?.input as { since: string } | undefined)?.since ?? "");
    expect(Math.round((before - since) / 86_400_000)).toBe(7);
    expect(r.content).toContain("$1.50 over 4 calls");
    expect(r.content).toContain("model anthropic/m");
    expect(r.content).toContain("pages 9/0");
  });

  it("rejects an out-of-range window before any op runs", async () => {
    const h = harness({ "ai_calls.aggregate": () => AGG });
    expect((await run(getAiSpendTool, { sinceDays: 0 }, h.toolCtx)).ok).toBe(false);
    expect((await run(getAiSpendTool, { since: "x" }, h.toolCtx)).ok).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it("still reports spend when the activity breakdown fails", async () => {
    const h = harness({
      "ai_calls.aggregate": () => AGG,
      "audit_events.aggregate_by_op_prefix": () =>
        err({ kind: "HandlerError", operation: "audit", message: "boom" }),
    });
    const r = await run(getAiSpendTool, {}, h.toolCtx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("activity by domain unavailable");
  });
});

describe("get_plugin", () => {
  const PLUGIN = {
    id: U1,
    slug: "forms",
    version: "1.0.0",
    tier: 1,
    status: "active",
    manifestJson: {
      tools: [{ name: "list_form_submissions" }],
      skills: [{ name: "forms-skill" }],
      requestedCapabilities: ["email.send"],
    },
    sourceCode: "SECRET_SOURCE_MARKER",
    validationErrors: [],
    manifestSignature: "sig",
    rejectionReason: null,
  };

  it("renders detail + AI spend and never returns the source", async () => {
    const h = harness({
      "plugins.get": () => ({ plugin: PLUGIN }),
      "ai_calls.aggregate_per_plugin": () => ({
        pluginId: U1,
        capMicrocents: 100_000_000,
        last24hMicrocents: 100_000_000,
        last24hCalls: 3,
        capPct: 1,
        capExceeded: true,
      }),
    });
    const r = await run(getPluginTool, { slug: "forms" }, h.toolCtx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("list_form_submissions");
    expect(r.content).toContain("email.send");
    expect(r.content).toContain("CAP REACHED");
    expect(JSON.stringify(r)).not.toContain("SECRET_SOURCE_MARKER");
    expect(h.calls[1]?.input).toEqual({ pluginId: U1 });
  });

  it("names list_plugins when the slug is unknown", async () => {
    const h = harness({ "plugins.get": () => ({ plugin: null }) });
    const r = await run(getPluginTool, { slug: "nope" }, h.toolCtx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("list_plugins");
  });
});

describe("gateway reads", () => {
  it("get_gateway_analytics forwards the window and renders per-op rows", async () => {
    const h = harness({
      "gateway.list_analytics": () => ({
        windowSec: 600,
        overall: { requests: 5, p95Ms: 20, errorCount: 1, throttledCount: 2, honeypotCount: 0 },
        perOp: [
          {
            pluginSlug: "forms",
            operation: "submit",
            requests: 5,
            p95Ms: 20,
            errorCount: 1,
            throttledCount: 2,
          },
        ],
        timeBuckets: [],
      }),
    });
    const r = await run(getGatewayAnalyticsTool, { windowSec: 600 }, h.toolCtx);
    expect(h.calls[0]?.input).toEqual({ windowSec: 600 });
    expect(r.content).toContain("forms.submit: 5 req");
    expect((await run(getGatewayAnalyticsTool, { windowSec: 5 }, h.toolCtx)).ok).toBe(false);
  });

  it("list_gateway_requests maps filters and pages within the op's cap", async () => {
    const h = harness({ "gateway.list_recent_requests": () => ({ rows: [] }) });
    const r = await run(
      listGatewayRequestsTool,
      { pluginSlug: "forms", onlyErrors: true, limit: 20, offset: 10 },
      h.toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(h.calls[0]?.input).toEqual({ pluginSlug: "forms", onlyErrors: true, limit: 30 });
    expect(r.content).toContain("No gateway requests");
  });

  it("list_rate_limit_profiles renders TOON rows", async () => {
    const h = harness({
      "gateway.list_rate_limit_profiles": () => ({
        profiles: [
          {
            name: "strict",
            description: "forms",
            perVisitorMax: 5,
            windowSeconds: 60,
            usedBy: 2,
            updatedAt: "x",
          },
        ],
      }),
    });
    const r = await run(listRateLimitProfilesTool, {}, h.toolCtx);
    expect(r.content).toContain("strict,5/60s,2,forms");
  });
});

describe("email, bug reports, media settings", () => {
  it("get_email_config keeps the raw value out of the transcript", async () => {
    const h = harness({
      "email_config.get": () => ({
        config: {
          transport: "resend",
          fromAddress: "a@x.test",
          config: { apiKey: "[redacted]" },
          updatedAt: "x",
        },
      }),
    });
    const r = await run(getEmailConfigTool, {}, h.toolCtx);
    expect(r.content).toContain("transport: resend");
    expect(r.value).toBeUndefined();
    const none = harness({
      "email_config.get": () => ({
        config: { transport: "none", fromAddress: "", config: {}, updatedAt: "x" },
      }),
    });
    expect((await run(getEmailConfigTool, {}, none.toolCtx)).content).toContain("not set up");
  });

  it("list_bug_reports forwards the status filter", async () => {
    const h = harness({ "ai_bug_reports.list": () => ({ reports: [], total: 0 }) });
    await run(listBugReportsTool, { status: "new" }, h.toolCtx);
    expect(h.calls[0]?.input).toEqual({ status: "new", limit: 50 });
    expect((await run(listBugReportsTool, { status: "open" }, h.toolCtx)).ok).toBe(false);
  });

  it("get_media_settings renders the CDN toggle", async () => {
    const h = harness({
      "media.get_settings": () => ({ cdnCopyEnabled: true, cdnUsageThreshold: 5 }),
    });
    expect((await run(getMediaSettingsTool, {}, h.toolCtx)).content).toContain("enabled");
  });
});

describe("history tools", () => {
  it("list_snapshots forwards filters, not list params", async () => {
    const h = harness({ "snapshots.list": () => ({ snapshots: [] }) });
    await run(listSnapshotsTool, { forPageId: U1, limit: 10 }, h.toolCtx);
    expect(h.calls[0]?.input).toEqual({ forPageId: U1, includeArchived: false, limit: 10 });
    expect((await run(listSnapshotsTool, { forChatBranchId: U1 }, h.toolCtx)).ok).toBe(false);
  });

  it("get_snapshot labels entities, truncates state and omits the raw value", async () => {
    const big = "x".repeat(1000);
    const h = harness({
      "snapshots.get_with_entities": () => ({
        snapshot: {
          id: U1,
          actorId: U2,
          description: "edit hero",
          chatTaskId: null,
          revertOf: null,
          createdAt: "t",
        },
        modules: [{ entityId: U2, state: { slug: "hero", html: big } }],
        templates: [],
        pages: [],
        pageLayouts: [],
      }),
    });
    const r = await run(getSnapshotTool, { snapshotId: U1 }, h.toolCtx);
    expect(r.content).toContain(`module ${U2} (hero)`);
    expect(r.content.length).toBeLessThan(600);
    expect(r.value).toBeUndefined();
  });

  it("get_module_impact renders severity + placements", async () => {
    const h = harness({
      "snapshots.module_impact": () => ({
        moduleId: U1,
        affectedPages: [
          { pageId: U2, pageSlug: "home", templateId: U1, templateSlug: "t", blockName: "hero" },
        ],
        severity: "high",
        reasons: ["header"],
      }),
    });
    const r = await run(getModuleImpactTool, { moduleId: U1 }, h.toolCtx);
    expect(r.content).toContain("severity high");
    expect(r.content).toContain("home (template t, block hero)");
  });

  it("list_unpublished_changes uses the session from the tool context", async () => {
    const empty = { pages: [], globals: [], lists: [] };
    const h = harness(
      {
        "chat.list_pending_changes": () => ({
          pending: { ...empty, pages: [{ kind: "page", entityId: U2, label: "Home" }] },
          staged: empty,
        }),
      },
      { chatSessionId: U1 },
    );
    const r = await run(listUnpublishedChangesTool, {}, h.toolCtx);
    expect(h.calls[0]?.input).toEqual({ chatSessionId: U1 });
    expect(r.content).toContain("pending page page Home");
    const noSession = harness({ "chat.list_pending_changes": () => ({}) });
    const r2 = await run(listUnpublishedChangesTool, {}, noSession.toolCtx);
    expect(r2.ok).toBe(false);
    expect(r2.content).toContain("caelo_open_session");
    expect(noSession.calls).toHaveLength(0);
  });
});

describe("content maintenance tools", () => {
  it("list_media_usages and get_page_seo validate ids at the boundary", async () => {
    const h = harness({
      "media.list_usages": () => ({ modules: [{ id: U1, slug: "hero", displayName: "Hero" }] }),
      "pages_seo.get": () => ({ seo: null }),
    });
    expect((await run(listMediaUsagesTool, { assetId: "x" }, h.toolCtx)).ok).toBe(false);
    expect((await run(listMediaUsagesTool, { assetId: U1 }, h.toolCtx)).content).toContain(
      "hero (Hero)",
    );
    expect((await run(getPageSeoTool, { pageId: U1 }, h.toolCtx)).content).toContain(
      "autofill_page_seo",
    );
  });

  it("list_stale_seo_pages flags empty descriptions", async () => {
    const h = harness({
      "pages_seo.list_stale": () => ({
        pages: [
          {
            pageId: U1,
            slug: "about",
            title: "About",
            autofilledAt: null,
            optimizedAt: null,
            metaDescription: "",
          },
        ],
      }),
    });
    const r = await run(listStaleSeoPagesTool, {}, h.toolCtx);
    expect(h.calls[0]?.input).toEqual({ limit: 50 });
    expect(r.content).toContain("about,About,EMPTY");
  });

  it("refresh_page_path reports a move and an unchanged path", async () => {
    const moved = harness({
      "pages.refresh_current_path": () => ({ path: "/de/about", moved: true }),
    });
    const r = await run(refreshPagePathTool, { pageId: U1 }, moved.toolCtx);
    expect(moved.calls[0]?.input).toEqual({ pageId: U1 });
    expect(r.content).toContain("/de/about (the old URL 301s to it)");
    const same = harness({
      "pages.refresh_current_path": () => ({ path: "/about", moved: false }),
    });
    expect((await run(refreshPagePathTool, { pageId: U1 }, same.toolCtx)).content).toContain(
      "unchanged",
    );
  });

  it("list_import_runs forwards the status; log_import_events validates every event", async () => {
    const h = harness({
      "imports.list": () => ({ runs: [] }),
      "imports.log_events": (input: { events: unknown[] }) => ({ inserted: input.events.length }),
    });
    await run(listImportRunsTool, { status: "failed" }, h.toolCtx);
    expect(h.calls[0]?.input).toEqual({ status: "failed" });
    const bad = await run(
      logImportEventsTool,
      { events: [{ runId: U1, severity: "fatal", message: "x" }] },
      h.toolCtx,
    );
    expect(bad.ok).toBe(false);
    const good = await run(
      logImportEventsTool,
      {
        events: [
          { runId: U1, severity: "warning", phase: "media", message: "skipped", detail: { u: 1 } },
          { runId: U2, severity: "info", message: "ok" },
        ],
      },
      h.toolCtx,
    );
    expect(good.content).toContain("Logged 2 event(s)");
  });

  it("set_skill_pin_defaults resolves slugs to active skill ids and refuses unknown ones", async () => {
    const h = harness({
      "skills.list": () => ({
        skills: [
          { id: U1, slug: "scoped-edit" },
          { id: U2, slug: "seo-optimize" },
        ],
      }),
      "skills.set_pin_defaults": () => ({}),
      "skills.list_pin_defaults": () => ({
        pinDefaults: [{ skillId: U1, slug: "scoped-edit", displayName: "Scoped edit" }],
      }),
    });
    const unknown = await run(setSkillPinDefaultsTool, { slugs: ["nope"] }, h.toolCtx);
    expect(unknown.ok).toBe(false);
    expect(unknown.content).toContain("scoped-edit, seo-optimize");
    expect(h.calls.some((c) => c.op === "skills.set_pin_defaults")).toBe(false);
    const ok = await run(
      setSkillPinDefaultsTool,
      { slugs: ["scoped-edit", "scoped-edit"] },
      h.toolCtx,
    );
    expect(ok.ok).toBe(true);
    expect(h.calls.find((c) => c.op === "skills.set_pin_defaults")?.input).toEqual({
      skillIds: [U1],
    });
    expect((await run(listSkillPinDefaultsTool, {}, h.toolCtx)).content).toContain("scoped-edit");
  });
});
