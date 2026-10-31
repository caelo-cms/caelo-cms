// SPDX-License-Identifier: MPL-2.0

/**
 * Regression (e2e-livedit 2026-10, two AI-filed reports titled
 * "placeholder"): load_skill said a skill's tools were "now available to
 * you" although most of them were deferred behind tool search for the
 * running turn. The model then called bootstrap_site_scaffold, which it
 * could not emit, and a `bug_report` with title/whatHappened/expected all
 * "placeholder" came out instead. The note now names which tools still need
 * a tool-search load.
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
import { loadSkillTool, skillToolsNote } from "../load-skill.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "ai",
  requestId: "load-skill-tools-note-test",
};

function harness(preloaded?: ReadonlySet<string>): ToolContext {
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
            allowlistedTools: ["bootstrap_site_scaffold", "build_page"],
            status: "active",
          },
        }) as never,
    }),
  );
  const adapter = {
    runOperation: (op: OperationDefinition, ctx: ExecutionContext, input: unknown) =>
      op.handler(ctx, input, {} as never),
  } as unknown as DatabaseAdapter;
  return { adapter, registry, ...(preloaded ? { preloadedToolNames: preloaded } : {}) };
}

describe("load_skill tools note", () => {
  it("never claims a deferred tool is available in the running turn", async () => {
    const r = await loadSkillTool.handler(
      AI,
      { slugs: ["bootstrap-site"] },
      harness(new Set(["build_page", "bug_report"])),
    );
    expect(r.ok).toBe(true);
    expect(r.content).not.toContain("now available");
    expect(r.content).toContain("Already in your tool list: build_page.");
    expect(r.content).toContain("Possibly NOT loaded yet: bootstrap_site_scaffold");
    expect(r.content).toContain("load it with the tool-search tool");
  });

  it("only lists the tools where every tool is listed with its schema (Power-MCP)", () => {
    expect(skillToolsNote(["a", "b"], undefined)).toBe("\n\nTools this skill uses: a, b.");
  });

  it("says nothing about loading when every tool is preloaded", () => {
    const note = skillToolsNote(["a"], new Set(["a"]));
    expect(note).toContain("Already in your tool list: a.");
    expect(note).not.toContain("tool-search");
  });

  it("is empty for a skill without tools", () => {
    expect(skillToolsNote([], new Set())).toBe("");
  });
});
