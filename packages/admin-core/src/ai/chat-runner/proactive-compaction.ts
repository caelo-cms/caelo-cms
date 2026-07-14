// SPDX-License-Identifier: MPL-2.0

/**
 * issue #300 part B — PROACTIVE per-loop tool-result compaction.
 *
 * Run #15 evidence: tool results carrying full HTML bodies stay
 * verbatim in the in-memory history for the rest of the turn, so loop
 * 24 of a build turn costs ~5× loop 0 (~556K vs ~103K input tokens).
 * Once the model has ACTED on a successful result, its full body has
 * near-zero decision value — a one-line summary (leading ok line + key
 * identifiers) is enough to keep the trail legible.
 *
 * This COMPOSES with issue #261's ceiling-triggered compaction rather
 * than duplicating it: the proactive pass runs at the top of every
 * loop iteration BEFORE the #261 pre-flight estimate, so turns shrink
 * continuously and rarely approach the ceiling at all. Both passes end
 * a shortened result with the same `[truncated: N chars]` marker
 * (exported from compaction.ts), and each pass skips results the
 * other already cut.
 *
 * Never compacted:
 *   - FAILED results — the model may still need the full error body to
 *     change approach (and the repeat-failure breaker matches on it);
 *   - results from the current or previous loop — the model is likely
 *     still reasoning over them;
 *   - results already carrying the truncation marker (#261 or an
 *     earlier proactive pass);
 *   - results that predate the current turn — this module only sees
 *     tool results the CURRENT turn dispatched (via the origins map
 *     keyed by toolCallId); prior-turn history stays #261's job.
 *
 * Persistence: full result bodies are persisted to chat_messages at
 * dispatch time (tool-dispatch.ts), BEFORE any proactive pass runs.
 * Everything here is pure and touches only the in-memory provider
 * history — the stored transcript stays complete, and the next turn
 * rebuilds its history from the DB untouched.
 */

import type { ChatMessageInput } from "../provider.js";
import { hasTruncationMarker, truncationMarker } from "./compaction.js";

/**
 * A tool result becomes compactable once it is at least this many
 * loops old (currentLoop - originLoop >= N). Default 3: a result rides
 * verbatim into the two provider calls after the one that produced it,
 * then shrinks. Values below 2 are clamped to 2 — the current and the
 * previous loop's results are protected unconditionally.
 */
export const PROACTIVE_TOOL_RESULT_MIN_AGE_LOOPS = 3;

/**
 * Results at or under this many chars are never compacted — the
 * summary + marker would save little, and short results are usually
 * already one-line confirmations.
 */
export const PROACTIVE_TOOL_RESULT_MIN_CHARS = 2000;

/** Chars of the leading line kept as the summary head. */
const SUMMARY_HEAD_CHARS = 300;

/** Cap on extracted key identifiers appended below the head. */
const MAX_KEY_IDENTIFIERS = 8;

/** Where a current-turn tool result came from: which loop, and whether it succeeded. */
export interface ToolResultOrigin {
  readonly loop: number;
  readonly ok: boolean;
}

export interface ProactiveCompactionOptions {
  /** The loop iteration about to call the provider. */
  readonly currentLoop: number;
  /** toolCallId → origin, for results dispatched by the CURRENT turn only. */
  readonly origins: ReadonlyMap<string, ToolResultOrigin>;
  /** Override for tests; defaults to {@link PROACTIVE_TOOL_RESULT_MIN_AGE_LOOPS}. */
  readonly minAgeLoops?: number;
  /** Override for tests; defaults to {@link PROACTIVE_TOOL_RESULT_MIN_CHARS}. */
  readonly minChars?: number;
}

/**
 * The age/size/never-compact predicate, exported for direct unit
 * testing. True only for successful, old-enough, large-enough,
 * not-yet-truncated results.
 */
