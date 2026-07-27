// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { composeSystemPromptChunks } from "./system-prompt.js";

describe("composeSystemPromptChunks", () => {
  it("emits base + tool-playbook + module-model + staging + memory as cacheable chunks in stable order", () => {
    const chunks = composeSystemPromptChunks([{ slot: "tone", body: "calm" }]);
    // v0.4.0 — the module-model chunk sits between base and memory and is
    // cacheable (stable across every call).
    // v0.5.5 — the staging chunk sits after module-model (also cacheable);
    // it explains the pending → staged → published flow.
    // issue #106 (redesign) — `finishing-a-turn` follows staging: the PREVENT
    // layer stating that describing a change is not making it.
    // 0163 — NO `tools` chunk: the tool set is already sent as the provider
    // `tools` param, so a prose duplicate was ~23.5k wasted tokens per cold call.
    // Tool Search default-on — the tool-playbook chunk replaces the deferred
    // long tail's descriptions with an intent → tool-name map.
    expect(chunks.map((c) => c.label)).toEqual([
      "base",
      "tool-playbook",
      "module-model",
      "staging",
      "finishing-a-turn",
      "subagents",
      "memory",
    ]);
    for (const c of chunks) expect(c.cacheable).toBe(true);
  });

  // Tool Search default-on — the playbook is how the model knows which
  // DEFERRED tool to search for. Lock the workflow anchors + the
  // discovery instruction so a rewrite can't silently drop them.
  it("tool-playbook names the workflow tools and the tool-search discovery path", () => {
    const chunks = composeSystemPromptChunks([]);
    const playbook = chunks.find((c) => c.label === "tool-playbook");
    expect(playbook).toBeDefined();
    const body = playbook?.body ?? "";
    // One anchor per workflow: create / modify / extend / import.
    expect(body).toContain("`build_page`");
    expect(body).toContain("`set_page_module_content`");
    expect(body).toContain("`add_module`");
    expect(body).toContain("`propose_site_import`");
    // The discovery instruction: more tools exist + search loads them.
    expect(body).toContain("NOT the full catalogue");
    expect(body).toContain("tool-search tool");
  });

  it("is fully static — dynamic context never reaches the system prompt", () => {
    // The operator's rule: nothing dynamic in the system prompt (so the whole
    // prompt stays cached, never busted). Dynamic site state is fetched
    // on-demand via tools; the current page rides on the user message. So even
    // when every legacy volatile block is passed, NONE produce a chunk.
    const withState = composeSystemPromptChunks([], {
      chipsBlock: "chip A",
      themeBlock: "theme X",
      allPagesBlock: "pages",
      pageContextBlock: "current page",
      modulesBlock: "mods",
      layoutsBlock: "layouts",
      redirectsBlock: "redirects",
      usersBlock: "users",
    });
    const bare = composeSystemPromptChunks([]);
    expect(withState.map((c) => c.label)).toEqual(bare.map((c) => c.label));
    // Everything in the system prompt is cacheable — nothing volatile remains.
    expect(withState.every((c) => c.cacheable)).toBe(true);
  });

  it("includes the static skills index as a cacheable chunk", () => {
    const chunks = composeSystemPromptChunks([], { skillsIndexBlock: "# Skills\n- x: y" });
    const idx = chunks.find((c) => c.label === "skills-index");
    expect(idx?.cacheable).toBe(true);
    expect(idx?.body).toContain("# Skills");
  });

  // issue #106 — the block states THAT waiting on the operator ends a turn,
  // never HOW to ask. An earlier revision said "ASK it with `offer_choices`",
  // which pointed the model at a DEFERRED tool: it had the name but not the
  // schema, emitted `input: {}`, and could not repair. It also worked against
  // the deliberate decision (CORE_TOOL_NAMES) to keep that tool unobtrusive so
  // the model does not stall on questions it could answer itself.
  it("finishing-a-turn prescribes no tool", () => {
    const block = composeSystemPromptChunks([]).find((c) => c.label === "finishing-a-turn");
    expect(block).toBeDefined();
    const body = block?.body ?? "";
    expect(body).toContain("re-read your last paragraph");
    // A backtick here is always an identifier — i.e. a tool name.
    expect(body).not.toContain("`");
  });

  // The live footer scenario failed twice with the model stopping to ask which
  // brand colour to use, because the escape hatch read "a decision that is
  // genuinely theirs to make". Under CLAUDE.md §1A that is exactly backwards:
  // the operator describes outcomes, the AI decides implementation.
  it("finishing-a-turn rules a preference out as a reason to stop", () => {
    const block = composeSystemPromptChunks([]).find((c) => c.label === "finishing-a-turn");
    const body = block?.body ?? "";
    expect(body).toContain("PREFERENCE is not one of those");
    expect(body).toContain("decide how to build it");
    // The hatch names what only the operator can supply, rather than gesturing
    // at "their decision" — which a colour or a wording reads as.
    expect(body).toMatch(/credential/);
  });

  it("skips empty slots", () => {
    const chunks = composeSystemPromptChunks([]);
    // The static core: base + tool-playbook + module-model + staging +
    // finishing-a-turn + subagents. All permanent + cacheable — the system
    // prompt is fully static.
    expect(chunks.map((c) => c.label)).toEqual([
      "base",
      "tool-playbook",
      "module-model",
      "staging",
      "finishing-a-turn",
      "subagents",
    ]);
  });

  // v0.5.9 — wording-lock: production silent-fail traced to STAGING_BLOCK
  // tipping the AI into passive ("I've drafted...") responses. The new
  // shape leads with "make them via the tools below first" and adds an
  // anti-pattern callout. This test fails if either is regressed.
  it("staging chunk leads with action and forbids describing-without-doing", () => {
    const chunks = composeSystemPromptChunks([]);
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
