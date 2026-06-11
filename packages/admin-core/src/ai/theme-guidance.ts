// SPDX-License-Identifier: MPL-2.0

/**
 * issue #112 — shared fragments of the "compose the theme yourself"
 * guidance.
 *
 * The same instructions reach the AI through three surfaces: the
 * `propose_create_theme` tool description, the cold-start gate's
 * setup steps, and the system-prompt `## Theme` block. If the copies
 * drift, the model gets contradictory instructions mid-flow — the
 * regression class the e2e-livedit suite calls "missing primers" — so
 * the fragments that must stay identical live here and the surfaces
 * compose their prose around them.
 */

/**
 * The category/slot skeleton of a complete DTCG document. Detailed
 * enough that the AI lands a boundary-valid document on the first
 * call without a rejected-retry round-trip.
 */
export const THEME_DOCUMENT_SKELETON =
  "`{color: {background, foreground, primary, primary-foreground, secondary, " +
  "secondary-foreground, accent, accent-foreground, muted, muted-foreground, card, " +
  "card-foreground, border, ring, destructive, destructive-foreground}, typography: " +
  "{body, heading, mono}, spacing: {xs…2xl}, radius: {sm…lg}, shadow, motion}`";

/**
 * Hue-by-industry starting points. The hue anchors the palette; the
 * rest of the document is still the AI's to compose — these exist so
 * the model doesn't fall back to neutral when the brand isn't overtly
 * color-coded.
 */
export const ANCHOR_HUE_HINTS =
  "`#4f46e5` indigo (SaaS / dev tools), `#7c3aed` violet (creative / AI products), " +
  "`#06b6d4` cyan (data / analytics), `#10b981` emerald (sustainability / finance), " +
  "`#f59e0b` amber (warm / lifestyle), `#ef4444` red (urgency / news), " +
  "`#0f172a` slate (luxury / enterprise)";
