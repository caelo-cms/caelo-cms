// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { composeSystemPromptChunks } from "./system-prompt.js";

describe("composeSystemPromptChunks", () => {
  it("emits base + module-model + staging + memory as cacheable chunks in stable order", () => {
    const chunks = composeSystemPromptChunks([{ slot: "tone", body: "calm" }]);
    // v0.4.0 — the module-model chunk sits between base and memory and is
    // cacheable (stable across every call).
    // v0.5.5 — the staging chunk sits after module-model (also cacheable).
    // Token-efficiency: there is NO "tools" chunk — tool names + descriptions
    // ship only in the provider `tools[]` array, never duplicated as prose.
    expect(chunks.map((c) => c.label)).toEqual(["base", "module-model", "staging", "memory"]);
    for (const c of chunks) expect(c.cacheable).toBe(true);
  });

  it("never emits a prose tool-list chunk (descriptions live only in tools[])", () => {
    const chunks = composeSystemPromptChunks([]);
    expect(chunks.some((c) => c.label === "tools")).toBe(false);
    expect(chunks.some((c) => c.body.includes("# Available tools"))).toBe(false);
  });

  it("appends chips as a non-cacheable trailing chunk", () => {
    const chunks = composeSystemPromptChunks([], { chipsBlock: "chip A" });
    expect(chunks.at(-1)?.label).toBe("chips");
    expect(chunks.at(-1)?.cacheable).toBe(false);
  });

  it("orders chips after the cacheable prefix so cache stays warm across turns", () => {
    const a = composeSystemPromptChunks([{ slot: "tone", body: "x" }], { chipsBlock: "1" });
    const b = composeSystemPromptChunks([{ slot: "tone", body: "x" }], { chipsBlock: "2" });
    // The cacheable prefix is byte-identical between calls; only the trailing
    // chips chunk differs.
    expect(a.slice(0, -1)).toEqual(b.slice(0, -1));
    expect(a.at(-1)?.body).not.toBe(b.at(-1)?.body);
  });

  it("skips empty slots", () => {
    const chunks = composeSystemPromptChunks([]);
    // v0.4.0 — base + module-model are always present.
    // v0.5.5 — staging joins them as a third permanent cacheable chunk.
    expect(chunks.map((c) => c.label)).toEqual(["base", "module-model", "staging"]);
  });

  // v0.5.9 — wording-lock: production silent-fail traced to STAGING_BLOCK
  // tipping the AI into passive ("I've drafted...") responses. The shape
  // leads with an action instruction + an anti-pattern callout.
  it("staging chunk leads with action and forbids describing-without-doing", () => {
    const chunks = composeSystemPromptChunks([]);
    const staging = chunks.find((c) => c.label === "staging");
    expect(staging).toBeDefined();
    const body = staging?.body ?? "";
    expect(body).toContain("make them via your tools first");
    expect(body).toContain("Anti-pattern");
    expect(body).toContain("describing what you would do without calling tools");
    // Pre-v0.5.9 example response — must NOT come back.
    expect(body).not.toContain("I've drafted the change");
  });
});
