// SPDX-License-Identifier: MPL-2.0

/**
 * Turn-completion guards (issue #106 + the v0.10.x empty-response
 * diagnostics). Extracted verbatim from the pre-split `chat-runner.ts`:
 * the passive-action nudge constant, the legitimate-text-only classifier,
 * the loop-0 diagnostic logger, and the nudge-decision predicate.
 */

import type { ClientEvent, StoppingDiagnostics } from "./types.js";

/**
 * issue #106 — in-memory nudge re-prompted to the model when it narrates an
 * imminent action but ends the turn without emitting the tool call. NOT
 * persisted to chat history, so the operator never sees a synthetic turn —
 * they only see the model self-correct into the real tool call.
 */
export const PASSIVE_ACTION_NUDGE =
  "You described an action you were about to take but did not emit any tool call, so nothing actually happened. If you intended to perform it, call the appropriate tool now with the concrete arguments. If you genuinely need information or a decision from the operator first, ask one direct question instead.";

/**
 * issue #106 — classify a loop-0 text-only `end_turn` as a LEGITIMATE stop
 * (so the passive-turn nudge skips it) vs. the passive failure (an announced
 * or implied action the model never carried out — the step-13 footer
 * regression, where it said "A site-wide footer belongs on the layout's
 * footer block …" and stopped without calling add_module_to_layout).
 *
 * The legitimate stops are: a clarifying question, and a message awaiting an
 * Owner approval click (the propose/execute gate — CLAUDE.md §11.A). Anything
 * else on a loop-0 text-only turn is treated as the passive failure and gets
 * ONE nudge. This is the inverse of the earlier narrow verb-matcher
 * (`looksLikeAnnouncedAction`), which only fired on first-person commitment
 * phrasing ("I'll add…", "adding it now") and so missed footer-style
 * declaratives that announce the placement without a commitment verb.
 *
 * Why "nudge unless legitimate" and not "warn on every text-only turn" (the
 * v0.5.9 noise we removed): a nudge re-prompt the operator never sees is
 * functional recovery, not noise — worst case on a genuine info-only answer
 * is one extra round-trip, bounded to once per turn by `passiveNudged`.
 */
export function isLegitimateTextOnlyTurn(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false; // empty → the empty-response path, not a nudge
  // A clarifying question is a legitimate text-only turn.
  if (/\?\s*$/.test(t)) return true;
  if (
    /\b(would you|should i|do you want|want me to|shall i|let me know|which (option|one)|or should i)\b/i.test(
      t,
    )
  )
    return true;
  // Awaiting an Owner approval click (propose/execute gate) — a real
  // human-in-the-loop stop, not a dropped tool call.
  if (
    /(\/security\/[a-z-]+\/pending|click +approve|once (you|it'?s) (approve|active)|approve (it|the|that|this)|awaiting your approval|need you to approve)/i.test(
      t,
    )
  )
    return true;
  return false;
}

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

/**
 * issue #106 — predicate for the once-per-turn passive-action nudge. Gated
 * to loop 0, a text-only `end_turn` with tools available, non-empty text that
 * is NOT a clarifying question or an awaiting-approval message, and not yet
 * nudged this turn. The caller owns the `messages.push(nudge); continue`.
 */
export function shouldNudgePassiveTurn(args: {
  passiveNudged: boolean;
  loop: number;
  loopStop: string;
  toolCallCount: number;
  toolsAvailable: number;
  aborted: boolean;
  text: string;
}): boolean {
  return (
    !args.passiveNudged &&
    args.loop === 0 &&
    args.loopStop === "end_turn" &&
    args.toolCallCount === 0 &&
    args.toolsAvailable > 0 &&
    !args.aborted &&
    args.text.trim().length > 0 &&
    !isLegitimateTextOnlyTurn(args.text)
  );
}