export function shouldCompactToolResult(args: {
  content: string;
  ok: boolean;
  originLoop: number;
  currentLoop: number;
  minAgeLoops?: number;
  minChars?: number;
}): boolean {
  if (!args.ok) return false;
  // Clamp the floor at 2 so "never the current or previous loop" holds
  // even if a caller passes a smaller override.
  const minAge = Math.max(args.minAgeLoops ?? PROACTIVE_TOOL_RESULT_MIN_AGE_LOOPS, 2);
  if (args.currentLoop - args.originLoop < minAge) return false;
  if (args.content.length <= (args.minChars ?? PROACTIVE_TOOL_RESULT_MIN_CHARS)) return false;
  if (hasTruncationMarker(args.content)) return false;
  return true;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NAMED_ID_RE =
  /"(?:id|pageId|moduleId|contentInstanceId|templateId|layoutId|slug)"\s*:\s*"([^"]{1,80})"/g;

/**
 * Pull identifier-ish values (UUIDs + common id/slug JSON fields) out
 * of the full body so the summary keeps everything a later tool call
 * might reference, even when those ids sat deep in an HTML dump.
 * Values already visible in the kept head are skipped.
 */
function extractKeyIdentifiers(content: string, head: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (v: string): void => {
    if (seen.has(v) || head.includes(v)) return;
    seen.add(v);
    if (out.length < MAX_KEY_IDENTIFIERS) out.push(v);
  };
  for (const m of content.matchAll(NAMED_ID_RE)) {
    const v = m[1];
    if (v) push(v);
  }
  for (const m of content.matchAll(UUID_RE)) push(m[0]);
  return out;
}

/**
 * One-line summary of a successful tool result: the leading line
 * (capped), extracted key identifiers, and the shared truncation
 * marker recording how many chars of the original were dropped.
 */
export function summarizeToolResult(content: string): string {
  const firstLine = content.split("\n", 1)[0] ?? "";
  const head =
    firstLine.length > SUMMARY_HEAD_CHARS ? firstLine.slice(0, SUMMARY_HEAD_CHARS) : firstLine;
  const ids = extractKeyIdentifiers(content, head);
  const summary = ids.length > 0 ? `${head}\n[key ids: ${ids.join(", ")}]` : head;
  return `${summary}${truncationMarker(content.length - head.length)}`;
}

export interface ProactiveCompactionResult {
  readonly messages: ChatMessageInput[];
  /** Number of tool results replaced by summaries in this pass. */
  readonly compacted: number;
  /** Total chars removed from the provider-bound history. */
  readonly charsSaved: number;
}

/**
 * Replace eligible current-turn tool results with one-line summaries.
 * Pure — returns a new array (input untouched); messages whose
 * toolCallId is absent from `origins` (prior-turn results, non-tool
 * messages) pass through by reference.
 */
export function compactOldToolResults(
  messages: readonly ChatMessageInput[],
  opts: ProactiveCompactionOptions,
): ProactiveCompactionResult {
  let compacted = 0;
  let charsSaved = 0;
  const out = messages.map((m): ChatMessageInput => {
    if (m.role !== "tool" || m.toolCallId === undefined) return m;
    const origin = opts.origins.get(m.toolCallId);
    if (!origin) return m;
    const eligible = shouldCompactToolResult({
      content: m.content,
      ok: origin.ok,
      originLoop: origin.loop,
      currentLoop: opts.currentLoop,
      ...(opts.minAgeLoops !== undefined ? { minAgeLoops: opts.minAgeLoops } : {}),
      ...(opts.minChars !== undefined ? { minChars: opts.minChars } : {}),
    });
    if (!eligible) return m;
    const summary = summarizeToolResult(m.content);
    // A pathological head longer than the body would grow the message;
    // never "compact" into something bigger.
    if (summary.length >= m.content.length) return m;
    compacted++;
    charsSaved += m.content.length - summary.length;
    return { ...m, content: summary };
  });
  return { messages: out, compacted, charsSaved };
}
