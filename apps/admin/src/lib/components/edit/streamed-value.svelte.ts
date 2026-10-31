// SPDX-License-Identifier: MPL-2.0

import type { Streamed } from "#lib/streamed.js";
import { currentFor, errorFor, pendingFor } from "./streamed-read.js";

/**
 * #1268 — the latest settled value of a streamed load part (`Streamed`).
 *
 * Each refresh of the editor's load (after every AI tool result) hands in a
 * new promise. The previous value stays on screen until the new one
 * settles, so a refresh never blanks the toolbar; a failure replaces it with
 * the reason, shown where the part renders. A promise superseded by a newer
 * refresh is ignored when it settles late.
 *
 * A part that belongs to one chat or one page is followed with that key.
 * Its value is then read through `currentFor(key)`: after a switch to
 * another chat or page, the previous one's value is not handed out as the
 * new one's (a Stage list of the previous chat must never be submitted for
 * the new one).
 */
export class StreamedValue<T> {
  /** The value, or null while the first promise is pending or after a failure. */
  current = $state<T | null>(null);
  /** Why the latest settled promise failed, or null. */
  error = $state<string | null>(null);
  /** True until the first promise settled. */
  loading = $state(true);
  /** The key `follow` was given with the promise that settled last. */
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

  /** The value if it was loaded for `key`, else null. */
  currentFor(key: string | null): T | null {
    return currentFor(this, key);
  }

  /** The failure if it happened for `key`, else null. */
  errorFor(key: string | null): string | null {
    return errorFor(this, key);
  }

  /** True until a promise for `key` settled. */
  pendingFor(key: string | null): boolean {
    return pendingFor(this, key);
  }
}
