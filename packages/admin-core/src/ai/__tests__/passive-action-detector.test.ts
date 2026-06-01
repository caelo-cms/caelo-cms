// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 — unit coverage for `looksLikeAnnouncedAction`, the heuristic
 * that decides whether a text-only `end_turn` is the "announced an action
 * then forgot to emit the tool call" failure (step-13 footer regression).
 *
 * The detector gates a single nudge-and-retry in the chat-runner loop. The
 * v0.5.9 broad detector was removed because it false-fired on every
 * clarifying-question / summary turn, so these tests pin BOTH directions:
 * commitment-to-act phrasing trips it; clarifying questions and
 * advisory/summary phrasing do NOT.
 */

import { describe, expect, it } from "bun:test";
import { looksLikeAnnouncedAction } from "../chat-runner.js";

describe("looksLikeAnnouncedAction — fires on announced actions", () => {
  const announced = [
    "A site-wide footer belongs on the layout's footer block so every page picks it up — adding it there now.",
    "I'll add the hero banner to the top of the homepage.",
    "I will create the footer module now.",
    "Let me place the CTA at the bottom of the page.",
    "I'm going to add a navigation menu to the header.",
    "I'm adding the footer to the site-default layout.",
    "Creating the pricing section now.",
    "On it — placing the testimonial block now.",
  ];
  for (const t of announced) {
    it(`true: ${t.slice(0, 48)}…`, () => {
      expect(looksLikeAnnouncedAction(t)).toBe(true);
    });
  }
});

describe("looksLikeAnnouncedAction — does NOT fire on legitimate text-only turns", () => {
  const passiveLegit = [
    "", // empty
    "   ", // whitespace
    "Want me to add a footer with Home, About, and Contact links?",
    "Should I place the hero above or below the welcome section?",
    "Would you like the footer on every page, or just the homepage?",
    "Do you want me to add a contact form too?",
    "Here's the current state: the homepage has a hero and a welcome block.",
    "The /about and /contact pages don't exist yet, so those links would 404.",
    "I'd add a hero and a footer to round out the page, but it's your call.", // advisory/conditional
    "You could add a footer here if you want site-wide chrome.",
  ];
  for (const t of passiveLegit) {
    it(`false: ${(t.trim() || "<blank>").slice(0, 48)}…`, () => {
      expect(looksLikeAnnouncedAction(t)).toBe(false);
    });
  }

  it("does not fire when an action verb appears only inside a trailing question", () => {
    // Commitment-ish verb but the turn is a question → must stay false.
    expect(looksLikeAnnouncedAction("I can add a footer — want me to?")).toBe(false);
  });
});
