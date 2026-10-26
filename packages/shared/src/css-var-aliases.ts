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

/** `var(` + the referenced name, when the name ends there. */
const VAR_NAME_RE = /(var\(\s*)(--[a-zA-Z0-9_-]+)(?![a-zA-Z0-9_-])/g;

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
  const targets = new Map<string, string>();
  const counts = new Map<string, number>();
  // One pass over the references, no pattern built from a name.
  const out = css.replace(VAR_NAME_RE, (match, open: string, name: string) => {
    if (known.has(name) || definedInCss.has(name)) return match;
    let to = targets.get(name);
    if (to === undefined) {
      const resolved = themeVarForAlias(name, known);
      if (resolved === null) return match;
      to = resolved;
      targets.set(name, to);
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
    return `${open}${to}`;
  });
  const renames: CssVarRename[] = [...targets].map(([from, to]) => ({
    from,
    to,
    count: counts.get(from) ?? 0,
  }));
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
