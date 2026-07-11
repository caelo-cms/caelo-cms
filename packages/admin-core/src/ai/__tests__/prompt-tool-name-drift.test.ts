// SPDX-License-Identifier: MPL-2.0

/**
 * issue #159 — prompt ↔ tool-registry drift guard.
 *
 * The `## Modules` block shipped for two releases telling the AI to call
 * `create_module` / `list_modules` — neither was registered. The model
 * either burned a round-trip on "unknown tool" or silently substituted a
 * different plan than instructed (CLAUDE.md §4: when the AI misbehaves,
 * the bug is in OUR prompts/schemas). This test makes that class of bug
 * impossible to reintroduce mechanically:
 *
 * Every backticked snake_case token in the prompt-authoring sources must
 * be either a registered tool name or an explicitly allowlisted
 * non-tool term. Adding new prompt copy that names a tool-looking token
 * forces a conscious decision: register the tool, or extend the
 * allowlist below with a comment saying what the term is.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultToolRegistry } from "../tools/index.js";

const AI_DIR = join(import.meta.dir, "..");

/** Sources that author system-prompt copy the AI reads every turn. */
const PROMPT_SOURCES: string[] = [
  join(AI_DIR, "system-prompt.ts"),
  join(AI_DIR, "theme-guidance.ts"),
  ...readdirSync(join(AI_DIR, "chat-runner/context"))
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .map((f) => join(AI_DIR, "chat-runner/context", f)),
];

/**
 * Backticked snake_case terms that are NOT tool names. Every entry says
 * what it actually is — an unexplained entry is a review smell.
 */
const NON_TOOL_TERMS = new Set<string>([
  "content_instances", // table / primitive name (v0.12 content model)
  "site_ai_memory", // table name (Owner-curated memory slots)
  "engaged_skills", // chat_sessions column carrying per-chat skill state
  "hero_title", // example semantic field name in authoring guidance
  "primary_cta_href", // example semantic field name
  "nav_items", // example semantic field name
]);

function backtickedSnakeCaseTokens(src: string): Set<string> {
  // Block comments (JSDoc) never reach the AI — they legitimately name
  // removed tools ("`update_theme` was removed") and would false-positive.
  // Only string literals become prompt copy, so scan with comments gone.
  const withoutBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Set<string>();
  for (const m of withoutBlockComments.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
    const token = m[1] ?? "";
    // Only underscore-bearing tokens look like tool names; plain words
    // (`tokens`, `description`) are ordinary prose/argument mentions.
    if (token.includes("_")) out.add(token);
  }
  return out;
}

describe("prompt ↔ registry drift (issue #159)", () => {
  const registered = new Set(
    createDefaultToolRegistry()
      .catalogue()
      .map((t) => t.name),
  );

  it("every tool-looking token in prompt sources is a registered tool or an explained non-tool", () => {
    const offenders: string[] = [];
    for (const file of PROMPT_SOURCES) {
      for (const token of backtickedSnakeCaseTokens(readFileSync(file, "utf8"))) {
        if (!registered.has(token) && !NON_TOOL_TERMS.has(token)) {
          offenders.push(`${token} (in ${file.slice(file.indexOf("packages/"))})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the regression tokens stay resolved: list_modules registered, create_module gone from prompts", () => {
    expect(registered.has("list_modules")).toBe(true);
    for (const file of PROMPT_SOURCES) {
      expect(readFileSync(file, "utf8")).not.toContain("`create_module`");
    }
  });
});
