// SPDX-License-Identifier: MPL-2.0

/**
 * Turn-completion diagnostics (the v0.10.x empty-response hunt).
 *
 * This file used to also carry the issue-#106 "passive turn" nudge: a regex
 * classifier plus a synthetic `role:"user"` message injected into the replay
 * when the model narrated an action and ended the turn without emitting the
 * tool call. That whole mechanism is gone (see `write-tools.ts` +
 * `system-prompt.ts` for what replaced it). It was removed because it was the
 * wrong shape three times over:
 *
 *   - it classified INTENT from prose with an English-only regex, in a product
 *     whose operators write German — a legitimate German stop that doesn't end
 *     in "?" was nudged, and an announced action phrased outside the verb list
 *     was not;
 *   - it injected a fake user turn, the parallel-format antipattern CLAUDE.md
 *     §12 warns about (the provider docs are explicit that a synthetic
 *     "Continue." message is NOT how a turn is resumed);
 *   - it was gated to `loop === 0`, a proxy for "hasn't acted yet" that stopped
 *     being true once progressive-disclosure skills made `load_skill` consume
 *     loop 0 — so from 2026-07-19 the guard silently never fired.
 *
 * The replacement is three layers: PREVENT (an end-of-turn self-check in the
 * system prompt), DETECT (`turnHasWritten` in loop.ts — structural, not
 * textual), RECOVER (a bounded `toolChoice: "required"` re-run — the
 * API-native way to require an action, instead of asking for one in prose).
 */

import type { ClientEvent, StoppingDiagnostics } from "./types.js";

/**
 * v0.10.16/.17/.21 — loop-0 zero-tool diagnostics. Called only when
 * `loop === 0 && toolCalls === 0 && loopStop === "end_turn" && !aborted`.
 * Logs provider-side stop metadata to stderr and, for the genuinely-empty
 * case (0 text + 0 thinking), returns a user-facing warning event; otherwise
 * returns null (the text-only-but-no-tools case is stderr-only by design).
 */
export function evaluateLoopZeroDiagnostics(args: {
  chatSessionId: string;
  accumulatedText: string[];
  accumulatedThinking: { thinking: string; signature: string }[];
  totalIn: number;
  totalOut: number;
  stoppingDiagnostics: StoppingDiagnostics | null;
}): ClientEvent | null {
  const { chatSessionId, accumulatedText, accumulatedThinking, totalIn, totalOut } = args;
  const stoppingDiagnostics = args.stoppingDiagnostics;
  const textChars = accumulatedText.join("").length;
  const thinkingChars = accumulatedThinking.reduce((sum, t) => sum + (t.thinking?.length ?? 0), 0);
  if (textChars + thinkingChars === 0) {
    // v0.10.17 — log provider-side stop diagnostics so we can
    // identify why the model returned empty. Without this we see
    // only loopStop='end_turn' + zero output, which is ambiguous:
    //   - Anthropic stop_reason 'refusal' → safety filter
    //   - Anthropic stop_reason 'pause_turn' → 200k context exhausted mid-turn
    //   - Vercel SDK finishReason 'content-filter' → blocked
    //   - SDK warnings about malformed messages → history bug
    //   - All four together null → genuine provider hiccup (retry)
    console.error("[chat-runner] empty-response", {
      chatSessionId,
      tokensIn: totalIn,
      tokensOut: totalOut,
      rawFinishReason: stoppingDiagnostics?.rawFinishReason ?? null,
      providerMetadata: stoppingDiagnostics?.providerMetadata ?? null,
      warnings: stoppingDiagnostics?.warnings ?? null,
      responseMessageId: stoppingDiagnostics?.responseMessageId ?? null,
      responseModelId: stoppingDiagnostics?.responseModelId ?? null,
    });
    return {
      kind: "warning",
      code: "empty-response",
      message:
        "The AI returned an empty response — likely a provider transient (rate limit, safety filter, or internal error). Resend your last message; if it persists, start a fresh chat.",
    };
  }
  // v0.10.21 — widened diagnostic. When the AI emitted SOME text
  // but still zero tool calls on loop 0, log stoppingDiagnostics
  // anyway. No user-facing warning (that's the v0.10.16 noise
  // we deliberately removed) — just stderr so the next time an
  // operator reports "the AI said 'I'll look up X' and then
  // stopped," we have Anthropic's raw stop_reason in Cloud Run
  // logs to distinguish:
  //   - end_turn after intent text → model gave up planning
  //     (usually fixable by improving the system prompt)
  //   - refusal → safety filter triggered mid-stream
  //   - pause_turn → context window exhausted
  //   - SDK warnings → message-array shape bug
  if (textChars > 0) {
    console.error("[chat-runner] passive-response-diag", {
      chatSessionId,
      tokensIn: totalIn,
      tokensOut: totalOut,
      textChars,
      thinkingChars,
      rawFinishReason: stoppingDiagnostics?.rawFinishReason ?? null,
      providerMetadata: stoppingDiagnostics?.providerMetadata ?? null,
      warnings: stoppingDiagnostics?.warnings ?? null,
      responseMessageId: stoppingDiagnostics?.responseMessageId ?? null,
      responseModelId: stoppingDiagnostics?.responseModelId ?? null,
    });
  }
  // else: AI replied with thinking-only or empty + thinking >0
  // — covered by the empty branch above (textChars + thinking
  // === 0 captures the all-zero case; mixed cases are rare and
  // not worth a third branch).
  return null;
}
