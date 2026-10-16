// SPDX-License-Identifier: MPL-2.0

/**
 * #779 — coral (`variant="decide"`) means "only a human decides this":
 * Publish live and Approve on an approval card (CLAUDE.md §11.A). If it
 * spreads to other buttons it stops meaning anything, so every use is
 * pinned here. Adding a call site is a design decision: it must be a
 * Publish-live or Approve control, and it is added to this list in the
 * same change.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const SRC = join(import.meta.dir, "..", "..", "..", "..");

/** File (relative to apps/admin/src) → number of `"decide"` literals. */
const ALLOWED: Record<string, number> = {
  // Publish live in the /edit toolbar (one snippet, both branches).
  "lib/components/edit/StageDeployButton.svelte": 1,
  // Approve on an in-chat proposal tool card.
  "lib/components/chat/tool-cards/ProposeCard.svelte": 1,
  // Approve on the SDK approval strip + the pending-proposals strip.
  "lib/components/chat/ChatPanel.svelte": 2,
  // "Confirm publish" — promotes staging to production from the page list.
  "routes/(authed)/content/pages/+page.svelte": 1,
};

/** The variant's own definition, not a call site. */
const DEFINITION = "lib/components/ui/button/button-variants.ts";

// Any quoted decide string literal — `variant="decide"`, `variant: "decide"`,
// `const v = 'decide'` — so the variant cannot be smuggled in indirectly.
// Backticks are left out: comments name the variant in Markdown code.
const DECIDE_LITERAL = /["']decide["']/g;

function decideUses(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const path of new Glob("**/*.{svelte,ts}").scanSync({ cwd: SRC, absolute: true })) {
    const rel = relative(SRC, path);
    if (rel === DEFINITION || rel.endsWith(".test.ts")) continue;
    const n = readFileSync(path, "utf8").match(DECIDE_LITERAL)?.length ?? 0;
    if (n > 0) found[rel] = n;
  }
  return found;
}

describe("decide button variant", () => {
  it("is used only by Publish live and Approve controls", () => {
    expect(decideUses()).toEqual(ALLOWED);
  });

  it("is defined in the button variants", () => {
    const src = readFileSync(join(SRC, DEFINITION), "utf8");
    expect(src).toMatch(/decide:\s*"bg-decide text-decide-foreground hover:bg-decide-hover"/);
  });
});
