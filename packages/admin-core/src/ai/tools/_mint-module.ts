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
import { describeError } from "./_describe-error.js";
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
}
export interface MintModuleErr {
  readonly ok: false;
  readonly content: string;
}

/**
 * Mint a module from HTML: moduleize (when a provider is available) → create.
 * Returns the new module id + slug, or a structured tool error.
 */
export async function mintModuleFromHtml(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  args: MintModuleArgs,
): Promise<MintModuleOk | MintModuleErr> {
  let html = args.html;
  let fields: readonly ModuleField[] | undefined = args.fieldsHint;
  let displayName = args.displayNameHint;
  let kind = args.kind;
  let description = args.description;
  let note = "";

  // Preferred path: moduleize turns raw html into a proper module.
  if (toolCtx.provider) {
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
      });
      html = mod.html;
      fields = mod.fields;
      displayName = mod.displayName;
      kind = mod.kind;
      description = mod.description;
      note = ` (moduleized: ${fields?.length ?? 0} fields)`;
    } catch (e) {
      return {
        ok: false,
        content: `moduleize failed: ${e instanceof Error ? e.message : String(e)}. Retry, or pass explicit fields[] to skip inference.`,
      };
    }
  }

  // issue #164 — opt-in mechanical theme-token binding on the CSS.
  let css = args.css ?? "";
  if (args.bindThemeLiterals === true && css.length > 0) {
    const bound = await bindCssToTheme(ctx, toolCtx, css);
    css = bound.css;
    note += bound.report;
  }

  const slug = slugifyModuleName(displayName);
  const created = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.create", {
    slug,
    displayName,
    ...(description !== undefined ? { description } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(args.type !== undefined ? { type: args.type } : {}),
    html,
    css,
    js: args.js ?? "",
    ...(fields ? { fields } : {}),
  });
  if (!created.ok) {
    return { ok: false, content: `modules.create failed: ${describeError(created.error)}` };
  }
  return {
    ok: true,
    moduleId: (created.value as { moduleId: string }).moduleId,
    slug,
    note,
    css,
    kind,
  };
}
