// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — one in-process attempt of a kind at a time (in-process.ts):
 * the self-hosted admin ran its audits one after another, and two at once
 * would share the CPU their Lighthouse runs measure (#837, #874). Two site
 * imports' crawls (#1360) would only take turns at the one shared browser.
 */

/**
 * A line per key: `run(key, work)` starts `work` once every earlier work of
 * the same key has ended (resolved or thrown), and resolves with its result.
 */
export function createLines<K>(): <T>(key: K, work: () => Promise<T>) => Promise<T> {
  const last = new Map<K, Promise<void>>();
  return async (key, work) => {
    const before = last.get(key) ?? Promise.resolve();
    let done!: () => void;
    const mine = new Promise<void>((resolve) => {
      done = resolve;
    });
    last.set(
      key,
      before.then(() => mine),
    );
    await before;
    try {
      return await work();
    } finally {
      done();
    }
  };
}
