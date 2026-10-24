// SPDX-License-Identifier: MPL-2.0

/**
 * `html` with comments and the contents of raw-text elements (script,
 * style, template, noscript, textarea) replaced by spaces of the same
 * length. Scans over the result see only markup a browser would parse as
 * elements, and every offset found in it is the same offset in `html`.
 *
 * @example
 *   blankNonMarkup('<!-- <a href="x"> --><p>y</p>'); // '                     <p>y</p>'
 */
export function blankNonMarkup(html: string): string {
  const blank = (s: string): string => " ".repeat(s.length);
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, blank)
    .replace(
      /(<(script|style|template|noscript|textarea)\b[^>]*>)([\s\S]*?)(<\/\2\s*>|$)/gi,
      (_all, open: string, _tag: string, body: string, close: string) =>
        `${open}${blank(body)}${close}`,
    );
}
