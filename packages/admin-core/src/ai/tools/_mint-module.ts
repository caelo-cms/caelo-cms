// SPDX-License-Identifier: MPL-2.0

/**
 * Shared mint path for the add_module tools. Given raw module HTML, run the
 * `moduleize` AI building block (a small, focused call that sees ONLY the html)
 * to produce a parametrised template + a semantic `fields[]` schema + sensible
 * displayName/kind/description, then persist it via `modules.create`. The
 * operator/main-agent just throws HTML; this does the field work off the main
 * turn (see moduleize.ts).
 *
 * Graceful degradation: when no provider is on the tool context (background
 * jobs, tests, MCP without a chat), moduleize can't run, so we fall back to the
 * legacy path — the caller's html + field hint go straight to modules.create
 * (server-side extractor fills gaps). moduleize is an enhancement, not a hard
 * dependency.
 *
 * Telemetry: when moduleize needs a repair, its onRetry writes one row via
 * `ai_moduleize.log_attempt` (retries only — see the migration).
 */

import { execute } from "@caelo-cms/query-api";
import { type ExecutionContext, type ModuleField, slugifyModuleName } from "@caelo-cms/shared";
import { moduleize } from "../moduleize.js";
import { describeError, toolError } from "./_describe-error.js";
import { bindCssToTheme } from "./_theme-binding.js";
import type { ToolContext } from "./dispatch.js";

export interface MintModuleArgs {
  readonly html: string;
  readonly displayNameHint: string;
  readonly fieldsHint?: readonly ModuleField[];
  readonly description?: string;
  readonly kind?: "chrome" | "hero" | "content" | "cta" | "utility";
  readonly type?: string;
  readonly css?: string;
  readonly js?: string;
  readonly bindThemeLiterals?: boolean;
}

export interface MintModuleOk {
  readonly ok: true;
  readonly moduleId: string;
  readonly slug: string;
  /** Human note appended to the tool result (moduleize summary / bind report). */
  readonly note: string;
  /** The final CSS actually stored (post theme-literal binding) — the tools
   *  feed it to cssVarWarningSuffix / designGuardSuffix. */
  readonly css: string;
  /** The kind actually stored (moduleize-chosen or caller hint) — for the
   *  design guard. */
  readonly kind: "chrome" | "hero" | "content" | "cta" | "utility" | undefined;
  /** The fields actually stored (moduleize-inferred or caller-authored) —
   *  callers echo the names back in the tool result so the main agent
   *  knows the module's content shape without a follow-up read. */
  readonly fields: readonly ModuleField[] | undefined;
}
export interface MintModuleErr {
  readonly ok: false;
  readonly content: string;
}

/**
 * #741 — why `add_module` without `fields[]` does not run on an AI-delegated
 * (Power-MCP) call, and what to send instead (CLAUDE.md §1A: the AI authors
 * the semantic fields in the same call as the HTML).
 */
export const DELEGATED_MINT_NEEDS_FIELDS =
  "Nothing was created. On this connection you author the module yourself — the install's AI does not moduleize raw HTML for you. " +
  "Parametrise the HTML ({{field_name}} placeholders, semantic snake_case names like hero_title / primary_cta_href; repeating items as one list field, never label2/label3) " +
  "plus an explicit `fields[]` declaring each placeholder (name, kind, label) and the ORIGINAL copy as `values` (or each field's `default`). " +
  "Pass `fields: []` only for a module with no editable content. " +
  // #820 — a worked example, so authoring the module is never costlier
  // than pasting the same markup into another module's richtext field.
  'Example for a repeating pattern: html `<div class="chain">{{#steps}}<div class="step"><p>{{text}}</p></div>{{/steps}}</div>`, ' +
  'fields `[{name: "steps", kind: "list", listType: "texts", label: "Steps"}]`, values `{steps: [{node: "text", values: {text: "Crawl"}}, {node: "text", values: {text: "Diff"}}, {node: "text", values: {text: "Alert"}}]}`. ' +
  "Never paste component markup into a richtext field of another module instead — that is free HTML the structure quality check blocks once it repeats.";

/** The `modules.create` input a mint resolved to, plus what the tools report about it. */
export interface PreparedMint {
  readonly ok: true;
  readonly createInput: {
    readonly slug: string;
    readonly displayName: string;
    readonly description?: string;
    readonly kind?: "chrome" | "hero" | "content" | "cta" | "utility";
    readonly type?: string;
    readonly html: string;
    readonly css: string;
    readonly js: string;
    readonly fields?: readonly ModuleField[];
  };
  /** Human note appended to the tool result (moduleize summary / bind report). */
  readonly note: string;
  readonly css: string;
  readonly kind: "chrome" | "hero" | "content" | "cta" | "utility" | undefined;
  readonly fields: readonly ModuleField[] | undefined;
}

/**
 * Resolve a mint WITHOUT writing: moduleize (when a provider is available)
 * and theme-literal binding turn the caller's HTML into the `modules.create`
 * input. `add_module` (#1246) hands it to `pages.place_module`, which creates
 * the module in the same transaction as its placement and content — so a
 * placement that fails leaves no module behind.
 */
