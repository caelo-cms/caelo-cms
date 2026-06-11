// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.4 (issue #76 follow-up) — shared cold-start gate for module-
 * creation AI tools.
 *
 * Caelo is chat-first per CLAUDE.md §1A: the operator opens /edit and
 * describes outcomes; the AI captures site identity + evolves the
 * theme + builds the page from those outcomes. There's no forms-based
 * onboarding step.
 *
 * The gate enforces the order. When the AI calls any module-creation
 * tool on an install that's still in cold-start state (no site
 * identity captured, or no brand-derived described theme active), the
 * gate returns
 * a structured AI-actionable error (per CLAUDE.md §11) telling the AI
 * what to call BEFORE retrying. Without the gate, the AI prioritises
 * the user's concrete page-build request over the upfront setup
 * instructions in the system prompt and produces a page rendered
 * against the seed-grayscale theme.
 *
 * Scope: AI-callable module-creation tools (compose_page_from_spec,
 * add_module_to_page, add_module_to_layout, create_page). Human +
 * system callers are exempt — the gate fires only when
 * `ctx.actorKind === "ai"` because (1) human operators using the API
 * directly may legitimately want a blank install, and (2) system
 * callers (migrations, scripts) shouldn't be blocked.
 *
 * Idempotent: the gate clears the moment both conditions are met —
 * identity captured AND a brand-derived theme is active. "Brand-
 * derived" (issue #112) means `origin != 'seed'` AND a non-empty
 * `description` (the recorded design rationale): origin alone is not
 * enough, because flipping it was previously satisfiable by minting a
 * grayscale preset and stopping. Once the AI calls
 * `set_site_identity` + composes/describes the theme, the retry sails
 * through.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { ToolContext, ToolResult } from "./dispatch.js";

export interface ColdStartCheckResult {
  /** True when the gate fired — caller should return the gateResult. */
  readonly blocked: boolean;
  /** AI-actionable error result. Only present when blocked is true. */
  readonly gateResult?: ToolResult;
}

/**
 * Detect cold-start state and return a gate result the caller can
 * forward directly. Returns `{ blocked: false }` when:
 * - the actor isn't AI (humans + system bypass),
 * - identity has been captured (siteName OR sitePurpose non-empty)
 *   AND the active theme is brand-derived (`origin != 'seed'` AND a
 *   non-empty `description` recording the design rationale — issue
 *   #112: origin alone cleared the gate for grayscale presets),
 * - the state lookups themselves fail (don't block on infra errors;
 *   the underlying tool will surface them).
 *
 * `toolName` is included in the error message so the AI knows which
 * tool to retry after running the setup steps.
 */
