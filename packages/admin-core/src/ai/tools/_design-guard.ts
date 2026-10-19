// SPDX-License-Identifier: MPL-2.0

/**
 * issue #166 — growth-time consistency gate, static tier (epic #149).
 * issue #430 — the gate now reads the state the site already has.
 *
 * Module mints/restyles are checked at write time and findings ride the
 * tool result — the AI fixes divergence in the same turn instead of the
 * operator noticing three pages later. Warning, not gate: the operator
 * can always ask for an intentional break, and the write already
 * succeeded.
 *
 * Why the inputs changed (#430): this used to require a Design Manifest
 * row and returned early when none existed. That row was written by a
 * separate end-of-session tool call which, being pure bookkeeping,
 * never happened — so on the one real install the guard ran on all 18
 * module writes and stayed silent, including for finding 1, which never
 * needed the manifest at all. The inputs are now the state that always
 * exists: the ACTIVE THEME (values + the roles recorded on its tokens)
 * and the MODULE ROWS (which already carry display name, kind, type and
 * description). Nothing to capture first; the guard works on a fresh
 * install and on a migrated one.
 *
 * Three static findings (the VISUAL sibling-compare half lives in the
 * #155 self-review loop — after every restyle the AI screenshots and
 * critiques the render, which inherently compares against the page's
 * surroundings):
 *
 *   1. literal-duplicates-token: css carries literals equal to theme
 *      token values → point at var(--…) / bindThemeLiterals;
 *   2. pattern-reuse (#820): the html is structurally identical or near
 *      to an existing module, or contains one → place / nest it instead
 *      (_markup-guard.ts; replaced a display-name word match that never
 *      looked at the markup and so missed every real copy);
 *   3. roles-in-play: the recorded role of each var this css actually
 *      references, so role misuse is visible in-context.
 */

import { execute } from "@caelo-cms/query-api";
import {
  applyThemeLiteralBinding,
  type ExecutionContext,
  extractCssVarReferences,
  listTokenRoles,
  type ThemeDocument,
} from "@caelo-cms/shared";
import { moduleMarkupFindings } from "./_markup-guard.js";
import type { ToolContext } from "./dispatch.js";

export interface DesignGuardInput {
  readonly css?: string;
  /** The module template written (mint or html edit); omit for pure restyles. */
  readonly html?: string;
  /** The module(s) this write created or edited — never matched against themselves. */
  readonly excludeModuleIds?: readonly string[];
}

/** How many roles-in-play entries to replay before truncating. */
const MAX_ROLES_SHOWN = 6;

/** Suffix for the tool result ("" when there is nothing to report). */
export async function designGuardSuffix(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: DesignGuardInput,
): Promise<string> {
  const findings: string[] = [];

  if (input.css !== undefined && input.css.trim().length > 0) {
    const themeRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.get_active", {});
    if (themeRes.ok) {
      const theme = (themeRes.value as { theme: { tokens: ThemeDocument } | null }).theme;
      if (theme !== null) {
        // 1. literal-duplicates-token. Depends ONLY on the theme, which
        // every install has — this is the finding that was unreachable
        // while the guard required a manifest.
        const bound = applyThemeLiteralBinding(input.css, theme.tokens);
        if (bound.rewrites.length > 0) {
          findings.push(
            `hardcoded literals duplicate theme tokens: ${bound.rewrites
              .map((r) => `${r.from} (=var(${r.to}))`)
              .join(", ")} — reference the var so token edits cascade`,
          );
        }

        // 3. roles-in-play for the vars this css references.
        const roles = listTokenRoles(theme.tokens);
        const inPlay = extractCssVarReferences(input.css)
          .map((r) => r.name)
          .filter((name) => roles[name] !== undefined)
          .slice(0, MAX_ROLES_SHOWN);
        if (inPlay.length > 0) {
          findings.push(
            `token roles in play: ${inPlay.map((n) => `${n} = ${roles[n]}`).join("; ")}`,
          );
        }
      }
    }
  }

  // 2. pattern-reuse: the module rows are the site's real pattern
  // inventory, and their html is what a copy shares with them.
  if (input.html !== undefined) {
    findings.push(
      ...(await moduleMarkupFindings(ctx, toolCtx, input.html, input.excludeModuleIds ?? [])),
    );
  }

  if (findings.length === 0) return "";
  return ` 🎯 design-guard: ${findings.join(". ")}.`;
}
