// SPDX-License-Identifier: MPL-2.0

/**
 * issue #303 — transcript hygiene for system-origin status notes.
 *
 * Two problems observed in run #15:
 *   1. Legacy rows persisted with empty bodies render as a bare
 *      "Status:" label (the append_message boundary now rejects new
 *      ones, but pre-fix rows survive in chat_messages — no migration,
 *      the render side simply drops them).
 *   2. Crawl-wait phases append N near-identical status rows
 *      ("Crawling… 5/50", "Crawling… 12/50", re-posted approval
 *      nudges) where the operator only needs the latest tick.
 *
 * `collapseStatusNotes` is a pure client-side view transform applied
 * right before the transcript `{#each}` — persisted rows are untouched
 * (deliberately: a replace-last-status mechanism server-side would need
 * new DB semantics; CLAUDE.md §2 says snapshots/history stay complete).
 */

import type { ChatMessage } from "./types.js";

/** True when the row renders as a muted "Status:" note (auto-injected
 *  system-origin user rows — crawl nudges, post-approval continuations). */
export function isStatusNote(m: Pick<ChatMessage, "role" | "origin">): boolean {
  return m.role === "user" && m.origin === "system";
}

/**
 * Near-identity key for status-note bodies: two notes that differ only
 * in numbers or ids (crawl progress ticks, proposal/run-id prefixes)
 * are the same status line at two points in time. Hex runs (uuid or
 * 8-char run-id prefixes) collapse first so "proposal 3f9a12bc" and
 * "proposal a0b1c2d3" compare equal; remaining digit runs cover
 * "5/50 pages" vs "12/50 pages".
 */
export function statusNoteKey(content: string): string {
  return content
    .trim()
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f-]{4,})?\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ");
}

/**
 * Collapse CONSECUTIVE near-identical status notes to their last (most
 * recent) entry and drop status notes with empty/whitespace bodies.
 * Any non-status message breaks a run, so distinct statuses separated
 * by AI replies or tool cards all stay visible.
 */
export function collapseStatusNotes(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (!isStatusNote(m)) {
      out.push(m);
      continue;
    }
    // Legacy empty rows: nothing to say → nothing to render (the op
    // boundary rejects new ones; see chat.append_message, issue #303).
    if (m.content.trim().length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && isStatusNote(prev) && statusNoteKey(prev.content) === statusNoteKey(m.content)) {
      // Same status line, newer tick — update in place.
      out[out.length - 1] = m;
      continue;
    }
    out.push(m);
  }
  return out;
}
