// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.11 — wording-lock for propose-style tool output. Every tool
 * that queues a proposal must emit the canonical
 *
 *   "Queued proposal <uuid>: <summary>. ... /security/<domain>/pending ..."
 *
 * shape. ChatPanel's ToolCardRouter routes tools to the inline-Approve
 * ProposeCard via that shape; a non-canonical prefix (e.g. "Queued
 * layout-create proposal") makes the router fall through to plain
 * markdown — no inline Approve button. Pre-v0.5.11 production silently
 * regressed in exactly this way; this test locks it.
 *
 * Detection is source-based: read each propose-tool's TS file and
 * grep the content templates. Runtime assertion would require mocking
 * every underlying `*.propose_*` op handler; we don't get useful
 * additional coverage from that.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TOOLS_DIR = new URL(".", import.meta.url).pathname;

// Tools whose handlers call a propose op (queue + Owner-approve) that
// routes through ProposeCard's inline Approve/Reject UI. Each must
// emit "Queued proposal <uuid>: <summary>. …/security/<domain>/pending …"
//
// Excluded from this lock (different flows):
// - propose-skill.ts — routes to /security/skills/proposals (different
//   queue URL shape; ProposeCard's regex wouldn't match anyway)
// - submit-plugin.ts — "Submitted plugin …" surface, not "Queued …"
const PROPOSE_TOOL_FILES = [
  "create-layout.ts",
  "tune-rate-limit.ts",
  "propose-site-import.ts",
  "propose-deploy-promote.ts",
  "propose-add-locale.ts",
  "propose-remove-locale.ts",
  "propose-set-default-locale.ts",
  "propose-update-locale-strategy.ts",
  "_make-propose-tool.ts",
];

// Files allowed to use "Queued <prefix> proposal" — different queue,
// different UX, not routed through ProposeCard.
const EXEMPT_FROM_CANONICAL_LOCK = new Set(["propose-skill.ts"]);

/**
 * The COLON is the load-bearing character, not the "Queued proposal " prefix.
 * ProposeCard's parser is `/^Queued proposal ([0-9a-f-]{36}):\s*([^.]+)\./` —
 * it needs `Queued proposal <uuid>: <summary>.`
 *
 * This pattern used to be `/content:\s*[`"']Queued proposal /` — prefix only.
 * That hole is why the four locale tools shipped
 * `Queued proposal ${proposalId} to add locale 'de'` (no colon): they passed
 * this lock and still never rendered an Approve card, because the parser
 * requires the colon this test wasn't checking. Requiring `${…}:` closes it.
 */
const CANONICAL_PREFIX_PATTERN = /content:\s*[`"']Queued proposal \$\{[^}]+\}:/;
const FORBIDDEN_NON_CANONICAL = /content:\s*[`"']Queued (?!proposal\b)/;

/**
 * A file that builds its tools with `makeProposeTool` has no content template
 * of its own — the factory owns it (and `_make-propose-tool.ts` is itself in
 * PROPOSE_TOOL_FILES, so the canonical shape is still locked, once, where it
 * actually lives). Delegating is the PREFERRED shape; this lets the lock say
 * "canonical template OR delegates to the thing that has one".
 */
const DELEGATES_TO_FACTORY = /makeProposeTool[<(]/;

describe("propose-tool content shape (v0.5.11)", () => {
  for (const file of PROPOSE_TOOL_FILES) {
    it(`${file} emits canonical "Queued proposal <uuid>:" content (or delegates)`, () => {
      const path = join(TOOLS_DIR, file);
      const src = readFileSync(path, "utf8");

      // Either the file carries a canonical content template itself, or it
      // hands the job to makeProposeTool (which carries the only copy).
      const ok = CANONICAL_PREFIX_PATTERN.test(src) || DELEGATES_TO_FACTORY.test(src);
      // Must NOT contain any non-canonical "Queued <something> proposal"
      // template (e.g. "Queued layout-create proposal", "Queued import
      // proposal", "Queued promote proposal" all caused the v0.5.11 bug).
      const hasForbidden = FORBIDDEN_NON_CANONICAL.test(src);

      expect(
        ok,
        `${file} must either emit \`Queued proposal \${id}: …\` or use makeProposeTool`,
      ).toBe(true);
      expect(hasForbidden).toBe(false);
    });
  }

  it("the factory itself carries a template the ProposeCard parser accepts", () => {
    // The one copy every delegating tool relies on. Mirrors
    // apps/admin/src/lib/components/chat/proposal-parser.ts.
    const src = readFileSync(join(TOOLS_DIR, "_make-propose-tool.ts"), "utf8");
    expect(CANONICAL_PREFIX_PATTERN.test(src)).toBe(true);
  });

  it("no tool file under ai/tools/ emits a non-canonical 'Queued X proposal' template", () => {
    // Catch-all: future propose-style tool that ships in a different
    // file. Anything starting with `Queued ` in a content: template
    // must continue with "proposal" — except the explicitly-exempted
    // tools that route to non-ProposeCard UIs.
    const files = readdirSync(TOOLS_DIR).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !EXEMPT_FROM_CANONICAL_LOCK.has(f),
    );
    for (const file of files) {
      const src = readFileSync(join(TOOLS_DIR, file), "utf8");
      expect(FORBIDDEN_NON_CANONICAL.test(src)).toBe(false);
    }
  });
});
