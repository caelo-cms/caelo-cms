// SPDX-License-Identifier: MPL-2.0

/**
 * issue #442 — the chat-runner's single ordered event channel for one SDK-loop
 * run. Two producer kinds feed it: the provider-event pump (translated
 * fullStream parts → ClientEvents) and the tool execute wrappers (tool-start /
 * tool-result / subagent events pushed while the SDK awaits their dispatch).
 * One FIFO preserves cross-producer arrival order, which is what makes the
 * SSE stream read exactly like the pre-#442 sequential loop's.
 *
 * Unbounded on purpose: the pump must NEVER block on a slow SSE consumer —
 * a stalled pump would stall the SDK pipeline (tool executions gate on pump
 * quiescence, see streaming.ts). Growth is bounded by turn size, the same
 * bound the old dispatch-time event buffer had.
 */
export class EventQueue<T> {
  #items: T[] = [];
  #closed = false;
  #waker: (() => void) | null = null;

  push(item: T): void {
    if (this.#closed) return;
    this.#items.push(item);
    this.#wake();
  }

  /** No further pushes; pending `next()` resolves once drained. */
  close(): void {
    this.#closed = true;
    this.#wake();
  }

  #wake(): void {
    const w = this.#waker;
    this.#waker = null;
    w?.();
  }

  /** Drain items until closed. Single-consumer. */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      while (this.#items.length > 0) {
        // Length-checked immediately above; TS can't see that through shift.
        yield this.#items.shift() as T;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#waker = resolve;
      });
    }
  }
}

/**
 * Quiescence latch for the provider-event pump. The pump increments the
 * counter on every provider event it processes; `whenQuiescent()` resolves
 * once a full macrotask turn passes with no pump progress.
 *
 * Deterministic at both call sites (the tool-execute anchor gate and the
 * per-step persistence hook) because there the SDK pipeline is provably
 * incapable of producing NEW parts: the model call's output for the step is
 * complete and fully enqueued (the SDK defers client tool execution to
 * `model-call-end`), and the only remaining producers — the tool executions
 * themselves — are blocked on the very gate awaiting this latch. One
 * macrotask turn flushes every microtask-propagated part through the
 * TransformStream chain, so two stable reads mean the pump has consumed
 * everything that exists.
 */
export class PumpQuiescence {
  #processed = 0;

  bump(): void {
    this.#processed += 1;
  }

  async whenQuiescent(): Promise<void> {
    let last = -1;
    while (last !== this.#processed) {
      last = this.#processed;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}
