// SPDX-License-Identifier: MPL-2.0

/**
 * issue #193 — propose_site_import carries the scope estimate into
 * the proposal row AND into the chat-visible tool result, so the AI
 * restates numbers before pointing at the Approve button. Runs
 * against the real Postgres registry (no mocked DB, CLAUDE.md §6);
 * only the estimator (network) is injected.
 *
 * issue #298 — the tool now PRICES the scope itself (calls×context
 * model at the chat provider/model's ai_pricing rates): with a provider
 * in the tool context and a seeded rates row the stored estimate carries
 * the model band; without either it lands loudly UNPRICED.
 */

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { AIProvider } from "../ai/provider.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";
import {
  describeEstimate,
  proposeSiteImportTool,
  setSiteImportEstimatorForTests,
} from "../ai/tools/propose-site-import.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue193-estimate-test",
};

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterEach(() => setSiteImportEstimatorForTests(null));

describe("describeEstimate", () => {
  it("renders the sitemap basis with the cost band", () => {
    const s = describeEstimate({
      pages: 340,
      basis: "sitemap",
      truncated: false,
      crawlMinutes: 4,
      aiCostUsd: { low: 6.8, high: 34 },
    });
    expect(s).toContain("sitemap lists 340 URLs");
    expect(s).toContain("4 min");
    expect(s).toContain("$6.8–$34");
  });

  it("renders the modelled call count next to the band when present (#298)", () => {
    const s = describeEstimate({
      pages: 14,
      basis: "list",
      truncated: false,
      crawlMinutes: 1,
      aiCostUsd: { low: 22, high: 108 },
      estimatedCalls: 107,
      estimatedInputTokens: 35_403_500,
    });
    expect(s).toContain("$22–$108");
    expect(s).toContain("≈107 AI calls");
  });

  it("renders an unpriced band loudly, pointing at the rates page (#298)", () => {
    const s = describeEstimate({
      pages: 14,
      basis: "list",
      truncated: false,
      crawlMinutes: 1,
      aiCostUsd: null,
      costNote: "no ai_pricing row for anthropic/claude-test — set rates at /security/ai/pricing",
    });
    expect(s).toContain("UNPRICED");
    expect(s).toContain("/security/ai/pricing");
  });

  it("renders a failed estimate as an explicit unknown", () => {
    const s = describeEstimate({ failed: true, reason: "no sitemap.xml and homepage 500" });
    expect(s).toContain("FAILED");
    expect(s).toContain("unknown size");
  });
});

describe("propose_site_import (#193/#298)", () => {
  it("prices the scope at the chat provider's ai_pricing rates and persists band + call model", async () => {
    setSiteImportEstimatorForTests(async () => ({
      pages: 800,
      basis: "sitemap",
      truncated: false,
      crawlMinutes: 8,
      aiCostUsd: null,
      costNote: "not yet priced — the propose tool prices scope at the current ai_pricing rates",
    }));
    // Migration 0048 seeds an anthropic/claude-opus-4-7 text rates row —
    // the priced path in CI without touching live pricing.
    const provider = {
      name: "anthropic",
      model: "claude-opus-4-7",
      generate: () => {
        throw new Error("not used by propose_site_import");
      },
    } as unknown as AIProvider;
    const toolCtx = { registry, adapter, provider } as ToolContext;
    const r = await proposeSiteImportTool.handler(
      AI,
      { sourceUrl: "https://issue193.example/", depth: 2, maxPages: 900 },
      toolCtx,
    );
    expect(r.ok).toBe(true);
    // The chat-visible sentence carries the numbers the operator needs.
    expect(r.content).toContain("sitemap lists 800 URLs");
    expect(r.content).toContain("AI rebuild ≈ $");
    expect(r.content).toContain("/security/import/pending");

    const runId = /Queued proposal ([0-9a-f-]{36})/.exec(r.content)?.[1];
    if (!runId) throw new Error(`no runId in: ${r.content}`);
    const got = await execute(registry, adapter, AI, "imports.get", { runId });
    expect(got.ok).toBe(true);
    const run = (got.value as { run: { estimate: unknown } | null }).run;
    const est = run?.estimate as {
      pages: number;
      basis: string;
      aiCostUsd: { low: number; high: number } | null;
      estimatedCalls?: number;
      estimatedInputTokens?: number;
    };
    expect(est.pages).toBe(800);
    expect(est.basis).toBe("sitemap");
    // issue #298 — the calls×context model: 800 pages × 7 calls + 9 overhead.
    expect(est.estimatedCalls).toBe(800 * 7 + 9);
    expect(est.aiCostUsd).not.toBeNull();
    expect(est.aiCostUsd!.low).toBeGreaterThan(0);
    expect(est.aiCostUsd!.high).toBeGreaterThanOrEqual(est.aiCostUsd!.low);
    expect(est.estimatedInputTokens).toBeGreaterThan(0);
  });

  it("lands the proposal UNPRICED (loudly) when no provider is attached", async () => {
    setSiteImportEstimatorForTests(async () => ({
      pages: 12,
      basis: "sitemap",
      truncated: false,
      crawlMinutes: 1,
      aiCostUsd: null,
      costNote: "not yet priced — the propose tool prices scope at the current ai_pricing rates",
    }));
    // No `provider` — tool dispatch outside a chat-runner (tests, CLI).
    const toolCtx = { registry, adapter } as ToolContext;
    const r = await proposeSiteImportTool.handler(
      AI,
      { sourceUrl: "https://issue298-unpriced.example/", depth: 2, maxPages: 50 },
      toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("sitemap lists 12 URLs");
    expect(r.content).toContain("UNPRICED");

    const runId = /Queued proposal ([0-9a-f-]{36})/.exec(r.content)?.[1];
    if (!runId) throw new Error(`no runId in: ${r.content}`);
    const got = await execute(registry, adapter, AI, "imports.get", { runId });
    expect(got.ok).toBe(true);
    const run = (got.value as { run: { estimate: unknown } | null }).run;
    const est = run?.estimate as { aiCostUsd: unknown; costNote?: string };
    expect(est.aiCostUsd).toBeNull();
    expect(est.costNote).toContain("no AI provider");
  });

  it("a failed estimate still lands the proposal, loudly", async () => {
    setSiteImportEstimatorForTests(async () => ({
      failed: true,
      reason: "no sitemap.xml and the homepage answered an error",
    }));
    const toolCtx = { registry, adapter } as ToolContext;
    const r = await proposeSiteImportTool.handler(
      AI,
      { sourceUrl: "https://issue193-dark.example/", depth: 2, maxPages: 50 },
      toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("FAILED");
    expect(r.content).toContain("unknown size");
  });
});
