// SPDX-License-Identifier: MPL-2.0

/**
 * Cut text for the AI without ever cutting an id in half.
 *
 * #1089 / #1094 — the model called tools with UUIDs one character short
 * (`c9c7ddcb-cc85-4747-84f-90967da6f769`). Every place that shortens text
 * the AI reads (compacted tool results, digests, previews, capped finding
 * messages) used a plain `slice(0, n)`, so an id straddling the cut reached
 * the model as a fragment it then "completed" from memory. An id is copied,
 * never reconstructed: the cut moves back to just before an id it would
 * split, so an id is either shown whole or not at all.
 */

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The largest index `<= at` at which `text` can be cut without splitting
 * a UUID.
 *
 * @param at - the desired cut index (characters kept).
 */
export function idSafeCutIndex(text: string, at: number): number {
  if (at <= 0) return 0;
  if (at >= text.length) return text.length;
  // Only an id that could reach the cut matters: scan a window around it.
  const from = Math.max(0, at - 36);
  const window = text.slice(from, at + 36);
  for (const m of window.matchAll(UUID_PATTERN)) {
    const start = from + (m.index ?? 0);
    const end = start + m[0].length;
    if (start < at && at < end) return start;
  }
  return at;
}

/**
 * `text` cut to at most `max` characters (the suffix included) without
 * splitting a UUID; unchanged when it already fits.
 *
 * @param suffix - appended when cut (default `…`).
 */
export function truncateKeepingIds(text: string, max: number, suffix = "…"): string {
  if (text.length <= max) return text;
  return `${text.slice(0, idSafeCutIndex(text, Math.max(0, max - suffix.length)))}${suffix}`;
}
