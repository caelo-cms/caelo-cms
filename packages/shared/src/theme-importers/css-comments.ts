// SPDX-License-Identifier: MPL-2.0

/**
 * Strip `/* … *\/` block comments from a CSS string.
 *
 * The body uses a "tempered dot" (`(?:(?!\*\/)[\s\S])*`) rather than a lazy
 * `[\s\S]*?`: the lazy form backtracks O(n²) on an unterminated comment in
 * untrusted theme CSS (CodeQL js/polynomial-redos). The tempered form has a
 * single unambiguous match path and stops at the first `*\/`, so the output
 * is identical to the lazy form on valid CSS. Single-sourced here so the two
 * theme importers (tailwind, shadcn) cannot drift to a vulnerable variant.
 */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*(?:(?!\*\/)[\s\S])*\*\//g, "");
}
