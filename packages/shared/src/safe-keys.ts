// SPDX-License-Identifier: MPL-2.0

/**
 * Keys that, when used as a dynamic property name on a plain object,
 * mutate the prototype chain instead of the object's own data — the
 * prototype-pollution vector. Any code that assigns into an object with
 * a key derived from external input (imported CSS variable names, dotted
 * write paths from forms/AI) must reject these first.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * True when `key` would pollute the prototype chain if used as a dynamic
 * assignment target (`obj[key] = …`). Callers skip or reject such keys.
 *
 * @param key The candidate property name (e.g. a parsed token name or a
 *            path segment).
 */
export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}
