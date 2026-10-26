// SPDX-License-Identifier: MPL-2.0

/**
 * Common names for theme roles, mapped to the names Caelo's theme emits.
 *
 * Module CSS is authored against conventions the model knows from other
 * design systems: `--color-text`, `--color-surface`, `--color-text-muted`.
 * Caelo's theme calls those roles `--color-foreground`, `--color-background`
 * and `--color-muted-foreground`. The write-time scan used to answer with an
 * edit-distance guess (`--color-text` → "did you mean `--color-accent`?"),
 * so the AI loaded the theme and renamed every reference with edit_content
 * — two to three extra tool calls per module, and a failed one when the
 * same declaration appeared twice (e2e-livedit run 40351690739). A name
 * that unambiguously means a role the theme has is renamed before the
 * write instead, and the tool result says so, the same way theme-literal
 * binding rewrites a literal that equals a token (issue #164). Only names
 * in this table are touched, and only when the theme emits the target.
 */

/** Role name (without `--` and an optional `color-` prefix) → theme role. */
const ROLE_ALIASES: Readonly<Record<string, string>> = {
  text: "foreground",
  "text-primary": "foreground",
  "text-color": "foreground",
  "body-text": "foreground",
  fg: "foreground",
  heading: "foreground",
  "text-muted": "muted-foreground",
  "text-secondary": "muted-foreground",
  "text-subtle": "muted-foreground",
  "muted-text": "muted-foreground",
  "fg-muted": "muted-foreground",
  surface: "background",
  bg: "background",
  "page-bg": "background",
  "body-bg": "background",
  "surface-muted": "muted",
  "surface-alt": "muted",
  "bg-muted": "muted",
  "bg-subtle": "muted",
  "surface-raised": "card",
  "card-bg": "card",
  "border-color": "border",
  divider: "border",
  line: "border",
};

/** The theme var an unknown name stands for, or null. */
export function themeVarForAlias(name: string, knownVars: ReadonlySet<string>): string | null {
  const bare = name.replace(/^--/, "").replace(/^color-/, "");
  const role = ROLE_ALIASES[bare];
  if (role === undefined) return null;
  const target = `--color-${role}`;
  return knownVars.has(target) ? target : null;
}

/** One renamed reference. */
export interface CssVarRename {
  readonly from: string;
  readonly to: string;
  readonly count: number;
}

/**
 * Rename `var(--alias…)` references to the theme's name for that role.
 * A name the CSS itself defines (`--surface: …`) is the author's own
 * property and stays.
 */
export function renameCssVarAliases(
  css: string,
  knownVars: readonly string[],
  definedInCss: ReadonlySet<string>,
): { css: string; renames: CssVarRename[] } {
  const known = new Set(knownVars);
  const renames: CssVarRename[] = [];
  let out = css;
  const names = new Set([...css.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map((m) => m[1] ?? ""));
  for (const name of names) {
    if (known.has(name) || definedInCss.has(name)) continue;
    const to = themeVarForAlias(name, known);
    if (to === null) continue;
    const re = new RegExp(`(var\\(\\s*)${name.replace(/[-]/g, "\\-")}(?![a-zA-Z0-9_-])`, "g");
    let count = 0;
    out = out.replace(re, (_m, open: string) => {
      count += 1;
      return `${open}${to}`;
    });
    if (count > 0) renames.push({ from: name, to, count });
  }
  return { css: out, renames };
}

/** Tool-result sentence for the renames, or null. */
export function formatCssVarRenameReport(renames: readonly CssVarRename[]): string | null {
  if (renames.length === 0) return null;
  return ` 🔗 renamed to the theme's names: ${renames
    .map((r) => `${r.from}→${r.to}${r.count > 1 ? `×${r.count}` : ""}`)
    .join(
      ", ",
    )} — the STORED css uses the theme's names, so anchor later edit_content calls on those.`;
}
