// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { composeSystemPromptChunks } from "./system-prompt.js";

describe("composeSystemPromptChunks", () => {
  it("emits base + module-model + staging + memory + tools as cacheable chunks in stable order", () => {
    const chunks = composeSystemPromptChunks(
      [{ slot: "tone", body: "calm" }],
      [{ name: "edit_module", description: "edit a module" }],
    );
    // v0.4.0 — the module-model chunk sits between base and memory and is
    // cacheable (stable across every call).
    // v0.5.5 — the staging chunk sits after module-model (also cacheable);
    // it explains the pending → staged → published flow.
    expect(chunks.map((c) => c.label)).toEqual([
      "base",
      "module-model",
      "staging",
      "memory",
      "tools",
    ]);
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
    // v0.4.0 — base + module-model are always present.
    // v0.5.5 — staging joins them as a third permanent cacheable chunk.
    expect(chunks.map((c) => c.label)).toEqual(["base", "module-model", "staging"]);
  });

  // v0.5.9 — wording-lock: production silent-fail traced to STAGING_BLOCK
  // tipping the AI into passive ("I've drafted...") responses. The new
  // shape leads with "make them via the tools below first" and adds an
  // anti-pattern callout. This test fails if either is regressed.
  it("staging chunk leads with action and forbids describing-without-doing", () => {
    const chunks = composeSystemPromptChunks([], []);
    const staging = chunks.find((c) => c.label === "staging");
    expect(staging).toBeDefined();
    const body = staging?.body ?? "";
    expect(body).toContain("make them via the tools below first");
    expect(body).toContain("Anti-pattern");
    expect(body).toContain("describing what you would do without calling tools");
    // Pre-v0.5.9 example response — must NOT come back.
    expect(body).not.toContain("I've drafted the change");
  });
});
