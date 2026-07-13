// SPDX-License-Identifier: MPL-2.0

/**
 * Run #10 D2 — unit tests for the `submit_result` structured-result
 * channel: handler validation against the shared return shapes, the
 * subagent-only guard, and the catalogue gating that keeps the tool
 * invisible outside child sessions. No DB needed.
 */

import { describe, expect, it } from "bun:test";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, ExpectedReturnShape } from "@caelo-cms/shared";

import { resolveExcludedToolNames } from "../../chat-runner/tool-catalogue.js";
import type { ToolContext } from "../dispatch.js";
import { submitResultTool } from "../submit-result.js";

const ctx: ExecutionContext = {
  actorId: "11111111-1111-4111-8111-aaaaaaaaaaaa",
  actorKind: "ai",
  requestId: "submit-result-test",
};

function captureCtx(expectedShape: ExpectedReturnShape): {
  toolCtx: ToolContext;
  submitted: () => unknown[];
} {
  const values: unknown[] = [];
  const toolCtx = {
    adapter: {} as DatabaseAdapter,
    registry: {} as OperationRegistry,
    subagentResultCapture: {
      expectedShape,
      submit: (v: unknown) => values.push(v),
    },
  } as ToolContext;
  return { toolCtx, submitted: () => values };
}

describe("submit_result handler (run #10 D2)", () => {
  it("delivers a valid rebuild payload to the capture sink", async () => {
    const { toolCtx, submitted } = captureCtx("rebuild");
    const r = await submitResultTool.handler(
      ctx,
      { result: { pages: [{ slug: "pricing", status: "rebuilt" }], summary: "done" } },
      toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(submitted()).toHaveLength(1);
    expect(submitted()[0]).toMatchObject({
      pages: [{ slug: "pricing", status: "rebuilt" }],
      summary: "done",
    });
  });

  it("rejects a shape mismatch with an actionable error and does NOT submit", async () => {
    const { toolCtx, submitted } = captureCtx("verdict");
    const r = await submitResultTool.handler(
      ctx,
      // rebuild-shaped payload against a verdict contract.
      { result: { pages: [], summary: "wrong shape" } },
      toolCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("verdict shape mismatch");
    expect(r.content).toContain("call submit_result again");
    expect(submitted()).toHaveLength(0);
  });

  it("wraps a bare string as {text} under the freeform shape", async () => {
    const { toolCtx, submitted } = captureCtx("freeform");
    const r = await submitResultTool.handler(ctx, { result: "all pages look good" }, toolCtx);
    expect(r.ok).toBe(true);
    expect(submitted()[0]).toEqual({ text: "all pages look good" });
  });

  it("rejects a missing result key with the expected call shape", async () => {
    const { toolCtx, submitted } = captureCtx("freeform");
    const r = await submitResultTool.handler(ctx, {}, toolCtx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain('"result"');
    expect(submitted()).toHaveLength(0);
  });

  it("refuses outside a subagent session (no capture on ToolContext)", async () => {
    const r = await submitResultTool.handler(ctx, { result: { text: "hello" } }, {
      adapter: {} as DatabaseAdapter,
      registry: {} as OperationRegistry,
    } as ToolContext);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("only available inside a spawned subagent session");
  });
});

describe("resolveExcludedToolNames — submit_result catalogue gating", () => {
  it("adds submit_result to the exclusions for normal chats", () => {
    const excluded = resolveExcludedToolNames(undefined, false);
    expect(excluded?.has("submit_result")).toBe(true);
  });

  it("preserves caller exclusions while adding submit_result", () => {
    const excluded = resolveExcludedToolNames(new Set(["spawn_subagent"]), false);
    expect(excluded?.has("spawn_subagent")).toBe(true);
    expect(excluded?.has("submit_result")).toBe(true);
  });

  it("keeps submit_result visible for subagent child turns", () => {
    const excluded = resolveExcludedToolNames(new Set(["spawn_subagent", "spawn_subagents"]), true);
    expect(excluded?.has("submit_result")).toBe(false);
    expect(excluded?.has("spawn_subagent")).toBe(true);
  });
});
