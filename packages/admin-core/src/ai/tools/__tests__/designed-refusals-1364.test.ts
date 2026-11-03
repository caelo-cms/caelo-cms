// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1364 — tool-level refusals that are the tool working as designed
 * (a budget, a configuration the operator owns) carry `refusal: true`, so
 * the chat's automatic bug capture does not file them (#1091). The
 * cold-start gate is pinned in `ai/__tests__/cold-start-gate.test.ts`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../../register.js";
import { shouldAutoCaptureToolFailure } from "../../chat-runner/tool-dispatch.js";
import { LIVE_INSPECT_BUDGET_ENV_VAR, takeExternalFetchBudget } from "../_external-fetch-budget.js";
import { deployStagingTool } from "../deploy-staging.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { inspectExternalPageTool } from "../inspect-external-page.js";
import { mapExternalPageTypesTool } from "../map-external-page-types.js";
import { queryPageHtmlTool } from "../query-page-html.js";
import { screenshotExternalPageTool } from "../screenshot-external-page.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "t1364-refusals",
};

function expectDesignedRefusal(tool: string, r: ToolResult): void {
  expect(r.ok).toBe(false);
  expect(r.refusal).toBe(true);
  expect(shouldAutoCaptureToolFailure(tool, r)).toBe(false);
}

afterEach(() => {
  delete process.env[LIVE_INSPECT_BUDGET_ENV_VAR];
});

describe("designed refusals are not auto-filed (#1364)", () => {
  it("an exhausted external-fetch budget, in every tool that draws on it", async () => {
    process.env[LIVE_INSPECT_BUDGET_ENV_VAR] = "1";
    const sessionId = `t1364-${crypto.randomUUID()}`;
    expect(takeExternalFetchBudget(sessionId).ok).toBe(true);
    const toolCtx = { chatSessionId: sessionId } as ToolContext;
    const url = "https://example.com/";

    expectDesignedRefusal(
      "inspect_external_page",
      await inspectExternalPageTool.handler(
        AI,
        inspectExternalPageTool.schema.parse({ url }),
        toolCtx,
      ),
    );
    expectDesignedRefusal(
      "map_external_page_types",
      await mapExternalPageTypesTool.handler(
        AI,
        mapExternalPageTypesTool.schema.parse({ url }),
        toolCtx,
      ),
    );
    expectDesignedRefusal(
      "screenshot_external_page",
      await screenshotExternalPageTool.handler(
        AI,
        screenshotExternalPageTool.schema.parse({ url }),
        toolCtx,
      ),
    );
    expectDesignedRefusal(
      "query_page_html",
      await queryPageHtmlTool.handler(
        AI,
        queryPageHtmlTool.schema.parse({ url, keyword: "x" }),
        toolCtx,
      ),
    );
  });

  it("deploy_staging on a site without a staging target", async () => {
    const registry = new OperationRegistry();
    registerAdminOps(registry);
    const adapter = {
      runOperation: async (op: { name: string }) =>
        op.name === "deploy.list_targets" ? ok({ targets: [] }) : ok({}),
    } as unknown as DatabaseAdapter;
    const r = await deployStagingTool.handler(AI, deployStagingTool.schema.parse({}), {
      adapter,
      registry,
    } as ToolContext);
    expectDesignedRefusal("deploy_staging", r);
  });
});
