// SPDX-License-Identifier: MPL-2.0

/**
 * issue #166 — growth-time consistency gate, static tier (epic #149).
 *
 * When a Design Manifest exists, module mints/restyles are checked
 * against it at write time and findings ride the tool result — the AI
 * fixes divergence in the same turn instead of the operator noticing
 * three pages later. Warning, not gate: the operator can always ask
 * for an intentional break, and the write already succeeded.
 *
 * Three static findings (the VISUAL sibling-compare half lives in the
 * #155 self-review loop — after every restyle the AI screenshots and
 * critiques the render, which inherently compares against the page's
 * surroundings):
 *
 *   1. literal-duplicates-token: css carries literals equal to theme
 *      token values → point at var(--…) / bindThemeLiterals;
 *   2. pattern-reuse: the mint looks like an existing manifest pattern
 *      but doesn't use its module type → point at place mode;
 *   3. roles-in-play: the manifest's usage semantics for the vars this
 *      css actually references, so role misuse is visible in-context.
 */

import { execute } from "@caelo-cms/query-api";
import {
  applyThemeLiteralBinding,
  type DesignManifest,
  type ExecutionContext,
  extractCssVarReferences,
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

/** Suffix for the tool result ("" when the manifest is absent or clean). */
export async function designGuardSuffix(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: DesignGuardInput,
): Promise<string> {
  const manifestRes = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    ctx,
    "design_manifest.get",
    {},
  );
  if (!manifestRes.ok) return "";
  const manifest = (manifestRes.value as { manifest?: DesignManifest | null }).manifest;
  // == null covers undefined too — a fake/legacy adapter answering {}
  // must read as "no manifest", not crash the write path.
  if (manifest == null) return "";

  const findings: string[] = [];

  // 1. literal-duplicates-token (needs the active theme).
  if (input.css !== undefined && input.css.trim().length > 0) {
    const themeRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.get_active", {});
    if (themeRes.ok) {
      const theme = (themeRes.value as { theme: { tokens: ThemeDocument } | null }).theme;
      if (theme !== null) {
        const bound = applyThemeLiteralBinding(input.css, theme.tokens);
        if (bound.rewrites.length > 0) {
          findings.push(
            `hardcoded literals duplicate theme tokens: ${bound.rewrites
              .map((r) => `${r.from} (=var(${r.to}))`)
              .join(", ")} — reference the var or pass \`bindThemeLiterals: true\``,
          );
        }
      }
    }

    // 3. roles-in-play for the vars this css references.
    const roles = manifest.tokenRoles ?? {};
    const inPlay = extractCssVarReferences(input.css)
      .map((r) => r.name)
      .filter((name) => roles[name] !== undefined)
      .slice(0, 6);
    if (inPlay.length > 0) {
      findings.push(`token roles in play: ${inPlay.map((n) => `${n} = ${roles[n]}`).join("; ")}`);
    }
  }

  // 2. pattern-reuse for mints that look like an established pattern.
  if (input.displayName !== undefined && manifest.patterns) {
    const haystack = `${input.displayName} ${input.kind ?? ""}`.toLowerCase();
    for (const p of manifest.patterns) {
      if (p.moduleType === undefined || p.moduleType === input.type) continue;
      const nameHit = p.name
        .toLowerCase()
        .split(/\s+/)
        .some((w) => w.length >= 3 && haystack.includes(w));
      if (nameHit) {
        findings.push(
          `this looks like the manifest's "${p.name}" pattern, which module type \`${p.moduleType}\` implements — reuse it (place mode / type: '${p.moduleType}') unless the operator asked for a new variant`,
        );
        break;
      }
    }
  }

  if (findings.length === 0) return "";
  return ` 🎯 design-guard: ${findings.join(". ")}.`;
}
