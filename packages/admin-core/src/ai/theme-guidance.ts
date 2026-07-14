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
  "card-foreground, border, ring, destructive, destructive-foreground, surface, " +
  "surface-alt}, gradient: {hero, subtle}, typography: {body, heading, mono}, " +
  "spacing: {xs…2xl}, radius: {sm…lg}, shadow: {sm…xl}, motion}`";

/**
 * Palette starting points by industry feel (issue #153: pairs, not
 * single hues — one flat hue reads as unfinished). The pair anchors
 * the palette; the rest of the document is still the AI's to compose —
 * these exist so the model doesn't fall back to neutral when the brand
 * isn't overtly color-coded.
 */
export const ANCHOR_HUE_HINTS =
  "`#4f46e5` indigo + violet accent (SaaS / dev tools), " +
  "`#7c3aed` violet + cyan accent (creative / AI products), " +
  "`#06b6d4` cyan + deep-navy neutrals (data / analytics), " +
  "`#10b981` emerald + warm-sand neutrals (sustainability / finance), " +
  "`#f59e0b` amber + terracotta accent (warm / lifestyle), " +
  "`#ef4444` red + cool-slate neutrals (urgency / news), " +
  "`#0f172a` slate + gold accent (luxury / enterprise)";

/**
 * issue #153 — the anti-flat primer. #112 killed grayscale; the next
 * ceiling was flat single-hue documents (no gradients, one shadow, no
 * surface tinting). Shared verbatim by the same three surfaces as the
 * skeleton so the copies can't drift.
 */
/**
 * 2026-07-12 — composite token shapes. The skeleton alone under-
 * specified typography + shadow, and every live theme compose burned
 * 2-3 rejected-retry round-trips (red error cards in the operator's
 * chat) rediscovering these shapes. Shared by the same three surfaces
 * as the skeleton.
 */
export const TOKEN_SHAPE_HINTS =
  "Composite shapes — copy these exactly: typography leaves are " +
  "`{$type: 'typography', $value: {fontFamily: 'Inter, sans-serif', fontSize: '1rem', " +
  "fontWeight: 400, lineHeight: 1.6}}` (one composite per body/heading/mono — NOT per-property " +
  "tokens, and fontFamily is a plain string). Shadow leaves are " +
  "`{$type: 'shadow', $value: {color: '#0b132b33', offsetX: '0px', offsetY: '2px', " +
  "blur: '8px', spread: '0px'}}` (structured object or array of them — NEVER a raw CSS string). " +
  "Gradient leaves are a CSS `*-gradient(...)` string, NOT a color — set them at the " +
  "`gradient.*` namespace and the `$type` is inferred: e.g. " +
  "`set: {'gradient.hero': {$type: 'gradient', $value: 'linear-gradient(135deg, #4f46e5, #7c3aed)'}}` " +
  "(the bare string `'linear-gradient(135deg, #4f46e5, #7c3aed)'` or a loose name like " +
  "`heroGradient` also work — the server routes any `gradient.*`/`*Gradient` name to a gradient " +
  "token). Only `linear-`/`radial-`/`conic-gradient(...)` values are valid; never alias " +
  "({group.token}) unless the target exists.";

export const DEPTH_AND_SURFACE_HINTS =
  "Compose DEPTH, not just hue: give `gradient.hero` a real two-stop CSS gradient in the " +
  "primary's family (e.g. `linear-gradient(135deg, <primary>, <accent>)`) and `gradient.subtle` " +
  "a near-invisible background wash; tint `color.surface-alt` a few percent off `background` so " +
  "sections can alternate; grade `shadow.sm…xl` as a real elevation ramp. Flat single-hue " +
  "palettes read as unfinished — reserve strict flatness for brands that explicitly demand it.";
