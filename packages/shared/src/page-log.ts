// SPDX-License-Identifier: MPL-2.0

/**
 * issue #264 — the per-page edit LOG: durable, append-only work history so a
 * later chat or a fresh subagent that touches a page knows WHY it was edited,
 * what decisions were taken, and which operator answers shaped it — without
 * dragging the originating chat's full transcript through its context.
 *
 * This is FACT (what happened), not learned BEHAVIOUR — so, unlike
 * `site_ai_memory`, it is ungated: any actor appends directly. The shared
 * Zod schemas here are the single source of truth for the `page_log.append`
 * op input, the `log_page_edit` tool schema, and the `page_log.list` output.
 * `formatPageLogBlock` renders the `## Page log` context block the AI reads
 * before touching a page.
 */

import { z } from "zod";
import type { ActorKind } from "./context.js";

/**
 * The kinds of log entry, in the order the AI should reach for them:
 * - `edited` — a substantive content/module change was made.
 * - `decision` — a design/structure call the AI made and its rationale.
 * - `operator_answer` — an answer the operator gave that shaped the page.
 * - `open_question` — something still unresolved a future turn must settle.
 * - `rebuilt` — the page was rebuilt from scratch (e.g. migration rebuild).
 * - `note` — anything else worth preserving for a future editor.
 */
export const pageLogEntryKinds = [
  "edited",
  "decision",
  "operator_answer",
  "open_question",
  "rebuilt",
  "note",
] as const;

export const pageLogEntryKindSchema = z.enum(pageLogEntryKinds);
export type PageLogEntryKind = (typeof pageLogEntryKinds)[number];

/**
 * Optional structured context beyond the one-line summary — an OBJECT, never
 * a bare scalar or array, so the jsonb column stores queryable keys (chosen
 * option, operator's exact words, affected module ids). Writes go through
 * `jsonbParam()` in the op handler to avoid the double-encode trap (issue
 * #68).
 */
export const pageLogDetailSchema = z.record(z.string(), z.unknown());
export type PageLogDetail = z.infer<typeof pageLogDetailSchema>;

/** Input shape shared by `page_log.append` and the `log_page_edit` tool. */
export const pageLogAppendInputSchema = z
  .object({
    pageId: z.string().uuid(),
    entryKind: pageLogEntryKindSchema,
    summary: z.string().min(1).max(2000),
    detail: pageLogDetailSchema.optional(),
  })
  .strict();
export type PageLogAppendInput = z.infer<typeof pageLogAppendInputSchema>;

/** One row as returned by `page_log.list`. */
export const pageLogEntrySchema = z
  .object({
    id: z.string().uuid(),
    pageId: z.string().uuid(),
    chatSessionId: z.string().uuid().nullable(),
    actorKind: z.enum(["human", "ai", "plugin", "system"]),
    entryKind: pageLogEntryKindSchema,
    summary: z.string(),
    detail: pageLogDetailSchema.nullable(),
    // ISO datetime, not just any string: the value is `created_at` sliced to a
    // date and rendered into the AI context block — a real contract catches
    // drift (a raw pg timestamp, a number) at the op boundary instead of
    // producing a garbled `## Page log` line.
    createdAt: z.string().datetime(),
  })
  .strict();
export type PageLogEntry = z.infer<typeof pageLogEntrySchema>;

const ACTOR_LABEL: Record<ActorKind, string> = {
  human: "operator",
  ai: "AI",
  plugin: "plugin",
  system: "system",
};

/**
 * Render the `## Page log` context block for a single page's recent entries
 * (newest first). Returns `null` when there is nothing to show, so the
 * caller omits the header entirely (CLAUDE.md §11 — render only when
 * non-empty). Kept well under 2 KB: entries are capped and each summary is
 * clamped, because the block rides in the system prompt on every turn that
 * touches the page.
 *
 * @param entries page log rows, expected newest-first (as `page_log.list`
 *   returns them). The renderer does not re-sort.
 */
export function formatPageLogBlock(entries: readonly PageLogEntry[]): string | null {
  if (entries.length === 0) return null;
  // Capped + clamped to stay comfortably under 2 KB: the block rides in the
  // system prompt on every turn that touches the page.
  const MAX_ENTRIES = 8;
  const MAX_SUMMARY = 160;
  const shown = entries.slice(0, MAX_ENTRIES);
  const lines: string[] = [
    "## Page log",
    "",
    "Prior work on THIS page — read it before you change the page so you build on settled decisions instead of re-litigating them. After a meaningful change, append your own entry with `log_page_edit`.",
    "",
  ];
  for (const e of shown) {
    const who = ACTOR_LABEL[e.actorKind] ?? e.actorKind;
    const when = e.createdAt.slice(0, 10);
    const summary =
      e.summary.length > MAX_SUMMARY ? `${e.summary.slice(0, MAX_SUMMARY - 3)}...` : e.summary;
    lines.push(`- [${e.entryKind}] ${summary} (${who}, ${when})`);
  }
  if (entries.length > MAX_ENTRIES) {
    const omitted = entries.length - MAX_ENTRIES;
    lines.push(`- ${omitted} older ${omitted === 1 ? "entry" : "entries"} omitted.`);
  }
  return lines.join("\n");
}
