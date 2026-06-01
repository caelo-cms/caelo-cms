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
 * identity captured AND theme is still seed-origin), the gate returns
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
 * Idempotent: the gate clears the moment either condition is no
 * longer met (identity captured OR theme origin flipped off `seed`),
 * so once the AI calls `set_site_identity` + `set_theme_tokens`, the
 * retry sails through.
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
 * - identity has been captured (siteName OR sitePurpose non-empty),
 * - the active theme's origin is no longer `seed`,
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

  const identityCheck = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    ctx,
    "site_defaults.get",
    {},
  );
  const themeCheck = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.get_active", {});

  if (!identityCheck.ok || !themeCheck.ok) return { blocked: false };

  const defaults = (
    identityCheck.value as {
      defaults: { siteName: string | null; sitePurpose: string | null } | null;
    }
  ).defaults;
  const theme = (
    themeCheck.value as {
      theme: { origin: "seed" | "ai" | "operator" } | null;
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

  if (!noIdentity && !seedTheme) return { blocked: false };

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
      "`propose_create_theme({name: '<brand name>', preset: 'shadcn-default'})` to mint a theme, " +
        "then tell the operator to approve it at /security/themes/pending. " +
        "Pick a brand-fitting primary color to set next: #4f46e5 indigo (SaaS / dev tools), #7c3aed violet (creative / AI), " +
        "#06b6d4 cyan (data / analytics), #10b981 emerald (sustainability / finance), #f59e0b amber (warm / lifestyle), " +
        "#0f172a slate (luxury / enterprise).",
    );
    steps.push(
      "`propose_activate_theme({themeId: '<id from list_themes>'})` so it becomes the active theme, " +
        "then tell the operator to approve that too. (You propose both; the operator just clicks Approve.)",
    );
    steps.push(
      "Once the theme is active: `set_theme_tokens({set: {primaryColor: '<hex>'}})` and " +
        "`set_theme_meta({description: '<why this palette fits>'})`.",
    );
  } else if (seedTheme) {
    // An active seed theme exists — mutate it in place.
    steps.push(
      "`set_theme_tokens({set: {primaryColor: '<hex>'}})`. Pick a brand-fitting color: #4f46e5 indigo (SaaS / dev tools), " +
        "#7c3aed violet (creative / AI), #06b6d4 cyan (data / analytics), #10b981 emerald (sustainability / finance), " +
        "#f59e0b amber (warm / lifestyle), #0f172a slate (luxury / enterprise).",
    );
    steps.push("`set_theme_meta({description: '<why this palette fits>'})`.");
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
              : "theme has been evolved"
        }.\n\n` +
        `Caelo is chat-first (CLAUDE.md §1A) — the AI captures brand context AND evolves the theme ` +
        `BEFORE authoring any modules. The page would otherwise render against the seed-grayscale ` +
        `palette and lose the operator's intent.\n\n` +
        `Required setup (run these in order, then retry your \`${toolName}\` call):\n\n` +
        steps.map((s, i) => `${i + 1}. ${s}`).join("\n") +
        `\n\nIf the operator's prompt is too vague to infer identity, ASK ONE concise question ` +
        `("What's this site for?") before guessing.`,
    },
  };
}
