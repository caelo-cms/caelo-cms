// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 alpha.4 Fix W — unit tests for tryAutoRecover.
 *
 * These tests use a fake ToolRegistry with synthetic tools so the
 * full retry flow can be exercised without a DB. Covers:
 *   - happy path: recovery + retry succeed → AI sees clean success
 *   - non-read-only recovery tool name → skip (no side effects)
 *   - recovery tool not in catalogue → return original failure
 *   - recovery succeeds but no retryWithArgs → fold into content
 *   - retryWithArgs path doesn't resolve → fold into content
 *   - rewritten args fail schema → "retry skipped" marker
 *   - retry dispatch fails → both attempts surfaced to AI
 *   - extractAtPath edge cases (empty, missing, array idx out of range)
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";

import type { ExecutionContext } from "@caelo-cms/shared";
import { extractAtPath, tryAutoRecover } from "../auto-recovery.js";
import {
  ToolRegistry,
  type ToolContext,
  type ToolDefinitionWithHandler,
  type ToolResult,
} from "../tools/dispatch.js";

const aiCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000aaaa",
  actorKind: "ai",
  requestId: "auto-recovery-unit-test",
};
const toolCtx = {} as unknown as ToolContext;

function fakeListLayoutsTool(returnedLayouts: { id: string; slug: string }[]): ToolDefinitionWithHandler<{}> {
  return {
    name: "list_layouts",
    description: "fake list_layouts",
    schema: z.object({}).strict(),
    inputSchema: { type: "object" },
    handler: async () => ({
      ok: true,
      content: `${returnedLayouts.length} layouts`,
      value: { layouts: returnedLayouts },
    }),
  };
}

function fakeTemplatesCreateTool(
  behavior: "success" | "fail-without-layoutId",
): ToolDefinitionWithHandler<{ slug: string; displayName: string; layoutId?: string }> {
  return {
    name: "templates.create",
    description: "fake templates.create",
    schema: z
      .object({
        slug: z.string().min(1),
        displayName: z.string().min(1),
        layoutId: z.string().uuid().optional(),
      })
      .strict(),
    inputSchema: { type: "object" },
    handler: async (_ctx, input) => {
      if (behavior === "fail-without-layoutId" && !input.layoutId) {
        return {
          ok: false,
          content: "templates.create failed: no layoutId",
        };
      }
      return {
        ok: true,
        content: `template created: slug=${input.slug} layoutId=${input.layoutId}`,
      };
    },
  };
}

describe("extractAtPath", () => {
  it("resolves shallow object paths", () => {
    expect(extractAtPath({ a: 1 }, "a")).toBe(1);
  });

  it("resolves nested + array index paths", () => {
    expect(
      extractAtPath({ layouts: [{ id: "first" }, { id: "second" }] }, "layouts.0.id"),
    ).toBe("first");
    expect(
      extractAtPath({ layouts: [{ id: "first" }, { id: "second" }] }, "layouts.1.id"),
    ).toBe("second");
  });

  it("returns undefined when any segment misses", () => {
    expect(extractAtPath({ a: 1 }, "b")).toBeUndefined();
    expect(extractAtPath({ a: { b: 1 } }, "a.c")).toBeUndefined();
  });

  it("returns undefined on out-of-range array index", () => {
    expect(extractAtPath({ xs: [1, 2] }, "xs.5")).toBeUndefined();
    expect(extractAtPath({ xs: [1, 2] }, "xs.-1")).toBeUndefined();
  });

  it("returns undefined on null / primitive mid-path", () => {
    expect(extractAtPath(null, "a")).toBeUndefined();
    expect(extractAtPath({ a: 42 }, "a.b")).toBeUndefined();
    expect(extractAtPath({ a: "hello" }, "a.length")).toBeUndefined();
  });

  it("treats empty path segments correctly", () => {
    // Path "." → no segments → returns the value as-is.
    expect(extractAtPath({ a: 1 }, "")).toEqual({ a: 1 });
  });
});

