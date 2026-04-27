// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { composeSystemPromptChunks } from "./system-prompt.js";

describe("composeSystemPromptChunks", () => {
  it("emits base + memory + tools as cacheable chunks in stable order", () => {
    const chunks = composeSystemPromptChunks(
      [{ slot: "tone", body: "calm" }],
      [{ name: "edit_module", description: "edit a module" }],
    );
    expect(chunks.map((c) => c.label)).toEqual(["base", "memory", "tools"]);
    for (const c of chunks) expect(c.cacheable).toBe(true);
  });

  it("appends chips as a non-cacheable trailing chunk", () => {
    const chunks = composeSystemPromptChunks([], [], { chipsBlock: "chip A" });
    expect(chunks.at(-1)?.label).toBe("chips");
    expect(chunks.at(-1)?.cacheable).toBe(false);
  });

  it("orders chips after the cacheable prefix so cache stays warm across turns", () => {
    const a = composeSystemPromptChunks([{ slot: "tone", body: "x" }], [], { chipsBlock: "1" });
    const b = composeSystemPromptChunks([{ slot: "tone", body: "x" }], [], { chipsBlock: "2" });
    // The first 3 chunks (base/memory/skills-empty) are byte-identical
    // between calls; only the trailing chips chunk differs.
    expect(a.slice(0, -1)).toEqual(b.slice(0, -1));
    expect(a.at(-1)?.body).not.toBe(b.at(-1)?.body);
  });

  it("skips empty slots", () => {
    const chunks = composeSystemPromptChunks([], []);
    expect(chunks.map((c) => c.label)).toEqual(["base"]);
  });
});
