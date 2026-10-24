// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1062 — a field value copied into three or more private instances
 * of one module gets a shared-content hint on the write that made the
 * third copy; two copies, short labels, shared instances and nested refs
 * stay silent.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../register.js";
import { withFieldMarkupGuard } from "../tools/_markup-guard.js";
import { repeatedValueHints, type ValueInstance } from "../tools/_repeated-value-guard.js";
import type { ToolContext, ToolDefinitionWithHandler } from "../tools/dispatch.js";

const MOD = "00000000-0000-4000-8000-000000001062";
const OTHER = "00000000-0000-4000-8000-000000002062";
const LEAD = "Book a 30 minute demo with our team.";

const inst = (
  id: string,
  values: Record<string, unknown>,
  moduleId = MOD,
  placementCount = 1,
): ValueInstance => ({ id, moduleId, moduleDisplayName: "Demo form", placementCount, values });

describe("repeatedValueHints", () => {
  it("names the module and fields once three private copies hold the same value", () => {
    const hints = repeatedValueHints(
      [{ lead: LEAD, steps: ["Pick a slot", "Tell us more"] }],
      [
        inst("a", { lead: LEAD, steps: ["Pick a slot", "Tell us more"], topic: "x" }),
        inst("b", { lead: LEAD, steps: ["Pick a slot", "Tell us more"], topic: "y" }),
        inst("c", { lead: LEAD, steps: ["Pick a slot", "Tell us more"], topic: "z" }),
      ],
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("`lead`, `steps`");
    expect(hints[0]).toContain(MOD);
    expect(hints[0]).toContain("3 separate private copies");
  });

  it("stays silent for two copies, short labels, shared instances, other modules and nested refs", () => {
    const ref = [{ moduleId: OTHER, contentInstanceId: "00000000-0000-4000-8000-000000000001" }];
    expect(
      repeatedValueHints([{ lead: LEAD }], [inst("a", { lead: LEAD }), inst("b", { lead: LEAD })]),
    ).toEqual([]);
    expect(
      repeatedValueHints(
        [{ label: "Learn more" }],
        ["a", "b", "c"].map((id) => inst(id, { label: "Learn more" })),
      ),
    ).toEqual([]);
    expect(
      repeatedValueHints(
        [{ lead: LEAD }],
        [inst("a", { lead: LEAD }), inst("b", { lead: LEAD }), inst("s", { lead: LEAD }, MOD, 5)],
      ),
    ).toEqual([]);
    expect(
      repeatedValueHints(
        [{ lead: LEAD }],
        [inst("a", { lead: LEAD }), inst("b", { lead: LEAD }), inst("o", { lead: LEAD }, OTHER)],
      ),
    ).toEqual([]);
    expect(
      repeatedValueHints(
        [{ items: ref }],
        ["a", "b", "c"].map((id) => inst(id, { items: ref })),
      ),
    ).toEqual([]);
  });
});

describe("withFieldMarkupGuard — shared-content hint", () => {
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  const AI: ExecutionContext = {
    actorId: "00000000-0000-0000-0000-000000000a1a",
    actorKind: "ai",
    requestId: "issue-1062-unit",
  };
  const reads: { name: string; input: unknown }[] = [];
  const toolCtx = {
    registry,
    adapter: {
      runOperation: async (op: { name: string }, _ctx: unknown, input: unknown) => {
        reads.push({ name: op.name, input });
        if (op.name === "content_instances.list_module_peers") {
          return ok({ instances: ["a", "b", "c"].map((id) => inst(id, { lead: LEAD })) });
        }
        return ok({ modules: [], instances: [] });
      },
    } as unknown as DatabaseAdapter,
  } as ToolContext;
  const tool: ToolDefinitionWithHandler<{ moduleId: string; values: Record<string, unknown> }> = {
    name: "fake_write",
    description: "",
    schema: undefined as never,
    handler: async () => ({ ok: true, content: "written." }),
  };
  const guarded = withFieldMarkupGuard(
    tool,
    (i) => [i.values],
    (i) => ({ moduleIds: [i.moduleId] }),
  );

  it("reads only the written module's instances and appends the hint", async () => {
    reads.length = 0;
    const r = await guarded.handler(AI, { moduleId: MOD, values: { lead: LEAD } }, toolCtx);
    expect(r.content).toStartWith("written. 🎯 shared-content: `lead` of module");
    // Module-scoped: one peers read for MOD, never the whole library.
    expect(reads.map((x) => x.name)).toEqual(["content_instances.list_module_peers"]);
    expect(reads[0]?.input).toEqual({ moduleIds: [MOD], contentInstanceIds: [], placements: [] });
  });

  it("reads nothing when no written value qualifies", async () => {
    reads.length = 0;
    const r = await guarded.handler(AI, { moduleId: MOD, values: { label: "Go" } }, toolCtx);
    expect(r.content).toBe("written.");
    expect(reads).toEqual([]);
  });
});