describe("tryAutoRecover", () => {
  it("happy path: recovery returns value, retry succeeds with rewritten args → clean success", async () => {
    const tools = new ToolRegistry();
    tools.register(
      fakeListLayoutsTool([
        { id: "11111111-1111-4111-8111-aaaaaaaaaaaa", slug: "site-default" },
      ]),
    );
    tools.register(fakeTemplatesCreateTool("fail-without-layoutId"));

    const failed: ToolResult = {
      ok: false,
      content: "templates.create failed: no layoutId",
      nextAction: {
        tool: "list_layouts",
        reason: "fetch a layoutId",
        autoExecute: true,
        retryWithArgs: { argName: "layoutId", fromValuePath: "layouts.0.id" },
      },
    };
    const result = await tryAutoRecover({
      failed,
      originalCall: { name: "templates.create", arguments: { slug: "x", displayName: "X" } },
      tools,
      aiCtx,
      toolCtx,
      chatSessionId: "11111111-1111-4111-8111-666666666666",
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("template created");
    expect(result.content).toContain("layoutId=11111111-1111-4111-8111-aaaaaaaaaaaa");
    expect(result.content).toContain("[auto-recovered:");
  });

  it("returns the original failure unchanged when nextAction.autoExecute is false", async () => {
    const tools = new ToolRegistry();
    tools.register(fakeListLayoutsTool([]));
    const failed: ToolResult = {
      ok: false,
      content: "original failure",
      nextAction: {
        tool: "list_layouts",
        reason: "x",
        autoExecute: false,
      },
    };
    const result = await tryAutoRecover({
      failed,
      originalCall: { name: "templates.create", arguments: {} },
      tools,
      aiCtx,
      toolCtx,
      chatSessionId: "x",
    });
    expect(result).toBe(failed);
  });

  it("returns the original failure when recovery tool name is NOT read-only by convention", async () => {
    const tools = new ToolRegistry();
    // Register a write-shaped tool to ensure even if it's catalogued
    // we still refuse to call it from the auto-recovery path.
    const writeTool: ToolDefinitionWithHandler<{}> = {
      name: "delete_everything",
      description: "definitely not read-only",
      schema: z.object({}),
      inputSchema: { type: "object" },
      handler: async () => ({ ok: true, content: "deleted" }),
    };
    tools.register(writeTool);
    const failed: ToolResult = {
      ok: false,
      content: "failed",
      nextAction: {
        tool: "delete_everything",
        reason: "wrong choice",
        autoExecute: true,
      },
    };
    const result = await tryAutoRecover({
      failed,
      originalCall: { name: "templates.create", arguments: {} },
      tools,
      aiCtx,
      toolCtx,
      chatSessionId: "x",
    });
    expect(result).toBe(failed);
  });

  it("recovery succeeds but no retryWithArgs → folds recovery into content", async () => {
    const tools = new ToolRegistry();
    tools.register(fakeListLayoutsTool([{ id: "id-1", slug: "default" }]));
    const failed: ToolResult = {
      ok: false,
      content: "original failure",
      nextAction: {
        tool: "list_layouts",
        reason: "look at this",
        autoExecute: true,
        // No retryWithArgs.
      },
    };
    const result = await tryAutoRecover({
      failed,
      originalCall: { name: "templates.create", arguments: {} },
      tools,
      aiCtx,
      toolCtx,
      chatSessionId: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("original failure");
    expect(result.content).toContain("[auto-recovery] list_layouts (ok)");
    expect(result.content).toContain("1 layouts");
  });

  it("retryWithArgs path doesn't resolve → folds into content", async () => {
    const tools = new ToolRegistry();
    tools.register(fakeListLayoutsTool([])); // empty list — layouts.0.id fails
    tools.register(fakeTemplatesCreateTool("fail-without-layoutId"));
    const failed: ToolResult = {
      ok: false,
      content: "original failure",
      nextAction: {
        tool: "list_layouts",
        reason: "x",
        autoExecute: true,
        retryWithArgs: { argName: "layoutId", fromValuePath: "layouts.0.id" },
      },
    };
    const result = await tryAutoRecover({
      failed,
      originalCall: { name: "templates.create", arguments: {} },
      tools,
      aiCtx,
      toolCtx,
      chatSessionId: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[auto-recovery] list_layouts");
  });

  it("rewritten args fail schema → '[retry skipped]' marker", async () => {
    const tools = new ToolRegistry();
    tools.register(fakeListLayoutsTool([{ id: "not-a-uuid", slug: "x" }]));
    tools.register(fakeTemplatesCreateTool("fail-without-layoutId"));
    const failed: ToolResult = {
      ok: false,
      content: "original failure",
      nextAction: {
        tool: "list_layouts",
        reason: "x",
        autoExecute: true,
        // layoutId is z.string().uuid() on the fake — "not-a-uuid" fails.
        retryWithArgs: { argName: "layoutId", fromValuePath: "layouts.0.id" },
      },
    };
    const result = await tryAutoRecover({
      failed,
      originalCall: { name: "templates.create", arguments: { slug: "x", displayName: "X" } },
      tools,
      aiCtx,
      toolCtx,
      chatSessionId: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("[retry skipped");
  });

  it("retry dispatch fails → both attempts surfaced to AI", async () => {
    const tools = new ToolRegistry();
    tools.register(
      fakeListLayoutsTool([{ id: "11111111-1111-4111-8111-aaaaaaaaaaaa", slug: "x" }]),
    );
    // Force the retry to fail by giving the create tool a handler that
    // always returns ok=false even when layoutId is set.
    const alwaysFailingCreate: ToolDefinitionWithHandler<{
      slug: string;
      displayName: string;
      layoutId?: string;
    }> = {
      name: "templates.create",
      description: "always-failing fake",
      schema: z
        .object({
          slug: z.string().min(1),
          displayName: z.string().min(1),
          layoutId: z.string().uuid().optional(),
        })
        .strict(),
      inputSchema: { type: "object" },
      handler: async () => ({ ok: false, content: "still failed even with layoutId" }),
    };
    tools.register(alwaysFailingCreate);
    const failed: ToolResult = {
      ok: false,
      content: "original failure",
      nextAction: {
        tool: "list_layouts",
        reason: "x",
        autoExecute: true,
        retryWithArgs: { argName: "layoutId", fromValuePath: "layouts.0.id" },
      },
    };
    const result = await tryAutoRecover({
      failed,
      originalCall: { name: "templates.create", arguments: { slug: "x", displayName: "X" } },
      tools,
      aiCtx,
      toolCtx,
      chatSessionId: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("original failure");
    expect(result.content).toContain("[auto-recovery] list_layouts");
    expect(result.content).toContain("[retry] templates.create");
    expect(result.content).toContain("still failed even with layoutId");
  });
});
