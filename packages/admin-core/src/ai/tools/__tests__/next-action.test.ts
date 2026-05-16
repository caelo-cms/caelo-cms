// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 W3 — `nextAction` plumbing tests.
 *
 *  1. `forwardNextAction(error)` extracts the structured hint from a
 *     HandlerError-shaped object and rejects malformed payloads.
 *  2. `describeError` renders the hint inline after the primary
 *     message so the AI sees both pieces in one tool-result string.
 *  3. `pgDetail` + `nextAction` coexist — describeError surfaces the
 *     PG-specific reason as primary then appends the next-action
 *     pointer.
 *
 * The chat-runner auto-recovery dispatch is covered by an integration
 * test (requires the registry + an in-memory recovery tool); these are
 * pure-data tests.
 */

import { describe, expect, it } from "bun:test";

import { describeError, forwardNextAction } from "../_describe-error.js";

describe("forwardNextAction", () => {
  it("extracts a well-formed nextAction off a HandlerError", () => {
    const out = forwardNextAction({
      kind: "HandlerError",
      operation: "templates.create",
      message: "no defaults",
      nextAction: {
        tool: "list_layouts",
        reason: "fetch the available layouts",
        autoExecute: true,
      },
    });
    expect(out).toEqual({
      tool: "list_layouts",
      reason: "fetch the available layouts",
      autoExecute: true,
    });
  });

  it("includes optional args when present", () => {
    const out = forwardNextAction({
      kind: "HandlerError",
      operation: "pages.create",
      message: "no defaults",
      nextAction: {
        tool: "list_templates",
        reason: "fetch templates",
        args: { includeDeleted: false },
      },
    });
    expect(out?.args).toEqual({ includeDeleted: false });
  });

  it("returns undefined when nextAction is malformed", () => {
    expect(
      forwardNextAction({
        kind: "HandlerError",
        operation: "x",
        message: "y",
        nextAction: { tool: 42, reason: "nope" } as unknown,
      }),
    ).toBeUndefined();
    expect(
      forwardNextAction({
        kind: "HandlerError",
        operation: "x",
        message: "y",
        nextAction: { tool: "list_x" } as unknown,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the error isn't a HandlerError", () => {
    expect(
      forwardNextAction({
        kind: "ValidationFailed",
        issues: [],
        nextAction: { tool: "x", reason: "y" },
      }),
    ).toBeUndefined();
    expect(forwardNextAction(null)).toBeUndefined();
    expect(forwardNextAction("string error")).toBeUndefined();
  });
});

describe("describeError with nextAction", () => {
  it("appends the recovery hint after the primary message", () => {
    const s = describeError({
      kind: "HandlerError",
      operation: "templates.create",
      message: "no layoutId provided and site_defaults is empty",
      nextAction: {
        tool: "list_layouts",
        reason: "fetch available layouts so layoutId can be passed explicitly",
        autoExecute: true,
      },
    });
    expect(s).toContain("no layoutId provided");
    expect(s).toContain("| next: call `list_layouts`");
    expect(s).toContain("fetch available layouts");
  });

  it("includes args in the rendered hint when supplied", () => {
    const s = describeError({
      kind: "HandlerError",
      operation: "x",
      message: "y",
      nextAction: {
        tool: "list_templates",
        reason: "fetch templates",
        args: { includeDeleted: false },
      },
    });
    expect(s).toContain('with args {"includeDeleted":false}');
  });

  it("renders pgDetail as primary then appends the nextAction pointer", () => {
    const s = describeError({
      kind: "HandlerError",
      operation: "modules.create",
      message: "Failed query: ...",
      pgDetail: { code: "23505", constraint: "modules_slug_key", detail: "Key (slug)=(x) exists" },
      nextAction: {
        tool: "list_modules",
        reason: "the slug is taken — pick another",
      },
    });
    expect(s).toContain("SQLSTATE 23505");
    expect(s).toContain("constraint=modules_slug_key");
    expect(s).toContain("| next: call `list_modules`");
  });

  it("does not append a hint when nextAction is absent (backward-compat)", () => {
    const s = describeError({
      kind: "HandlerError",
      operation: "x",
      message: "just a normal failure",
    });
    expect(s).toBe("just a normal failure");
    expect(s).not.toContain("next:");
  });
});