export async function checkColdStartGate(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  toolName: string,
): Promise<ColdStartCheckResult> {
  // Humans + system actors bypass — only AI calls are gated.
  if (ctx.actorKind !== "ai") return { blocked: false };

  // The two reads are independent — run them concurrently so the gate
  // adds one round-trip, not two, to every AI module-creation call.
  const [identityCheck, themeCheck] = await Promise.all([
    execute(toolCtx.registry, toolCtx.adapter, ctx, "site_defaults.get", {}),
    execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.get_active", {}),
  ]);

  if (!identityCheck.ok || !themeCheck.ok) return { blocked: false };

  const defaults = (
    identityCheck.value as {
      defaults: { siteName: string | null; sitePurpose: string | null } | null;
    }
  ).defaults;
  const theme = (
    themeCheck.value as {
      theme: { origin: "seed" | "ai" | "operator"; description: string | null } | null;
    }
  ).theme;

  const noIdentity =
    !defaults ||
    ((!defaults.siteName || defaults.siteName.trim().length === 0) &&
      (!defaults.sitePurpose || defaults.sitePurpose.trim().length === 0));
  // `themes.get_active` returns null when NO theme is active at all (a
  // fresh install before any theme is created/activated) — distinct from
  // an active-but-seed-origin theme. The two need different setup steps:
  // a seed theme can be mutated in place via set_theme_tokens, but with
  // no active theme those calls fail ("no active theme") and the AI burns
  // two doomed tool calls. issue #106 (step-13 deviation) — branch on it.
  const noActiveTheme = !theme;
  const seedTheme = noActiveTheme || theme.origin === "seed";
  // issue #112 — a third blocked state: the theme was evolved (origin
  // flipped) but no design rationale was recorded (reachable via
  // import_theme / duplicate_theme / a pre-#112 row). The fix is to
  // record the rationale, NOT to recompose a theme that already exists.
  const undescribedTheme =
    !seedTheme && (!theme?.description || theme.description.trim().length === 0);

  if (!noIdentity && !seedTheme && !undescribedTheme) return { blocked: false };

  // Compose the AI-actionable instruction as an ordered step list so the
  // numbering stays correct across the identity / theme / no-active-theme
  // permutations (the previous nested-ternary numbering was brittle and
  // mis-ordered the no-active-theme case). List the exact tool the AI is
  // retrying so it doesn't lose track across the round-trips.
  const steps: string[] = [];
  if (noIdentity) {
    steps.push(
      "`set_site_identity({siteName: '<inferred from user prompt>', sitePurpose: '<one or two sentences>'})`. " +
        "Example: user says 'build me a homepage for an AI-first CMS called Caelo, trustworthy and developer-focused' → " +
        "siteName 'Caelo', sitePurpose 'An AI-first CMS for developers — trustworthy, branched edits, plugin sandbox'.",
    );
  }
  if (seedTheme && noActiveTheme) {
    // No theme exists yet — set_theme_tokens/set_theme_meta would fail
    // ("no active theme"). The AI must create + activate one first. Both
    // are AI-proposable: propose them yourself, then ask the operator for
    // the single approval click each — do NOT ask the operator to run the
    // propose ops (CLAUDE.md §1A recover-don't-punt).
    steps.push(
      "`propose_create_theme({slug, displayName, description, tokens})` — COMPOSE the complete DTCG token " +
        "document yourself from the brand context (site identity, the operator's wording, the industry): a full " +
        "`color` group (background, foreground, primary, primary-foreground, secondary, accent, muted, card, " +
        "border, ring, destructive + foregrounds), `typography` (body, heading, mono), `spacing`, `radius`, " +
        "`shadow`. The primary must carry real chroma — never default to neutral grayscale on a real site. " +
        "Anchor-hue inspiration: #4f46e5 indigo (SaaS / dev tools), #7c3aed violet (creative / AI), " +
        "#06b6d4 cyan (data / analytics), #10b981 emerald (sustainability / finance), #f59e0b amber " +
        "(warm / lifestyle), #0f172a slate (luxury / enterprise) — the hue anchors the palette, the rest of the " +
        "document is still yours to compose. `description` records WHY the palette fits the brand. " +
        "Then tell the operator to approve it at /security/themes/pending.",
    );
    steps.push(
      "`propose_activate_theme({themeId: '<id from list_themes>'})` so it becomes the active theme, " +
        "then tell the operator to approve that too. (You propose both; the operator just clicks Approve.)",
    );
  } else if (seedTheme) {
    // An active seed theme exists — evolve it in place into a full
    // brand palette (not just one color swap).
    steps.push(
      "`set_theme_tokens({set: {…}})` — evolve the seed grayscale into a full brand palette in ONE call: " +
        "primaryColor with real chroma plus the supporting colors that should follow it (accent, ring, " +
        "secondary where the brand calls for it), and typography if the brand voice suggests one. " +
        "Anchor-hue inspiration: #4f46e5 indigo (SaaS / dev tools), #7c3aed violet (creative / AI), " +
        "#06b6d4 cyan (data / analytics), #10b981 emerald (sustainability / finance), #f59e0b amber " +
        "(warm / lifestyle), #0f172a slate (luxury / enterprise). Never leave a real site on the neutral " +
        "grayscale seed.",
    );
    steps.push(
      "`set_theme_meta({description: '<why this palette fits the brand>'})` — required: the gate clears only " +
        "once the active theme is non-seed AND described.",
    );
  } else if (undescribedTheme) {
    // The theme is already brand-evolved; only the rationale is missing.
    steps.push(
      "`set_theme_meta({description: '<why the current palette fits the brand>'})` — the active theme is " +
        "already evolved; record the design rationale. Do NOT recompose or re-create the theme.",
    );
  }
  steps.push(`Retry \`${toolName}\` with the same arguments.`);

  return {
    blocked: true,
    gateResult: {
      ok: false,
      content:
        `${toolName}: cold-start install detected — ` +
        `${noIdentity ? "no site identity captured" : "site identity captured"}` +
        ` AND ` +
        `${
          noActiveTheme
            ? "no active theme yet"
            : seedTheme
              ? "theme is still seed-origin (grayscale)"
              : undescribedTheme
                ? "theme is evolved but has no recorded design rationale (description)"
                : "theme is brand-derived and described"
        }.\n\n` +
        `Caelo is chat-first (CLAUDE.md §1A) — the AI captures brand context AND composes a ` +
        `brand-derived theme BEFORE authoring any modules. The page would otherwise render against ` +
        `the seed-grayscale palette and lose the operator's intent.\n\n` +
        `Required setup (run these in order, then retry your \`${toolName}\` call):\n\n` +
        steps.map((s, i) => `${i + 1}. ${s}`).join("\n") +
        `\n\nIf the operator's prompt is too vague to infer identity, ASK ONE concise question ` +
        `("What's this site for?") before guessing.`,
    },
  };
}
