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
 *   2. pattern-reuse: the mint looks like an existing module but doesn't
 *      reuse its type → point at place mode;
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
import type { ToolContext } from "./dispatch.js";

export interface DesignGuardInput {
  readonly css?: string;
  /** Mint-mode metadata; omit for pure restyles. */
  readonly displayName?: string;
  readonly kind?: string;
  readonly type?: string;
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

  // 2. pattern-reuse for mints that look like a module the site already
  // has. Module rows are the site's real pattern inventory — they carry
  // the display name, kind, type and description the AI wrote when it
  // built them, so nothing has to be re-declared anywhere else.
  if (input.displayName !== undefined) {
    const modsRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.list", {
      includeDeleted: false,
    });
    if (modsRes.ok) {
      // `?? []` — a fake/legacy adapter answering `{}` must read as "no
      // modules", not crash the write path. The guard is a best-effort
      // warning surface; the write it comments on already succeeded.
      const modules =
        (
          modsRes.value as {
            modules?: { displayName: string; kind: string; type: string; description: string }[];
          }
        ).modules ?? [];
      const match = findReusableModule(modules, input);
      if (match) {
        findings.push(
          `this looks like the existing "${match.displayName}" module (type \`${match.type}\`` +
            `${match.description ? `: ${truncate(match.description, 120)}` : ""}) — reuse it ` +
            `(place mode / type: '${match.type}') unless the operator asked for a new variant`,
        );
      }
    }
  }

  if (findings.length === 0) return "";
  return ` 🎯 design-guard: ${findings.join(". ")}.`;
}

interface ModuleRow {
  readonly displayName: string;
  readonly kind: string;
  readonly type: string;
  readonly description: string;
}

/**
 * Find an existing module the mint appears to duplicate: a significant
 * word shared with its display name, and a different `type` (same type
 * IS the reuse we want, so it is not a finding). Kind must match when
 * the caller supplied one — a "hero" and a "content" band that both say
 * "features" are genuinely different things.
 */
function findReusableModule(
  modules: readonly ModuleRow[],
  input: DesignGuardInput,
): ModuleRow | undefined {
  const haystack = `${input.displayName ?? ""} ${input.kind ?? ""}`.toLowerCase();
  for (const m of modules) {
    if (m.type === input.type) continue;
    if (input.kind !== undefined && m.kind !== input.kind) continue;
    const nameHit = m.displayName
      .toLowerCase()
      .split(/\s+/)
      .some((w) => w.length >= 4 && haystack.includes(w));
    if (nameHit) return m;
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
