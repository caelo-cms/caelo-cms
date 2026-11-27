// SPDX-License-Identifier: MPL-2.0

/**
 * The tokens of a stylesheet as a browser reads them (CSS Syntax Level 3,
 * §4), for the checks that keep a plugin's CSS from loading anything
 * (`client-assets.ts`). Only what those checks need is told apart: names,
 * functions, at-keywords, strings and url tokens, with every escape
 * decoded the way the browser decodes it; everything else is a delimiter.
 *
 * Why a tokenizer and not regexes over the text: a comment exists only
 * between tokens (`content:"/*"` opens none), and an escape is read once,
 * left to right (`\\e` is a backslash and an `e`, not `\` and the code
 * point U+000E). A pass that strips comments or decodes escapes before
 * the rules read the text gets both wrong, and either mistake hides a URL.
 *
 * One deliberate difference: a comment that never closes is read as CSS,
 * not dropped to the end, so what it holds is still checked. Every scan
 * is linear in the stylesheet's length.
 */

/** One token of a stylesheet. `function` is a name directly followed by `(`. */
export type CssToken =
  | { readonly kind: "ident"; readonly value: string }
  | { readonly kind: "function"; readonly name: string }
  | { readonly kind: "at"; readonly name: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "url"; readonly value: string; readonly bad: boolean }
  | { readonly kind: "number" }
  | { readonly kind: "ws" }
  | { readonly kind: "delim"; readonly value: string };

