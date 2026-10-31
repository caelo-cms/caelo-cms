// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1275 — the pure halves of `retry_tool_call`: which failed calls
 * are kept (`keptCallArgs`), the notice a kept failure ends with, and the
 * patch (`applyRetryPatch`).
 */

import { describe, expect, it } from "bun:test";
import { keptCallArgs, keptCallNotice } from "../_retry-keep.js";
import { applyRetryPatch } from "../_retry-patch.js";
import type { ToolResult } from "../dispatch.js";
import { createDefaultToolRegistry } from "../index.js";

const tools = createDefaultToolRegistry();
const ARGS = { page: { slug: "a", pageType: "nope" }, modules: [{ html: "<p>x</p>" }] };

function failure(overrides: Partial<ToolResult>): ToolResult {
  return {
    ok: false,
    content: "failed",
    call: { name: "build_page", args: ARGS },
    ...overrides,
  };
}

describe("keptCallArgs", () => {
  it("keeps fixable failures of write tools", () => {
    for (const failureKind of [
      "InvalidArguments",
      "ValidationFailed",
      "Conflict",
      "Locked",
      "SiblingLeaseConflict",
    ] as const) {
      expect(keptCallArgs(failure({ failureKind }), tools)).toEqual(ARGS);
    }
    const validation = failure({
      failureKind: "HandlerError",
      errors: [{ path: ["page", "pageType"], message: "no page type" }],
    });
    expect(keptCallArgs(validation, tools)).toEqual(ARGS);
  });

  it("does not keep permission, budget, internal or unclassified failures", () => {
    for (const failureKind of [
      "ActorScopeRejected",
      "RLSDenied",
      "internal",
      "UnknownTool",
    ] as const) {
      expect(keptCallArgs(failure({ failureKind }), tools)).toBeNull();
    }
    // A HandlerError that names no input (a permission or budget refusal).
    expect(keptCallArgs(failure({ failureKind: "HandlerError" }), tools)).toBeNull();
    expect(keptCallArgs(failure({}), tools)).toBeNull();
  });

  it("does not keep gated, read or meta tools, empty args, or a success", () => {
    const gated = tools.list().find((t) => t.gated || t.approvalMode);
    expect(gated).toBeDefined();
    const kind = { failureKind: "InvalidArguments" } as const;
    expect(
      keptCallArgs(failure({ ...kind, call: { name: gated?.name ?? "", args: ARGS } }), tools),
    ).toBeNull();
    expect(
      keptCallArgs(failure({ ...kind, call: { name: "list_pages", args: ARGS } }), tools),
    ).toBeNull();
    expect(
      keptCallArgs(failure({ ...kind, call: { name: "retry_tool_call", args: ARGS } }), tools),
    ).toBeNull();
    expect(
      keptCallArgs(failure({ ...kind, call: { name: "build_page", args: {} } }), tools),
    ).toBeNull();
    expect(keptCallArgs({ ...failure(kind), ok: true }, tools)).toBeNull();
    // A plugin tool result never carries `call` (it bypasses tools.dispatch).
    expect(
      keptCallArgs({ ok: false, content: "x", failureKind: "InvalidArguments" }, tools),
    ).toBeNull();
  });
});

describe("keptCallNotice", () => {
  it("names the id and the first error path, and still offers the resend", () => {
    const text = keptCallNotice(
      "call-1",
      failure({
        failureKind: "HandlerError",
        errors: [{ path: ["page", "pageType"], message: "x" }],
      }),
    );
    expect(text).toContain('retry_tool_call({toolCallId:"call-1", set:[{path:["page","pageType"]');
    expect(text).toEndWith("or resend.");
  });

  it("asks for a fresh read first on a version conflict", () => {
    expect(keptCallNotice("c", failure({ failureKind: "Conflict" }))).toStartWith(
      "Read the current version first",
    );
  });
});

describe("applyRetryPatch", () => {
  it("sets, removes and replaces at segment paths without touching the input", () => {
    const args = {
      page: { slug: "a" },
      modules: [{ html: "<h2>Hi</h2><p>x</p>" }, { html: "<p>y</p>" }],
    };
    const r = applyRetryPatch(args, {
      set: [
        { path: ["page", "pageType"], value: "news" },
        { path: ["modules", 2], value: { html: "<p>z</p>" } },
      ],
      remove: [["modules", 1]],
      replace: [{ path: ["modules", 0, "html"], old: "<h2>Hi</h2>", new: "<h3>Hi</h3>" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args).toEqual({
      page: { slug: "a", pageType: "news" },
      modules: [{ html: "<h3>Hi</h3><p>x</p>" }, { html: "<p>z</p>" }],
    });
    expect(args.page).toEqual({ slug: "a" });
  });

  it("reports every problem at its path inside the patch", () => {
    const r = applyRetryPatch(
      { modules: [{ html: "<p>a</p><p>a</p>" }] },
      {
        set: [{ path: ["modules", 5], value: 1 }],
        remove: [["page"]],
        replace: [
          { path: ["modules", 0, "html"], old: "<p>a</p>", new: "" },
          { path: ["modules", 0, "html"], old: "<b>", new: "" },
          { path: ["modules", 0], old: "x", new: "" },
        ],
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.path)).toEqual([
      ["set", 0, "path"],
      ["remove", 0],
      ["replace", 0, "path"],
      ["replace", 1, "path"],
      ["replace", 2, "path"],
    ]);
    expect(r.errors[2]?.message).toContain("more than once");
    expect(r.errors[3]?.message).toContain("does not occur");
    expect(r.errors[4]?.message).toContain("not a string");
  });

  it("never writes through the object prototype", () => {
    const r = applyRetryPatch({}, { set: [{ path: ["__proto__", "polluted"], value: true }] });
    expect(r.ok).toBe(false);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});
