// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario (issue #106, step-13 regression guard; epic #1107) — the
 * layout/footer path.
 *
 * The footer bug: asking the chat to "add a footer with nav links to every
 * page" reproducibly ended the assistant turn after a correct preamble
 * WITHOUT emitting the layout placement, because the tool's JSON field
 * schema could not represent a link list. The proof the path works is a
 * module placed in the layout's `footer` block whose repeating nav is ONE
 * `list` field — not numbered label1/label2 scalars (CLAUDE.md §1A) — and
 * no operator-punt in the final assistant message.
 *
 * Epic #1107 tightens the outcome: footer links are a SHARED list of a
 * fitting type (the alias in the tool descriptions and system prompt:
 * menus, navigation, footer links are shared lists), bound by the footer
 * module's `list` field, carrying the requested entries. Inline anchors in
 * the module HTML no longer pass — they were accepted only while the
 * structured-set binding was unreachable for the AI (#414).
 *
 * Self-contained: it seeds its own `footer` block on the site-default
 * layout (seedMinimalSite only creates the page + a `content` template
 * block) and reads the draft view via a bun subprocess
 * (`lib/list-model.ts`).
 *
 * Coverage map:
 *   • issue #106 — the layout placement emits a list footer (flavor #1/#2)
 *   • epic #1107 — footer links are a shared list bound by the module
 */

import { expect, test } from "./fixtures.js";
import {
  attachChatSessionTracker,
  loginAsDevOwner,
  primePostOnboarding,
  resetLiveditFixtures,
  seedLayoutBlocks,
  seedMinimalSite,
  sendChatPromptAndWait,
} from "./helpers.js";
import {
  boundListId,
  chromeModules,
  entryText,
  listFields,
  snapshotListModel,
} from "./lib/list-model.js";

const PROMPT =
  "Add a footer with navigation links to Home, About, and Contact to every page of the site.";

/** Operator-punt phrasing the AI must NOT emit (AC #5 — recover, don't punt). */
const PUNT_PATTERNS = [
  /you'?ll need to/i,
  /remove it via the editor/i,
  /add (?:the|a) block (?:in|via) the (?:editor|admin)/i,
  /please (?:add|create|configure) .* (?:in|via) the (?:editor|admin|settings)/i,
];

test("issue #106 / #1107: AI adds a footer nav to the layout as a shared list (no punt)", async ({
  page,
}) => {
  await resetLiveditFixtures();
  seedMinimalSite();
  seedLayoutBlocks(["footer"]);
  // The footer scenario runs first alphabetically (before scenario-homepage's
  // cold-start onboarding) and resetLiveditFixtures does NOT reset
  // site_defaults/themes — so prime the post-onboarding state explicitly,
  // otherwise the cold-start gate eats the turn and no footer is built.
  primePostOnboarding();
  attachChatSessionTracker(page);
  await loginAsDevOwner(page);
  // ChatPanel only mounts on /edit.
  await page.goto("/edit");

  await sendChatPromptAndWait(page, PROMPT);

  const snap = snapshotListModel();
  const footer = chromeModules(snap, "footer");

  // The layout placement was actually emitted (the turn didn't
  // narrate-then-drop the tool call) — the core #106 regression guard.
  expect(footer.length, "no module in the layout's footer block").toBeGreaterThan(0);

  // The nav is ONE list field (§1A), not numbered scalars or hardcoded <a>s.
  const withList = footer.filter((m) => listFields(m.fields).length > 0);
  expect(withList.length, "the footer module declares no `list` field").toBeGreaterThan(0);

  // Footer links are a shared list (the #1107 alias), bound by the field,
  // and that list carries the requested entries.
  const bound = withList.flatMap((m) =>
    listFields(m.fields).flatMap((f) => {
      const id = boundListId(snap, m.id, f);
      return id ? [id] : [];
    }),
  );
  expect(bound.length, "the footer's list field is not bound to a shared list").toBeGreaterThan(0);
  const text = bound
    .map((id) => entryText(snap.lists.find((l) => l.id === id)?.items ?? []))
    .join(" ");
  expect(text, "the shared footer list lacks the About entry").toContain("about");
  expect(text, "the shared footer list lacks the Contact entry").toContain("contact");

  // AC #5 — the assistant recovered/built valid rather than punting an
  // implementation detail to the operator.
  for (const re of PUNT_PATTERNS) {
    expect(snap.lastAssistant).not.toMatch(re);
  }
});
