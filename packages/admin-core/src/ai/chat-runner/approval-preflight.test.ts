// SPDX-License-Identifier: MPL-2.0

/**
 * The click is the scarce resource the §11.A gate exists to obtain. On
 * 2026-07-28 an operator spent three of them on one theme: each proposal was
 * shown, approved, and only then rejected by `themes.propose_create`. Two of
 * the three clicks bought nothing.
 *
 * Preflight decides which proposals are worth asking about. The failure modes
 * cut both ways, so both are pinned: letting a doomed payload through wastes a
 * click, and rejecting a valid one blocks work the operator wanted.
 */

import { describe, expect, it } from "bun:test";
import { defineOperation, OperationRegistry } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";

import { ToolRegistry } from "../tools/dispatch.js";
import { preflightGatedCall } from "./approval-preflight.js";

const themeInput = z
  .object({
    slug: z.string().min(1),
    tokens: z.object({ motion: z.record(z.string(), z.string().regex(/^\d+ms$/)) }),
  })
  .strict();

function fixture(): { tools: ToolRegistry; registry: OperationRegistry } {
  const registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "themes.propose_create",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: themeInput,
      output: z.looseObject({}),
      handler: async () => ok({}),
    }),
  );
  const tools = new ToolRegistry();
  tools.register({
    name: "propose_create_theme",
    description: "gated",
    schema: z.looseObject({}),
    inputSchema: { type: "object" },
    gated: { proposeOp: "themes.propose_create", executeOp: "themes.execute_proposal" },
    handler: async () => ({ ok: true, content: "-" }),
  } as never);
  tools.register({
    name: "edit_module",
    description: "routine",
    schema: z.looseObject({}),
    inputSchema: { type: "object" },
    handler: async () => ({ ok: true, content: "-" }),
  } as never);
  return { tools, registry };
}

describe("preflightGatedCall", () => {
  it("lets a payload the propose op accepts through to the operator", () => {
    const { tools, registry } = fixture();
    const bad = preflightGatedCall(tools, registry, "propose_create_theme", {
      slug: "searchviu",
      tokens: { motion: { fast: "180ms" } },
    });
    expect(bad).toBeNull();
  });

  it("rejects the payload that cost three clicks, before any card is shown", () => {
    const { tools, registry } = fixture();
    const bad = preflightGatedCall(tools, registry, "propose_create_theme", {
      slug: "searchviu",
      // The CSS transition shorthand — two design tokens in one string.
      tokens: { motion: { motion: "180ms ease" } },
    });
    expect(bad).not.toBeNull();
    expect(bad?.toolName).toBe("propose_create_theme");
    // The model must be able to act on this without asking the operator.
    expect(bad?.reason).toContain("themes.propose_create");
    expect(bad?.reason).toContain("tokens.motion.motion");
    expect(bad?.reason).toContain("no approval was requested");
  });

  it("names the failing path so the model fixes the right field", () => {
    const { tools, registry } = fixture();
    const bad = preflightGatedCall(tools, registry, "propose_create_theme", {
      tokens: { motion: { fast: "180ms" } },
    });
    expect(bad?.reason).toContain("`slug`");
  });

  it("ignores a routine (non-gated) tool", () => {
    const { tools, registry } = fixture();
    expect(preflightGatedCall(tools, registry, "edit_module", { anything: 1 })).toBeNull();
  });

  it("stays out of the way when the op cannot be resolved", () => {
    // A preflight that guessed would block legitimate proposals; the
    // post-approval path still validates, so silence is the safe answer.
    const { tools } = fixture();
    expect(
      preflightGatedCall(tools, new OperationRegistry(), "propose_create_theme", {}),
    ).toBeNull();
  });

  it("ignores an unknown tool name", () => {
    const { tools, registry } = fixture();
    expect(preflightGatedCall(tools, registry, "does_not_exist", {})).toBeNull();
  });
});