const NUMBER = /[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const HEX = /[0-9a-fA-F]{1,6}/y;

const isWhitespace = (c: string | undefined) => c === " " || c === "\t" || c === "\n";
const isNameStart = (c: string | undefined) =>
  c !== undefined && (/[a-zA-Z_]/.test(c) || c.charCodeAt(0) >= 0x80);
const isName = (c: string | undefined) => isNameStart(c) || (c !== undefined && /[0-9-]/.test(c));
const isNonPrintable = (c: string) => {
  const code = c.charCodeAt(0);
  return code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
};

/** Every token of `css`, in order (comments dropped, except unclosed ones; see the file note). */
export function cssTokens(css: string): CssToken[] {
  // §3.3: CR, CRLF and FF read as LF; NUL as U+FFFD.
  const s = css.replace(/\r\n?|\f/g, "\n").replace(/\0/g, "�");
  const out: CssToken[] = [];
  let i = 0;
  // Once no `*/` follows some position, none follows any later one.
  let noCommentClose = false;

  const validEscape = (at: number) => s[at] === "\\" && s[at + 1] !== "\n";
  const startsIdent = (at: number) => {
    if (s[at] === "-") return isNameStart(s[at + 1]) || s[at + 1] === "-" || validEscape(at + 1);
    return isNameStart(s[at]) || validEscape(at);
  };
  /** §4.3.7, `at` just past the backslash: the code point and where reading goes on. */
  const escaped = (at: number): [string, number] => {
    if (at >= s.length) return ["�", at];
    HEX.lastIndex = at;
    const hex = HEX.exec(s)?.[0];
    if (hex === undefined) {
      const cp = s.codePointAt(at) as number;
      const ch = String.fromCodePoint(cp);
      return [ch, at + ch.length];
    }
    let next = at + hex.length;
    if (isWhitespace(s[next])) next += 1;
    const cp = Number.parseInt(hex, 16);
    const valid = cp !== 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);
    return [valid ? String.fromCodePoint(cp) : "�", next];
  };
  /** §4.3.11: a name, escapes decoded. */
  const name = (at: number): [string, number] => {
    let value = "";
    let j = at;
    for (;;) {
      if (isName(s[j])) {
        value += s[j];
        j += 1;
      } else if (validEscape(j)) {
        const [ch, next] = escaped(j + 1);
        value += ch;
        j = next;
      } else return [value, j];
    }
  };
  /** §4.3.6, `at` just past the opening quote. */
  const string = (at: number, quote: string): [string, number] => {
    let value = "";
    let j = at;
    for (;;) {
      const c = s[j];
      if (c === undefined) return [value, j];
      if (c === quote) return [value, j + 1];
      // A newline ends a bad string; the browser drops it, the checks read it as written.
      if (c === "\n") return [value, j];
      if (c === "\\") {
        if (j + 1 >= s.length) return [value, j + 1];
        if (s[j + 1] === "\n") {
          j += 2;
          continue;
        }
        const [ch, next] = escaped(j + 1);
        value += ch;
        j = next;
        continue;
      }
      value += c;
      j += 1;
    }
  };
  /** §4.3.14 + §4.3.6: the rest of a bad url, up to its `)`. */
  const badUrlRest = (at: number): number => {
    let j = at;
    while (j < s.length) {
      if (s[j] === ")") return j + 1;
      if (validEscape(j)) j = escaped(j + 1)[1];
      else j += 1;
    }
    return j;
  };
  /** §4.3.6, `at` just past `url(`. */
  const url = (at: number): [CssToken, number] => {
    let j = at;
    while (isWhitespace(s[j])) j += 1;
    let value = "";
    for (;;) {
      const c = s[j];
      if (c === undefined) return [{ kind: "url", value, bad: false }, j];
      if (c === ")") return [{ kind: "url", value, bad: false }, j + 1];
      if (isWhitespace(c)) {
        while (isWhitespace(s[j])) j += 1;
        if (s[j] === undefined) return [{ kind: "url", value, bad: false }, j];
        if (s[j] === ")") return [{ kind: "url", value, bad: false }, j + 1];
        return [{ kind: "url", value, bad: true }, badUrlRest(j)];
      }
      if (c === '"' || c === "'" || c === "(" || isNonPrintable(c)) {
        return [{ kind: "url", value, bad: true }, badUrlRest(j)];
      }
      if (c === "\\") {
        if (!validEscape(j)) return [{ kind: "url", value, bad: true }, badUrlRest(j)];
        const [ch, next] = escaped(j + 1);
        value += ch;
        j = next;
        continue;
      }
      value += c;
      j += 1;
    }
  };
  /** §4.3.4: a name, a function, or `url(`. */
  const identLike = (at: number): [CssToken, number] => {
    const [value, j] = name(at);
    if (value.toLowerCase() === "url" && s[j] === "(") {
      let k = j + 1;
      while (isWhitespace(s[k]) && isWhitespace(s[k + 1])) k += 1;
      const q = isWhitespace(s[k]) ? s[k + 1] : s[k];
      if (q === '"' || q === "'") return [{ kind: "function", name: value }, k];
      return url(k);
    }
    if (s[j] === "(") return [{ kind: "function", name: value }, j + 1];
    return [{ kind: "ident", value }, j];
  };

  while (i < s.length) {
    const c = s[i] as string;
    if (c === "/" && s[i + 1] === "*" && !noCommentClose) {
      const close = s.indexOf("*/", i + 2);
      if (close !== -1) {
        i = close + 2;
        continue;
      }
      noCommentClose = true;
    }
    if (isWhitespace(c)) {
      while (isWhitespace(s[i])) i += 1;
      out.push({ kind: "ws" });
      continue;
    }
    if (c === '"' || c === "'") {
      const [value, next] = string(i + 1, c);
      out.push({ kind: "string", value });
      i = next;
      continue;
    }
    NUMBER.lastIndex = i;
    const number = /[0-9.+-]/.test(c) ? NUMBER.exec(s) : null;
    if (number !== null) {
      i += number[0].length;
      if (startsIdent(i)) i = name(i)[1];
      else if (s[i] === "%") i += 1;
      out.push({ kind: "number" });
      continue;
    }
    if (c === "@" && startsIdent(i + 1)) {
      const [value, next] = name(i + 1);
      out.push({ kind: "at", name: value });
      i = next;
      continue;
    }
    if (startsIdent(i)) {
      const [token, next] = identLike(i);
      out.push(token);
      i = next;
      continue;
    }
    const cp = s.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    out.push({ kind: "delim", value: ch });
    i += ch.length;
  }
  return out;
}
