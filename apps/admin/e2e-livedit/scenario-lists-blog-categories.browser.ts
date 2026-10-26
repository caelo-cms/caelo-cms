// SPDX-License-Identifier: MPL-2.0

/**
 * Scenario (epic #1107) — blog categories assigned to articles.
 *
 * "I'm starting a blog with categories" is a new content format: the AI
 * has to create a vocabulary list for the categories, a page type for
 * articles that takes that vocabulary, articles of that type carrying one
 * category each (terms), and category landing pages — normal pages whose
 * module lists the category's articles through a `term_pages` source or a
 * query by terms (docs/lists.md §5, §6; the manage-page-types skill). The
 * prompt names none of those words (CLAUDE.md §1A).
 *
 * Assertions read the draft view (`lib/list-model.ts`); nothing is staged.
 *
 * Coverage map:
 *   • #1107 — vocabulary list + article page type + terms on pages
 *   • #1107 — category landing pages list articles by term
 */

import { expect, test } from "./fixtures.js";
import {
  assertNoChatRunnerDiagWarnings,
  attachChatSessionTracker,
  loginAsDevOwner,
  primePostOnboarding,
  resetLiveditFixtures,
  seedMinimalSite,
  sendChatPromptAndWait,
} from "./helpers.js";
import { blogCategoryFacts, snapshotListModel } from "./lib/list-model.js";

const CATEGORIES = ["guides", "product news", "engineering"];

const PROMPT =
  "I'm starting a blog. Every article belongs to one of three categories: Guides, Product news and Engineering. " +
  "Write three short articles, one per category, and give each category a page that lists its articles.";

test("#1107: blog categories are a vocabulary the article pages carry", async ({ page }) => {
  await resetLiveditFixtures();
  seedMinimalSite();
  primePostOnboarding();
  attachChatSessionTracker(page);
  await loginAsDevOwner(page);
  await page.goto("/edit");

  // Six pages plus the structure is a large turn.
  await sendChatPromptAndWait(page, PROMPT, 600_000);

  const snap = snapshotListModel();
  const facts = blogCategoryFacts(snap, CATEGORIES);
  console.log(`[scenario-lists-blog-categories] facts ${JSON.stringify(facts)}`);

  expect(facts.vocabularyId, "no vocabulary list carries the three categories").not.toBeNull();
  expect(
    facts.articleTypeIds.length,
    "no page type for articles takes the category vocabulary",
  ).toBeGreaterThan(0);
  expect(facts.taggedArticles, "fewer than three articles carry a category").toBeGreaterThanOrEqual(
    3,
  );
  expect(facts.coveredCategories, "the articles do not cover all three categories").toBe(3);
  expect(
    facts.termListingModules,
    "no category page lists its articles by term (term_pages or a query by terms)",
  ).toBeGreaterThan(0);

  assertNoChatRunnerDiagWarnings();
});
