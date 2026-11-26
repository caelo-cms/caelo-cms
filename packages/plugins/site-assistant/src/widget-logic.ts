// SPDX-License-Identifier: MPL-2.0

/**
 * The site assistant widget's logic without the DOM (issue #1655): reading
 * the gateway's event stream, keeping the signed history per tab within the
 * conversation's turns, checking a question against its length, and turning
 * an answer's `[n]` citations into links — only to the sources the gateway
 * sent, never to anything the answer's text contains.
 *
 * Each function is self-contained (it names no import and no other
 * module-level value but the ones listed in {@link WIDGET_LOGIC}) because
 * runtime.ts puts their source text into the browser script: the unit tests
 * run exactly the code visitors' browsers run. Every check on visitor text
 * is a single linear pass (indexOf), never a backtracking pattern.
 */

/** One server-sent event. */
export interface SseEvent {
  readonly event: string;
  readonly data: unknown;
}

/**
 * Splits the received text into complete events and the unfinished rest.
 * An event is `event: <name>` and `data: <json>` lines ended by a blank
 * line; one whose data is not JSON is skipped.
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let at = 0;
  for (;;) {
    const end = buffer.indexOf("\n\n", at);
    if (end === -1) break;
    const block = buffer.slice(at, end);
    at = end + 2;
    let name = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.indexOf("event: ") === 0) name = line.slice(7).trim();
      else if (line.indexOf("data: ") === 0) data += line.slice(6);
    }
    if (data === "") continue;
    try {
      events.push({ event: name, data: JSON.parse(data) });
    } catch (_) {
      // Not JSON: not ours.
    }
  }
  return { events, rest: buffer.slice(at) };
}

/**
 * The question as it is sent: trimmed, or null when it is empty or longer
 * than `maxChars` (the gateway would refuse it).
 */
export function checkQuestion(text: string, maxChars: number): string | null {
  const q = String(text == null ? "" : text).trim();
  if (q === "" || q.length > maxChars) return null;
  return q;
}

/** The history after one more answered turn: the signed turns in order. */
export function appendTurn(history: readonly string[], turn: string): string[] {
  if (typeof turn !== "string" || turn === "" || turn.indexOf(".") === -1) return history.slice();
  return history.concat([turn]);
}

/** Whether the conversation has used its questions (the gateway refuses the next one). */
export function conversationFull(history: readonly string[], maxTurns: number): boolean {
  return history.length >= maxTurns;
}

/** One source of an answer, as the gateway sent it. */
export interface WidgetSource {
  readonly n: number;
  readonly url: string;
  readonly title: string;
  readonly anchor: string | null;
  readonly cited: boolean;
}

/** A piece of an answer: plain text, or a citation linked to its source. */
export type AnswerPart =
  | { readonly text: string }
  | { readonly cite: number; readonly href: string; readonly title: string };

/**
 * A source's link: a path on this site (the gateway checked it, the widget
 * checks again) with the section's anchor; null for anything else.
 */
export function sourceHref(source: WidgetSource): string | null {
  const url = source && typeof source.url === "string" ? source.url : "";
  if (url.charAt(0) !== "/" || url.charAt(1) === "/" || url.length > 500) return null;
  for (let i = 0; i < url.length; i++) {
    const c = url.charAt(i);
    if (c === " " || c === "<" || c === ">" || c === '"' || c === "'" || c === "\\") return null;
  }
  const anchor = source.anchor;
  if (typeof anchor === "string" && anchor !== "") {
    for (let i = 0; i < anchor.length; i++) {
      const c = anchor.charAt(i);
      const ok =
        (c >= "a" && c <= "z") ||
        (c >= "A" && c <= "Z") ||
        (c >= "0" && c <= "9") ||
        c === "-" ||
        c === "_";
      if (!ok) return url;
    }
    return url + "#" + anchor;
  }
  return url;
}

/**
 * The answer as text and citations: `[n]` becomes a link when source `n`
 * exists and has a usable link; anything else stays text. The answer's own
 * text never becomes markup.
 */
export function answerParts(text: string, sources: readonly WidgetSource[]): AnswerPart[] {
  const byN: Record<string, WidgetSource> = {};
  for (const s of sources || []) byN[String(s.n)] = s;
  const out: AnswerPart[] = [];
  const s = String(text == null ? "" : text);
  let at = 0;
  let plain = "";
  while (at < s.length) {
    const open = s.indexOf("[", at);
    if (open === -1) break;
    const close = s.indexOf("]", open + 1);
    const inner = close === -1 ? "" : s.slice(open + 1, close);
    const isNumber =
      inner.length > 0 &&
      inner.length <= 2 &&
      inner.charAt(0) >= "0" &&
      inner.charAt(0) <= "9" &&
      (inner.length === 1 || (inner.charAt(1) >= "0" && inner.charAt(1) <= "9"));
    const source = isNumber ? byN[inner] : undefined;
    const href = source ? sourceHref(source) : null;
    if (source && href) {
      plain += s.slice(at, open);
      if (plain !== "") out.push({ text: plain });
      plain = "";
      out.push({ cite: source.n, href: href, title: source.title || href });
      at = close + 1;
    } else {
      plain += s.slice(at, open + 1);
      at = open + 1;
    }
  }
  plain += s.slice(at);
  if (plain !== "") out.push({ text: plain });
  return out;
}

/** Whether an answer stands on a source: the feedback calls one without any unanswered. */
export function answered(sources: readonly WidgetSource[]): boolean {
  for (const s of sources || []) if (s.cited && sourceHref(s) !== null) return true;
  return false;
}

/**
 * #1701 — the search query the inline answer asks: the fragment's `q`
 * (`#q=…`, site-search's hash mode, #1707) when the fragment has one,
 * else the query string's `q`. `anchor` says the fragment is something
 * else (a skip link): a `hashchange` to it asks nothing. The same reading
 * as site-search's runtime, so the answer and the results always show the
 * same query.
 */
export function searchQueryOf(search: string, hash: string): { query: string; anchor: boolean } {
  const fragment =
    String(hash || "").charAt(0) === "#" ? String(hash).slice(1) : String(hash || "");
  if (fragment !== "") {
    const fromHash = new URLSearchParams(fragment);
    if (fromHash.has("q")) return { query: String(fromHash.get("q") || "").trim(), anchor: false };
  }
  const fromSearch = new URLSearchParams(String(search || ""));
  return { query: String(fromSearch.get("q") || "").trim(), anchor: fragment !== "" };
}

/** The functions runtime.ts ships, in dependency order. */
export const WIDGET_LOGIC = [
  parseSse,
  checkQuestion,
  appendTurn,
  conversationFull,
  sourceHref,
  answerParts,
  answered,
  searchQueryOf,
] as const;
