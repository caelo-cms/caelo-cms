// SPDX-License-Identifier: MPL-2.0

/**
 * issue #193 — propose_site_import carries the scope estimate into
 * the proposal row AND into the chat-visible tool result, so the AI
 * restates numbers before pointing at the Approve button. Runs
 * against the real Postgres registry (no mocked DB, CLAUDE.md §6);
 * only the estimator (network) is injected.
 */

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { registerAdminOps } from "../../register.js";
import type { ToolContext } from "../tools/dispatch.js";
import {
  describeEstimate,
  proposeSiteImportTool,
  setSiteImportEstimatorForTests,
} from "../tools/propose-site-import.js";

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

  it("renders a failed estimate as an explicit unknown", () => {
    const s = describeEstimate({ failed: true, reason: "no sitemap.xml and homepage 500" });
    expect(s).toContain("FAILED");
    expect(s).toContain("unknown size");
  });
});

describe("propose_site_import (#193)", () => {
  it("persists the estimate on the proposal and restates it in the tool result", async () => {
    setSiteImportEstimatorForTests(async () => ({
      pages: 800,
      basis: "sitemap",
      truncated: false,
      crawlMinutes: 8,
      aiCostUsd: { low: 16, high: 80 },
    }));
    const toolCtx = { registry, adapter } as ToolContext;
    const r = await proposeSiteImportTool.handler(
      AI,
      { sourceUrl: "https://issue193.example/", depth: 2, maxPages: 900 },
      toolCtx,
    );
    expect(r.ok).toBe(true);
    // The chat-visible sentence carries the numbers the operator needs.
    expect(r.content).toContain("sitemap lists 800 URLs");
    expect(r.content).toContain("$16–$80");
    expect(r.content).toContain("/security/import/pending");

    const runId = /Queued proposal ([0-9a-f-]{36})/.exec(r.content)?.[1];
    if (!runId) throw new Error(`no runId in: ${r.content}`);
    const got = await execute(registry, adapter, AI, "imports.get", { runId });
    expect(got.ok).toBe(true);
    const run = (got.value as { run: { estimate: unknown } | null }).run;
    expect(run?.estimate).toEqual({
      pages: 800,
      basis: "sitemap",
      truncated: false,
      crawlMinutes: 8,
      aiCostUsd: { low: 16, high: 80 },
    });
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
