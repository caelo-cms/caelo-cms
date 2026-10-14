// SPDX-License-Identifier: MPL-2.0

/**
 * Key-order-independent JSON, for fingerprints. Two reads of the same
 * jsonb value may list keys in different orders; a fingerprint over plain
 * `JSON.stringify` would then report a change that did not happen.
 */

/** `value` serialised with every object's keys sorted, recursively. */
export function stableJson(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(stable(value));
}

/**
 * #741 — fingerprint of everything a work item's prompt was built from.
 * Unlike the chrome staleness hash this one travels to an external agent
 * and comes back, so it is a real digest: a collision would let an answer
 * written for other content be applied.
 *
 * @returns `sha256:<64 hex>`.
 */
export async function basisOf(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value)));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
