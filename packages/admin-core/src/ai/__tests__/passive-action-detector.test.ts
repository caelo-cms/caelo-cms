// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 — unit coverage for `isLegitimateTextOnlyTurn`, which decides
 * whether a loop-0 text-only `end_turn` is a legitimate stop (nudge skips) or
 * the passive failure (an announced/implied action the model never carried
 * out — the step-13 footer regression). `true` = legitimate (skip the nudge);
 * `false` = passive failure (fire one nudge).
 *
 * The earlier narrow verb-matcher fired only on first-person commitment
 * phrasing and so MISSED footer-style declaratives ("A site-wide footer
 * belongs on the layout's footer block …"). This detector inverts the logic:
 * nudge unless the turn is a recognised legitimate stop (a clarifying question
 * or an awaiting-approval message). These tests pin both directions, including
 * the footer declarative that previously slipped through.
 */

import { describe, expect, it } from "bun:test";
import { isLegitimateTextOnlyTurn } from "../chat-runner.js";

describe("isLegitimateTextOnlyTurn — passive failures (NOT legitimate → nudge fires)", () => {
  const passiveFailures = [
    // The exact footer-path regression phrasing the narrow detector missed.
    "A site-wide footer belongs on the layout's footer block so every page picks it up.",
    "A site-wide footer belongs on the layout's footer block ... adding it there now.",
    "I'll add the hero banner to the top of the homepage.",
    "I will create the footer module now.",
    "Let me place the CTA at the bottom of the page.",
    "Creating the pricing section now.",
    "The footer goes in the layout chrome so it reaches every page.",
    "This belongs in the header block of the site-default layout.",
  ];
  for (const t of passiveFailures) {
    it(`false (nudge): ${t.slice(0, 52)}…`, () => {
      expect(isLegitimateTextOnlyTurn(t)).toBe(false);
    });
  }
});

describe("isLegitimateTextOnlyTurn — legitimate stops (true → nudge skips)", () => {
  const legitimate = [
    "Want me to add a footer with Home, About, and Contact links?",
    "Should I place the hero above or below the welcome section?",
    "Would you like the footer on every page, or just the homepage?",
    "Do you want me to add a contact form too?",
    "Which option do you prefer — a slim bar or a full footer?",
    "Let me know which sections you want and I'll build them.",
    // Awaiting an Owner approval click (propose/execute gate, §11.A).
    "I've queued the theme. Approve it at /security/themes/pending and I'll continue.",
    "The activate-theme proposal is queued — click Approve and reply to continue.",
    "Once you approve the theme, I'll add the hero banner.",
    "I need you to approve the proposal before I can place the hero.",
  ];
  for (const t of legitimate) {
    it(`true (skip): ${t.slice(0, 52)}…`, () => {
      expect(isLegitimateTextOnlyTurn(t)).toBe(true);
    });
  }

  it("empty / whitespace is not a legitimate turn (handled by the empty-response path)", () => {
    expect(isLegitimateTextOnlyTurn("")).toBe(false);
    expect(isLegitimateTextOnlyTurn("   ")).toBe(false);
  });
});
