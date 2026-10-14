// SPDX-License-Identifier: MPL-2.0

/**
 * #741 — on an AI-delegated call (Power-MCP) minting a module never runs
 * moduleize on the install's AI: raw HTML without `fields[]` is refused
 * before anything is read or written, with what to send instead.
 */

import { describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
import { DELEGATED_MINT_NEEDS_FIELDS, mintModuleFromHtml } from "./_mint-module.js";
import type { ToolContext } from "./dispatch.js";

const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000002",
  actorKind: "ai",
  requestId: "mint-delegated-test",
};

/** Any database or provider access fails the test. */
const untouchable = new Proxy(
  {},
  {
    get: () => {
      throw new Error("must not be reached on a refused delegated mint");
    },
  },
);

describe("mintModuleFromHtml on an AI-delegated call", () => {
  it("refuses raw HTML without fields[] and says what to send", async () => {
    const r = await mintModuleFromHtml(
      ctx,
      {
        adapter: untouchable,
        registry: untouchable,
        provider: untouchable,
        aiDelegated: true,
      } as unknown as ToolContext,
      { html: "<section><h2>Raw heading</h2></section>", displayNameHint: "Raw" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.content).toBe(DELEGATED_MINT_NEEDS_FIELDS);
    expect(r.content).toContain("fields[]");
  });
});
