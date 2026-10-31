// SPDX-License-Identifier: MPL-2.0

import type { Streamed } from "#lib/streamed.js";

/**
 * #1268 — the latest settled value of a streamed load part (`Streamed`).
 *
 * Each refresh of the editor's load (after every AI tool result) hands in a
 * new promise. The previous value stays on screen until the new one
 * settles, so a refresh never blanks the toolbar; a failure replaces it with
 * the reason, shown where the part renders. A promise superseded by a newer
 * refresh is ignored when it settles late.
 */
export class StreamedValue<T> {
  /** The value, or null while the first promise is pending or after a failure. */
  current = $state<T | null>(null);
  /** Why the latest settled promise failed, or null. */
  error = $state<string | null>(null);
  /** True until the first promise settled. */
  loading = $state(true);
  /**
   * The key `follow` was given with the promise that settled last, e.g. the
   * page a page-bound part describes: after a page switch the previous
   * page's value is still `current` until the new one arrives.
   */
  key = $state<string | null>(null);
  #latest: Promise<Streamed<T>> | null = null;

  /** Follows `promise`; the call for an older promise is a no-op once a newer one came. */
  follow(promise: Promise<Streamed<T>>, key: string | null = null): void {
    if (promise === this.#latest) return;
    this.#latest = promise;
    void promise.then((r) => {
      if (promise !== this.#latest) return;
      this.loading = false;
      this.key = key;
      if (r.ok) {
        this.current = r.value;
        this.error = null;
      } else {
        this.current = null;
        this.error = r.error;
      }
    });
  }
}
