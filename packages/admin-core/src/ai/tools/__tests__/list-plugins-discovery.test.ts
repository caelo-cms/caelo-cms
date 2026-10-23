// SPDX-License-Identifier: MPL-2.0

/**
 * #1008 — list_plugins names the plugins found on disk that could not be
 * verified. They have no `plugins` row (they are not installed), so the
 * table cannot show them; the tool appends them with the fix, so the AI
 * can explain why a plugin the operator expects is missing. Stub op, same
 * harness shape as domain-hosting-status.test.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  type DatabaseAdapter,
  defineOperation,
  type OperationDefinition,
  OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { z } from "zod";
import type { ToolContext } from "../dispatch.js";
import { describeDiscoveryFailures, listPluginsTool } from "../list-plugins.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "ai",
  requestId: "list-plugins-discovery-test",
};

function harness(value: unknown): ToolContext {
  const registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "plugins.list",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.any(),
      output: z.any(),
      handler: async () => ok(value) as never,
    }),
  );
  const adapter = {
    runOperation: (op: OperationDefinition, ctx: ExecutionContext, input: unknown) =>
      op.handler(ctx, input, {} as never),
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

const FAILURE = {
  slug: "forms",
  phase: "verify",
  errorClass: "core",
  message: "manifest signature does not verify",
  occurrences: 3,
  firstSeenAt: "2026-10-23T08:00:00.000Z",
  lastSeenAt: "2026-10-23T09:00:00.000Z",
  report: "sent",
};

describe("list_plugins — plugins found but not verified", () => {
  it("describeDiscoveryFailures says nothing when there are none", () => {
    expect(describeDiscoveryFailures([])).toBeNull();
  });

  it("names each failure, that it is not installed, and the fix", () => {
    const text = describeDiscoveryFailures([FAILURE]) ?? "";
    expect(text).toContain("NOT installed (1)");
    expect(text).toContain("- forms: verify, core, 3x, last 2026-10-23T09:00:00.000Z");
    expect(text).toContain("manifest signature does not verify");
    expect(text).toContain("signed again");
  });

  it("appends them to the tool result, also when no plugin is installed", async () => {
    const r = await listPluginsTool.handler(
      AI,
      {} as never,
      harness({ plugins: [], discoveryFailures: [FAILURE] }),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("No plugins installed on this site.");
    expect(r.content).toContain("- forms: verify");
  });

  it("adds nothing when every plugin found verified", async () => {
    const r = await listPluginsTool.handler(
      AI,
      {} as never,
      harness({ plugins: [], discoveryFailures: [] }),
    );
    expect(r.content).toBe("No plugins installed on this site.");
  });
});
