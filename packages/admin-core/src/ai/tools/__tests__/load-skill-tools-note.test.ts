// SPDX-License-Identifier: MPL-2.0

/**
 * Regression (e2e-livedit 2026-10, two AI-filed reports titled
 * "placeholder"; #991): load_skill said a skill's tools were "now available
 * to you" although most of them were deferred behind tool search for the
 * running turn. The model then called bootstrap_site_scaffold, which it
 * could not emit, and a `bug_report` with title/whatHappened/expected all
 * "placeholder" came out instead. The result now LOADS the skill's deferred
 * tools (`toolReferences` → `tool_reference` blocks) and its note says so,
 * so no search step is left to skip.
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
import { loadSkillTool, skillToolsLoad } from "../load-skill.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "ai",
  requestId: "load-skill-tools-note-test",
};

function harness(turnTools?: ToolContext["turnTools"]): ToolContext {
  const registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "skills.get",
      readScope: "request",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.any(),
      output: z.any(),
      handler: async () =>
        ok({
          skill: {
            slug: "bootstrap-site",
            displayName: "Bootstrap a fresh install",
            body: "PREFERRED PATH: call bootstrap_site_scaffold once.",
            allowlistedTools: ["bootstrap_site_scaffold", "build_page", "create_layout"],
            status: "active",
          },
        }) as never,
    }),
  );
  const adapter = {
    runOperation: (op: OperationDefinition, ctx: ExecutionContext, input: unknown) =>
      op.handler(ctx, input, {} as never),
  } as unknown as DatabaseAdapter;
  return { adapter, registry, ...(turnTools ? { turnTools } : {}) };
}

describe("load_skill tools", () => {
  const turnTools = {
    names: new Set(["build_page", "bug_report", "bootstrap_site_scaffold"]),
    deferred: new Set(["bootstrap_site_scaffold"]),
  };

  it("loads the skill's deferred tools into the conversation and says they are callable", async () => {
    const r = await loadSkillTool.handler(AI, { slugs: ["bootstrap-site"] }, harness(turnTools));
    expect(r.ok).toBe(true);
    expect(r.toolReferences).toEqual(["bootstrap_site_scaffold"]);
    expect(r.content).not.toContain("now available");
    expect(r.content).toContain(
      "Loaded with this skill, callable from your next step: bootstrap_site_scaffold.",
    );
    expect(r.content).not.toContain("tool-search");
  });

  it("names the tools this chat does not have instead of letting the model substitute", async () => {
    const r = await loadSkillTool.handler(AI, { slugs: ["bootstrap-site"] }, harness(turnTools));
    expect(r.content).toContain("Not available in this chat: create_layout");
    expect(r.content).toContain("never call a different tool in their place");
  });

  it("loads each tool once, however many loaded skills use it", async () => {
    const r = await loadSkillTool.handler(
      AI,
      { slugs: ["bootstrap-site", "bootstrap-site-again"] },
      harness(turnTools),
    );
    expect(r.toolReferences).toEqual(["bootstrap_site_scaffold"]);
  });

  it("only lists the tools where every tool is listed with its schema (Power-MCP)", () => {
    expect(skillToolsLoad(["a", "b"], undefined)).toEqual({
      note: "\n\nTools this skill uses: a, b.",
      references: [],
    });
  });

  it("loads nothing when the provider defers nothing", () => {
    const load = skillToolsLoad(["a"], { names: new Set(["a"]), deferred: new Set() });
    expect(load.references).toEqual([]);
    expect(load.note).toBe("\n\nTools this skill uses: a.");
  });

  it("is empty for a skill without tools", () => {
    expect(skillToolsLoad([], { names: new Set(), deferred: new Set() })).toEqual({
      note: "",
      references: [],
    });
  });
});
