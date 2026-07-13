// SPDX-License-Identifier: MPL-2.0

/**
 * Run #8 R2a — regression guard for the return-shape enum drift class
 * (issue #251 flavour): the spawn tools' hand-written provider
 * `inputSchema` enum must accept EVERY shape the shared Zod parser
 * knows, and the shared parser must accept every shape the provider
 * schema advertises.
 *
 * In run #8 the orchestrator's `spawn_subagent` call with
 * `expectedReturnShape: "rebuild"` was rejected with
 * `Invalid option: expected one of "verdict"|"tree"|"freeform"` — the
 * provider schema (resolved from admin-core SOURCE) advertised
 * "rebuild" while the Zod validator (resolved from a STALE
 * `@caelo-cms/shared` dist build) did not know it. This test imports
 * through the `@caelo-cms/shared` package specifier on purpose: under
 * `bun test` that exercises the same resolution path the runtime uses,
 * so a future src/dist split would fail here instead of in a live run.
 */

import { describe, expect, it } from "bun:test";
import {
  EXPECTED_RETURN_SHAPES,
  parseSubagentResult,
  spawnSubagentsToolInput,
  spawnSubagentToolInput,
} from "@caelo-cms/shared";

import { spawnSubagentsTool, spawnSubagentTool } from "../tools/spawn-subagent.js";

/** Pull the expectedReturnShape enum out of a tool's JSON inputSchema. */
function enumAt(schema: Record<string, unknown>, path: string[]): unknown {
  let node: unknown = schema;
  for (const key of path) {
    node = (node as Record<string, unknown> | undefined)?.[key];
  }
  return node;
}

/** A minimal valid sample per shape, for the shared parser round-trip. */
const SAMPLE_BY_SHAPE: Record<string, string> = {
  verdict: JSON.stringify({ pass: true, issues: [], suggestions: [] }),
  tree: JSON.stringify({ tree: [{ slug: "home" }], rationale: "r" }),
  freeform: "just some prose",
  rebuild: JSON.stringify({
    pages: [{ slug: "pricing", status: "rebuilt", notes: "kept the FAQ" }],
    contentNotes: [],
    skipped: [],
    summary: "1 page rebuilt",
  }),
};

describe("spawn_subagent return shapes stay in lockstep (run #8 R2a)", () => {
  it("spawn_subagent provider schema enum === shared Zod enum", () => {
    const providerEnum = enumAt(spawnSubagentTool.inputSchema, [
      "properties",
      "expectedReturnShape",
      "enum",
    ]);
    expect(providerEnum).toEqual([...EXPECTED_RETURN_SHAPES]);
  });

  it("spawn_subagents provider schema enum === shared Zod enum", () => {
    const providerEnum = enumAt(spawnSubagentsTool.inputSchema, [
      "properties",
      "subagents",
      "items",
      "properties",
      "expectedReturnShape",
      "enum",
    ]);
    expect(providerEnum).toEqual([...EXPECTED_RETURN_SHAPES]);
  });

  it("the Zod input schemas accept every shape the shared parser knows", () => {
    for (const shape of EXPECTED_RETURN_SHAPES) {
      const single = spawnSubagentToolInput.safeParse({
        role: "rebuild:cluster-1",
        task: "REBUILD TASK — rebuild the pricing cluster",
        expectedReturnShape: shape,
      });
      expect(single.success).toBe(true);

      const plural = spawnSubagentsToolInput.safeParse({
        subagents: [
          {
            role: "rebuild:cluster-1",
            task: "REBUILD TASK — rebuild the pricing cluster",
            expectedReturnShape: shape,
          },
        ],
      });
      expect(plural.success).toBe(true);
    }
  });

  it("parseSubagentResult can parse a sample result for every advertised shape", () => {
    for (const shape of EXPECTED_RETURN_SHAPES) {
      const sample = SAMPLE_BY_SHAPE[shape];
      // A shape without a sample means this test wasn't extended with the
      // enum — fail loudly rather than silently skipping.
      expect(sample).toBeDefined();
      const parsed = parseSubagentResult(sample as string, shape);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.shape).toBe(shape);
    }
  });
});
