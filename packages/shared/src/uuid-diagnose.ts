// SPDX-License-Identifier: MPL-2.0

/**
 * Say precisely what is wrong with a value that should be a UUID.
 *
 * #1089 / #1094 — a bare "Invalid UUID", or "expects { moduleId,
 * contentInstanceId }; got {…}" around a correctly-shaped object, left the
 * model looking for a structural mistake that was not there. The real fault
 * was one id with a character missing; naming the group that is off lets
 * the model see the id itself is wrong and fetch it again instead of
 * re-sending the same value.
 */

const GROUP_LENGTHS = [8, 4, 4, 4, 12] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The next step every malformed-id message ends with. */
export const COPY_ID_EXACTLY_HINT =
  "Copy the id character for character from the tool result that returned it; never retype, shorten or complete an id from memory — if it is no longer in view, call the list_/get_ tool again.";

/**
 * What is wrong with `value` as a UUID, e.g.
 * `"c9c7ddcb-cc85-4747-84f-90967da6f769" is not a UUID: group 4 has 3 characters (expected 4)`.
 * Returns null when `value` is a well-formed UUID.
 */
export function describeMalformedUuid(value: unknown): string | null {
  if (typeof value !== "string") {
    return `${JSON.stringify(value) ?? String(value)} is not a UUID (expected a string)`;
  }
  if (UUID_RE.test(value)) return null;
  const quoted = JSON.stringify(value);
  if (value.includes("…") || value.includes("...")) {
    return `${quoted} is not a UUID: it is shortened (contains an ellipsis)`;
  }
  const groups = value.split("-");
  if (groups.length !== GROUP_LENGTHS.length) {
    return `${quoted} is not a UUID: it has ${groups.length} dash-separated group(s), a UUID has 5 (8-4-4-4-12 hex characters)`;
  }
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i] ?? "";
    const want = GROUP_LENGTHS[i] ?? 0;
    if (g.length !== want) {
      return `${quoted} is not a UUID: group ${i + 1} has ${g.length} character(s) (expected ${want}; a UUID is 8-4-4-4-12)`;
    }
    if (!/^[0-9a-f]+$/i.test(g)) {
      return `${quoted} is not a UUID: group ${i + 1} contains non-hex characters`;
    }
  }
  return `${quoted} is not a UUID`;
}
