// SPDX-License-Identifier: MPL-2.0

/**
 * Repeated-identical-failure breaker for the chat-runner tool loop.
 *
 * A single bad-argument pattern (the observed case: the model passing an
 * unrecognized `children` key to `add_module_to_layout`, getting a rejection,
 * and re-sending the byte-identical call) can burn the entire 25-iteration
 * tool-loop budget and cascade into a "Paused at the tool-loop limit" dead end.
 * The provider is capable of self-correcting from an actionable error, so when
 * it does NOT — when it re-emits the SAME tool with the SAME arguments and gets
 * the SAME error twice — that is our signal to stop re-running the call and
 * inject a corrective nudge, rather than letting the identical failure repeat
 * until the cap.
 *
 * The breaker is deliberately conservative: it trips ONLY on an exact match of
 * tool name + normalized arguments + error text. A call that fails with a
 * *different* error (the model is making progress, e.g. fixing one field at a
 * time) never trips it. See CLAUDE.md §4 — this is a real behaviour fix in our
 * layer, not a symptom mask: the model keeps making the same mistake because
 * nothing changed between attempts; the breaker changes the input it sees.
 */

/** A failed tool dispatch the breaker inspects. */
export interface DispatchedFailure {
  /** Tool name as the provider called it. */
  readonly name: string;
  /** The raw arguments object the provider emitted for the call. */
  readonly arguments: unknown;
  /** The failed tool-result content (the error text the AI will read). */
  readonly content: string;
}

/**
 * Number of identical (tool + args + error) failures at which the breaker
 * trips. Two means: the first failure is the model's normal one-shot mistake
 * (it gets an actionable error and should self-correct); the second identical
 * failure proves it did not, so we intervene.
 */
export const REPEAT_FAILURE_THRESHOLD = 2;

/**
 * Stable JSON stringify: object keys sorted recursively so two structurally
 * equal argument objects with different key order produce the same string.
 * Arrays keep their order (order is semantically meaningful for tool args).
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val as unknown;
  });
}

/** Identity key for "same tool + same args" (independent of the error text). */
export function callIdentity(name: string, args: unknown): string {
  return `${name}\u0000${stableStringify(args)}`;
}

/** Full signature for "same tool + same args + same error". */
function failureSignature(failure: DispatchedFailure): string {
  return `${callIdentity(failure.name, failure.arguments)}\u0000${failure.content.trim()}`;
}

/** Outcome of recording one failure. */
export interface RecordResult {
  /** How many times this exact (tool + args + error) has now been seen. */
  readonly count: number;
  /**
   * True on the recording that first reaches the threshold — the caller
   * injects the corrective nudge exactly once on this transition.
   */
  readonly tripped: boolean;
  /**
   * True once the (tool + args) identity has tripped (this recording or an
   * earlier one). While blocked, the caller skips re-dispatching the call.
   */
  readonly blocked: boolean;
}

/**
 * Tracks repeated identical tool failures across the iterations of a single
 * chat turn. One instance lives for the duration of one `runToolLoop` call;
 * it is intentionally not shared across turns (a fresh turn starts clean).
 */
export class RepeatedFailureTracker {
  readonly #counts = new Map<string, number>();
  readonly #blocked = new Set<string>();

  /**
   * Record a failed dispatch. Increments the exact-signature counter and,
   * when it reaches {@link REPEAT_FAILURE_THRESHOLD}, marks the (tool + args)
   * identity blocked. `tripped` is true only on the crossing recording so the
   * caller nudges once.
   */
  record(failure: DispatchedFailure): RecordResult {
    const sig = failureSignature(failure);
    const count = (this.#counts.get(sig) ?? 0) + 1;
    this.#counts.set(sig, count);
    const identity = callIdentity(failure.name, failure.arguments);
    const tripped = count === REPEAT_FAILURE_THRESHOLD;
    if (count >= REPEAT_FAILURE_THRESHOLD) this.#blocked.add(identity);
    return { count, tripped, blocked: this.#blocked.has(identity) };
  }

  /**
   * True when this (tool + args) identity has already tripped the breaker, so
   * the caller should NOT re-dispatch an identical call — it would just fail
   * the same way again and consume another loop iteration.
   */
  isBlocked(name: string, args: unknown): boolean {
    return this.#blocked.has(callIdentity(name, args));
  }
}

/**
 * The corrective nudge injected (as an in-memory user turn the operator never
 * sees) when the breaker trips. Names the tool + count so the model recognises
 * its own loop, and directs it to change approach rather than re-send.
 */
export function repeatedFailureNudge(name: string, count: number): string {
  return (
    `You called \`${name}\` with the same arguments and it failed with the same error ${count} times in a row. ` +
    `Re-sending the identical call will keep failing — do NOT repeat it. ` +
    `Read that error message, then change your approach: fix the arguments it flagged, or use a different tool. ` +
    `If you cannot proceed, say so plainly instead of retrying the same call.`
  );
}

/**
 * The synthetic tool-result returned in place of re-running a call whose
 * identity is already blocked. Keeps the assistant tool_use / tool_result
 * pairing complete (Anthropic 400s on a dangling tool_use) without spending a
 * real dispatch on a call known to fail identically.
 */
export function blockedCallResult(name: string): string {
  return (
    `Not re-run: \`${name}\` was called again with the exact same arguments that already failed ` +
    `identically twice. The call was blocked to avoid looping. Change the arguments or use a ` +
    `different approach before calling \`${name}\` again.`
  );
}
