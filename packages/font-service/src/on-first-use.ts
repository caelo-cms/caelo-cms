// SPDX-License-Identifier: MPL-2.0

/**
 * Load a module's default export on first use, once per process (#1579).
 *
 * For a dependency that is expensive to load and rarely needed, so a
 * process that never calls it never pays for it. A failed load is not kept:
 * the next call loads again and, if the cause remains, fails the same loud
 * way instead of replaying a stale rejection.
 *
 * @param load the dynamic import, e.g. `() => import("fontverter")`
 * @returns a function that resolves to the default export
 */
export function onFirstUse<T>(load: () => Promise<{ default: T }>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().then(
      (module) => module.default,
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  };
}
