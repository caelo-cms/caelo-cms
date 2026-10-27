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
  "spacing: {xs…2xl component steps PLUS section-sm, section, section-lg for vertical " +
  "band rhythm}, radius: {sm…lg}, shadow: {sm…xl}, motion}`";

/**
 * Palette starting points by industry feel (issue #153: pairs, not
 * single hues — one flat hue reads as unfinished). The pair anchors
 * the palette; the rest of the document is still the AI's to compose —
 * these exist so the model doesn't fall back to neutral when the brand
 * isn't overtly color-coded.
 */
export const ANCHOR_HUE_HINTS =
  "`#4f46e5` indigo + violet (SaaS / dev tools) | `#7c3aed` violet + cyan (creative / AI) | " +
  "`#06b6d4` cyan + deep-navy neutrals (data / analytics) | `#10b981` emerald + warm-sand " +
  "(sustainability / finance) | `#f59e0b` amber + terracotta (warm / lifestyle) | `#ef4444` red + " +
  "cool-slate (urgency / news) | `#0f172a` slate + gold (luxury / enterprise)";

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
  "Composite shapes (copy exactly): typography leaf = `{$type: 'typography', $value: {fontFamily: " +
  "'Inter, sans-serif', fontSize: '1rem', fontWeight: 400, lineHeight: 1.6}}`, one composite per " +
  "body/heading/mono (never per-property tokens; fontFamily a plain string). Shadow leaf = " +
  "`{$type: 'shadow', $value: {color: '#0b132b33', offsetX: '0px', offsetY: '2px', blur: '8px', " +
  "spread: '0px'}}`, an object or array of them, never a raw CSS string. Gradient leaf = a CSS " +
  "`linear-` / `radial-` / `conic-gradient(...)` string (not a color) under `gradient.*`, `$type` " +
  "inferred: `set: {'gradient.hero': {$type: 'gradient', $value: 'linear-gradient(135deg, #4f46e5, " +
  "#7c3aed)'}}` (the bare string or a `*Gradient` name also routes to a gradient token). Never " +
  "alias ({group.token}) unless the target exists.";

/**
 * issue #430 — the spacing scale must cover the sizes pages actually
 * use. The dogfood install shipped `xs`…`2xl` (0.25–3rem) and then every
 * one of 18 modules hardcoded its section padding (3.5–5rem, above the
 * ceiling) and its control padding (0.6–0.8rem, between the two smallest
 * steps). `--spacing-*` ended up referenced by zero modules. That is not
 * the model ignoring an instruction — the vocabulary had no word for the
 * job, so a literal was the only available answer.
 */
export const SPACING_RHYTHM_HINTS =
  "`spacing` must cover what pages use, or module CSS falls back to literals the operator cannot " +
  "retune: component steps `xs`…`2xl` (0.25-3rem; controls need 0.6-0.9rem padding) PLUS rhythm " +
  "tokens `section-sm` (~2.5rem tight band), `section` (~4rem standard band), `section-lg` (~5rem " +
  "hero / feature band). Module CSS references them (`padding: var(--spacing-section) " +
  "var(--spacing-md)`); about to write a padding literal -> add the token instead.";

/**
 * issue #430 — a token's role is a design decision, and it is recorded
 * in the same call that sets the value. There is no separate design-system
 * document to write afterwards: the guard replays these roles at the exact
 * moment module CSS references the var.
 */
export const TOKEN_ROLE_HINTS =
  "Record each token's ROLE in `$description`: with the value (`set: {'color.primary': {$type: " +
  "'color', $value: '#4f46e5', $description: 'CTAs, links and selected states — never large " +
  "background fills'}}`) or as a value-less patch on a settled value (`set: {'color.primary': " +
  "{$description: '…'}}` leaves `$value` untouched; needs the canonical path or the `--css-var` " +
  "name, since a loose name infers its category from the value). Say where it must NOT be used, " +
  "not only where. Roles survive value-only edits and every module write replays the roles of the " +
  "vars its CSS touches: this is the whole design-system record, no separate manifest.";

export const DEPTH_AND_SURFACE_HINTS =
  "Compose DEPTH, not just hue: `gradient.hero` = a real two-stop gradient in the primary's family " +
  "(e.g. `linear-gradient(135deg, <primary>, <accent>)`), `gradient.subtle` = a near-invisible " +
  "wash; tint `color.surface-alt` a few percent off `background` so sections alternate; grade " +
  "`shadow.sm…xl` as a real elevation ramp. Flat single-hue palettes read unfinished; strict " +
  "flatness only when the brand demands it.";

/** Typographic intent shared by theme creation, edits and the persistent author context. */
export const TYPOGRAPHY_COMPOSITION_HINTS =
  "Typography by role: body = sustained reading, heading = hierarchy and navigation, optional " +
  "`typography.display` composite for expressive hero / campaign titles. Real, resolvable families " +
  "and supported numeric weights; one or two complementary families unless the brand needs more. A " +
  "display title needs deliberate size, line breaks, weight, spacing and composition, not an " +
  "enlarged or rainbow-colored body font. Record use and exclusions in each token's $description; " +
  "reference --font-display, --text-display, --font-weight-display and --tracking-display only " +
  "after creating those tokens. Keep established brand typography unless the operator asks for a " +
  "redesign. Preview the actual rendered fonts with the operator's text (accents, non-Latin " +
  "characters): a family name in a picker does not prove its face loaded. Check mobile line breaks " +
  "and reading contrast. Use the self-hosted font resolver and surface unresolved families; no " +
  "external font links. AI-generated lettering is a separate image asset, never a reusable font or " +
  "editable text: only on explicit request, verify exact spelling, keep accessible semantic text " +
  "without a duplicate visible title. Web-font availability does not establish PDF embedding " +
  "support.";
