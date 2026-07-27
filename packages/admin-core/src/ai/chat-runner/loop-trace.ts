// SPDX-License-Identifier: MPL-2.0

/**
 * Per-loop prompt trace — the instrument for "why did this call read tokens
 * fresh instead of from cache?".
 *
 * The existing `[chat-runner] loop` console line already carries the
 * read/write/fresh split, but three things made a real investigation
 * impossible on 2026-07-27:
 *
 *   - it goes to stdout, so restarting the dev server destroys the evidence;
 *   - the context SPLIT (system / tools / history / images) is logged once per
 *     TURN, so a mid-turn change is invisible;
 *   - nothing identifies WHICH part of the prompt changed, so a cache miss
 *     could only be correlated, never located.
 *
 * A turn that read ~993k tokens at full price could not be explained from the
 * database afterwards: its own messages were ~400 tokens. Cache misses are
 * prefix problems, and a prefix problem is only diagnosable if you can diff
 * the prefix.
 *
 * So each record carries per-message fingerprints. Two consecutive records
 * diffed at the first index where their hashes disagree name the exact
 * message that broke the prefix — a dropped image part, a rewritten tool
 * result, a compacted head, an approval resume that reassembled history
 * differently. No guessing.
 *
 * Provider-neutral by construction: it records what the chat-runner assembled,
 * not what any one provider did with it. Prompt caching exists across
 * providers with the same prefix-matching property, so the diagnosis
 * transfers.
 *
 * OFF unless `CAELO_CHAT_TRACE=1`. Content is never written — only lengths,
 * kinds and hashes — so the trace is safe to keep on in a dev session and
 * carries no prompt text, tool arguments or credentials.
 */

import { appendFileSync } from "node:fs";

/** Cheap, stable, non-cryptographic (djb2). Identity, not security. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Identity of any prompt component (the system chunks, the tool array).
 * Serialised then hashed, so a reordering counts as a change — which is
 * exactly right: a reordered prefix is a different prefix to the provider.
 */
export function hashOf(value: unknown): string {
  return hash(typeof value === "string" ? value : JSON.stringify(value));
}

/**
 * The trace file, or null when tracing is off. Mirrors the wire-tap
 * convention (`CAELO_DEBUG_AI_WIRE` + `CAELO_AI_WIRE_LOG`) so there is one
 * way to turn diagnostics on, not two.
 */
export function loopTracePath(): string | null {
  if (process.env.CAELO_CHAT_TRACE !== "1") return null;
  return process.env.CAELO_CHAT_TRACE_LOG ?? "chat-loop-trace.jsonl";
}

/** What one message contributes to the prefix, without its content. */
export interface MessageFingerprint {
  readonly role: string;
  /** Identity of the text content — differs iff the text differs. */
  readonly h: string;
  readonly chars: number;
  /** Image parts riding this message. A dropped image changes this to 0. */
  readonly images: number;
  /** Present only for tool messages, so a re-pairing is visible. */
  readonly toolCallId?: string;
}

export interface LoopTraceRecord {
  readonly chatSessionId: string;
  readonly loop: number;
  /** Identity of the whole system prompt — changes bust everything after it. */
  readonly systemHash: string;
  /** Identity of the tool array — the other whole-prefix invalidator. */
  readonly toolsHash: string;
  readonly toolCount: number;
  readonly messages: readonly MessageFingerprint[];
  readonly totalImageParts: number;
  readonly split: Record<string, number>;
  readonly cache: {
    readonly inThisCall: number;
    readonly read: number;
    readonly write: number;
    readonly fresh: number;
  };
}

/**
 * Append one record. Best-effort by design: a diagnostic that can break a
 * chat turn is worse than no diagnostic, so every failure is swallowed.
 */
export function appendLoopTrace(record: LoopTraceRecord): void {
  const path = loopTracePath();
  if (path === null) return;
  try {
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  } catch {
    // Deliberately silent — see the doc comment above.
  }
}

/** Fingerprint the assembled messages. Reads lengths and kinds, never content. */
export function fingerprintMessages(
  messages: readonly {
    role: string;
    content: string;
    toolCallId?: string;
    additionalContent?: readonly { type: string }[];
  }[],
): { fingerprints: MessageFingerprint[]; totalImageParts: number } {
  let totalImageParts = 0;
  const fingerprints = messages.map((m) => {
    const images = (m.additionalContent ?? []).filter((p) => p.type === "image").length;
    totalImageParts += images;
    return {
      role: m.role,
      h: hash(m.content),
      chars: m.content.length,
      images,
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    };
  });
  return { fingerprints, totalImageParts };
}

/**
 * Locate the first index at which two records' prefixes diverge, or null when
 * the shorter is a clean prefix of the longer (the healthy append-only case).
 * This is the whole point of the trace: a cache miss with `null` here means
 * the messages were fine and the break was in system or tools; a number names
 * the message that did it.
 */
export function firstPrefixDivergence(
  previous: readonly MessageFingerprint[],
  next: readonly MessageFingerprint[],
): number | null {
  const shared = Math.min(previous.length, next.length);
  for (let i = 0; i < shared; i++) {
    const a = previous[i];
    const b = next[i];
    if (!a || !b) return i;
    if (a.h !== b.h || a.role !== b.role || a.images !== b.images) return i;
  }
  return null;
}
