// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario (epic #1107) — a mega menu with three columns and a latest-news
 * block, in the header and as the footer list.
 *
 * The operator asks in outcome words only (CLAUDE.md §1A): no "list type",
 * no "node", no "query". The AI has to decide that a mega menu is a SHARED
 * list of a navigation type whose columns hold links and whose news block
 * is a node filled by a page query (docs/lists.md §3, §6), bind the header
 * and the footer module to that one list, and place each once on the
 * layout (one placement covers the whole site). The follow-up turn
 * ("add Careers under Company") must be an item-level edit of the same
 * list (`patch_list_items_many`), not a new list or a module rewrite.
 *
 * Seeds: the minimal site, `header` + `footer` layout blocks, the
 * post-onboarding theme (so the cold-start gate does not take the turn)
 * and a `news` page type with three published articles the query can
 * return. Assertions read the draft view (`lib/list-model.ts`).
 *
 * Coverage map:
 *   • #1107 — mega menu = shared navigation list, query node, header + footer bound to it
 *   • #1107 — maintaining a shared list goes through patch_list_items_many
 */

import { expect, test } from "./fixtures.js";
import {
  assertNoChatRunnerDiagWarnings,
  attachChatSessionTracker,
  loginAsDevOwner,
  primePostOnboarding,
  resetLiveditFixtures,
  seedLayoutBlocks,
  seedMinimalSite,
  seedNewsArticles,
  sendChatPromptAndWait,
} from "./helpers.js";
import {
  calledTool,
  chromeModules,
  flattenItems,
  megaMenuFacts,
  snapshotListModel,
} from "./lib/list-model.js";

const PROMPT =
  "Our site needs a proper mega menu in the header: three columns — Products, Solutions and Company — " +
  "each with two or three links to pages on the site (create simple pages for them if they don't exist), " +
  "plus a 'Latest news' block that always shows our three newest news articles. " +
  "Show the same menu in the footer on every page.";

const FOLLOW_UP = "Add a Careers link under Company in the menu (create a simple Careers page).";

test("#1107: mega menu with three columns + latest news, shared by header and footer", async ({
  page,
}) => {
  await resetLiveditFixtures();
  seedMinimalSite();
  seedLayoutBlocks(["header", "footer"]);
  primePostOnboarding();
  seedNewsArticles(3);
  attachChatSessionTracker(page);
  await loginAsDevOwner(page);
  await page.goto("/edit");

  // A mega menu with pages behind it is a large turn; the homepage budget fits.
  await sendChatPromptAndWait(page, PROMPT, 600_000);

  const snap = snapshotListModel();
  const facts = megaMenuFacts(snap);
  console.log(`[scenario-lists-mega-menu] facts ${JSON.stringify({ ...facts, text: undefined })}`);

  // Header and footer each carry a module (placed once on the layout).
  expect(chromeModules(snap, "header").length, "no module in the header block").toBeGreaterThan(0);
  expect(chromeModules(snap, "footer").length, "no module in the footer block").toBeGreaterThan(0);
  // ONE shared list both show — the menu is not duplicated per module.
  expect(facts.listId, "header and footer are not bound to the same shared list").not.toBeNull();
  // Three columns, each a node with children.
  expect(facts.columnCount, "the menu does not have three column entries").toBeGreaterThanOrEqual(
    3,
  );
  for (const name of ["products", "solutions", "company"]) {
    expect(facts.text, `the menu lacks the ${name} column`).toContain(name);
  }
  // The news block is a query node of the list type, present in the list.
  expect(facts.typeHasQueryNode, "the menu's list type has no query-filled node").toBe(true);
  expect(facts.listHasQueryEntry, "the menu has no latest-news (query) entry").toBe(true);

  // Follow-up: maintain the SAME shared list at item level.
  const followUpAt = new Date().toISOString();
  await sendChatPromptAndWait(page, FOLLOW_UP);
  const after = snapshotListModel({ toolsSince: followUpAt });
  const menu = after.lists.find((l) => l.id === facts.listId);
  expect(menu, "the menu list disappeared after the follow-up").toBeDefined();
  const company = (menu?.items ?? []).find((it) =>
    JSON.stringify(it.values ?? {})
      .toLowerCase()
      .includes("company"),
  );
  expect(company, "the Company column is gone").toBeDefined();
  expect(
    flattenItems(company?.children ?? []).some((it) =>
      JSON.stringify(it.values ?? {})
        .toLowerCase()
        .includes("careers"),
    ),
    "Careers was not added under Company",
  ).toBe(true);
  expect(
    calledTool(after, "patch_list_items_many"),
    "the follow-up should be an item-level patch of the shared list",
  ).toBe(true);
  // Header and footer still show that one list.
  expect(megaMenuFacts(after).listId).toBe(facts.listId);

  assertNoChatRunnerDiagWarnings();
});
