// SPDX-License-Identifier: MPL-2.0

/**
 * Escapes for CSS and JS that the composer places inside `<style>` /
 * `<script>` elements. The HTML tokenizer ends those elements at the first
 * `</style` / `</script` (ASCII case-insensitive), wherever it sits in the
 * CSS or JS, so unescaped text there would end the element and put the
 * rest into the document as markup — into `<head>` for CSS, which the
 * structured-head invariant forbids.
 */

const STYLE_CLOSE_RE = /<\/style/gi;

/**
 * CSS safe to place between `<style>` and `</style>`. `<\/style` means
 * what `</style` means wherever CSS can hold that sequence (strings,
 * `url()`, comments — `\/` is an escaped `/`), so the CSS is unchanged.
 */
export function escapeStyleText(css: string): string {
  return css.replace(STYLE_CLOSE_RE, (m) => `<\\${m.slice(1)}`);
}

/**
 * Whether `js` cannot be placed verbatim inside a `<script>` element:
 * a `</script` would end it, and a `<!--` switches the tokenizer into
 * script-data escaping where a nested `<script` keeps the real `</script>`
 * from ending it. No textual rewrite keeps every JavaScript program's
 * meaning (regex literals and `String.raw` observe an inserted
 * backslash), so callers that hit this ship the bytes encoded instead.
 */
export function scriptNeedsEncoding(js: string): boolean {
  return /<\/script|<!--/i.test(js);
}

/** Standard base64 of `text`'s UTF-8 bytes (browser- and Bun-safe, no Buffer). */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