export async function prepareModuleMint(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  args: MintModuleArgs,
): Promise<PreparedMint | MintModuleErr> {
  let html = args.html;
  let fields: readonly ModuleField[] | undefined = args.fieldsHint;
  let displayName = args.displayNameHint;
  let kind = args.kind;
  let description = args.description;
  let note = "";

  // moduleize turns RAW html (no declared fields) into a proper module.
  // It is a FALLBACK for messy human-authored HTML, NOT the canonical AI
  // path (CLAUDE.md §1A): when the AI already authored parametrised HTML
  // plus an explicit `fields[]`, that IS the module — re-moduleizing it
  // is a second AI round-trip that can only do harm. It renamed
  // `{{label}}`'s field to `button_label` and dropped the `>` from the
  // nested `{{>cta}}` marker (live-edit nested-CTA turn: ~20 recovery
  // loops chasing both). So skip moduleize whenever explicit fields are
  // supplied and trust the AI's html + fields verbatim. An explicit EMPTY
  // `fields: []` is authored too — "this module has no fields of its own"
  // (#1186): a consent banner iterating the plugin's
  // `{{#consent_categories}}`, which its skill says to declare no field
  // for, or a divider. Moduleizing it unrolled the plugin loop into
  // hard-coded categories. Power-MCP already treats `[]` this way.
  const hasExplicitFields = args.fieldsHint !== undefined;
  // #741 — on an AI-delegated call (Power-MCP) moduleize would spend the
  // install's AI on what the calling agent is there to author: refuse before
  // anything is written and say exactly what to send. An explicit empty
  // `fields: []` is the agent's statement that the module has no editable
  // content (a divider, a spacer), so it is accepted as authored.
  if (toolCtx.aiDelegated && args.fieldsHint === undefined) {
    return { ok: false, content: DELEGATED_MINT_NEEDS_FIELDS };
  }
  if (toolCtx.provider && !hasExplicitFields && !toolCtx.aiDelegated) {
    try {
      const mod = await moduleize({
        provider: toolCtx.provider,
        html: args.html,
        fieldsHint: args.fieldsHint,
        displayNameHint: args.displayNameHint,
        kindHint: args.kind,
        onRetry: async (r) => {
          // Best-effort telemetry; never fail the mint on a logging hiccup.
          await execute(toolCtx.registry, toolCtx.adapter, ctx, "ai_moduleize.log_attempt", {
            chatSessionId: toolCtx.chatSessionId ?? null,
            inputHtml: r.inputHtml,
            fieldsHint: r.fieldsHint ?? null,
            attempts: r.attempts,
            errors: r.errors,
            outcome: r.outcome,
            finalFields: r.finalFields ?? null,
            model: r.model,
            costMicrocents: 0,
          }).catch(() => {});
        },
        onUsage: async (u) => {
          // The priced spend row (ai_calls) the cost dashboard and the
          // Power-MCP cap read. Best-effort like the chat-runner's own
          // recording: the provider is already paid.
          await execute(toolCtx.registry, toolCtx.adapter, ctx, "chat.record_ai_call", {
            chatSessionId: toolCtx.chatSessionId ?? null,
            provider: toolCtx.provider?.name ?? "unknown",
            model: u.model,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
          }).catch((e: unknown) => {
            console.error("[moduleize] ai_calls row not recorded — spend is understated", {
              model: u.model,
              error: e instanceof Error ? e.message : String(e),
            });
          });
        },
      });
      html = mod.html;
      fields = mod.fields;
      // #1173 — what the caller said about the module wins; moduleize only
      // fills what it left out (its description defaults to "").
      if (displayName.trim().length === 0) displayName = mod.displayName;
      kind ??= mod.kind;
      if (description === undefined || description.trim().length === 0) {
        description = mod.description;
      }
      note = ` (moduleized: ${fields?.length ?? 0} fields)`;
    } catch (e) {
      return {
        ok: false,
        // Nothing was written. The next step must carry the operator's
        // copy across, or a retry "succeeds" with empty placeholders.
        content: `moduleize failed: ${e instanceof Error ? e.message : String(e)}. Nothing was created. Pass the HTML already parametrised ({{field}} placeholders), explicit semantic \`fields[]\`, and the ORIGINAL text/hrefs from the raw HTML as \`values\` (or as each field's \`default\`) — that skips inference, and the copy must not be dropped.`,
      };
    }
  }

  // issue #164 — mechanical theme-token binding on the CSS.
  // issue #430 — ON by default. Opting in was a correction round-trip we
  // asked the AI to make for something we can do ourselves, and the six
  // modules on the dogfood install that hardcoded exact token values are
  // what happens when nobody opts in. Pass `false` for deliberate
  // off-palette values.
  let css = args.css ?? "";
  if (args.bindThemeLiterals !== false && css.length > 0) {
    const bound = await bindCssToTheme(ctx, toolCtx, css);
    css = bound.css;
    note += bound.report;
  }

  return {
    ok: true,
    createInput: {
      slug: slugifyModuleName(displayName),
      displayName,
      ...(description !== undefined ? { description } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(args.type !== undefined ? { type: args.type } : {}),
      html,
      css,
      js: args.js ?? "",
      ...(fields ? { fields } : {}),
    },
    note,
    css,
    kind,
    fields,
  };
}

/**
 * Mint a module from HTML: {@link prepareModuleMint} then `modules.create`.
 * Returns the new module id + slug, or a structured tool error.
 */
export async function mintModuleFromHtml(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  args: MintModuleArgs,
): Promise<MintModuleOk | MintModuleErr> {
  const prepared = await prepareModuleMint(ctx, toolCtx, args);
  if (!prepared.ok) return prepared;
  const created = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    ctx,
    "modules.create",
    prepared.createInput,
  );
  if (!created.ok) {
    return toolError(created.error, `modules.create failed: ${describeError(created.error)}`);
  }
  return {
    ok: true,
    moduleId: (created.value as { moduleId: string }).moduleId,
    slug: prepared.createInput.slug,
    note: prepared.note,
    css: prepared.css,
    kind: prepared.kind,
    fields: prepared.fields,
  };
}
