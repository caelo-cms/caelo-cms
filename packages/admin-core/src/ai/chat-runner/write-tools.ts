// SPDX-License-Identifier: MPL-2.0

/**
 * Read/meta vs. write classification for tool names — the DETECT layer of the
 * narrate-then-stop guard (issue #106 redesign).
 *
 * The question the loop needs answered is "has this turn actually CHANGED
 * anything yet?", because that is what separates the two shapes of a text-only
 * `end_turn`:
 *
 *   - after real work → an ordinary closing summary. Leave it alone.
 *   - after only read/meta work → the model engaged the task, narrated what it
 *     would do, and stopped without doing it.
 *
 * The old guard approximated this with `loop === 0` ("hasn't acted yet"), which
 * silently stopped being true when progressive-disclosure skills made
 * `load_skill` occupy loop 0. Classifying the tool NAME is the honest form of
 * the same question, and it is language-agnostic — unlike the prose classifier
 * this replaced.
 *
 * Read/meta is an explicit allowlist and everything else counts as a write, so
 * a NEW tool is treated as consequential until someone deliberately lists it.
 * That bias is the safe one: mis-classifying a write as read/meta would let the
 * guard fire after real work (a false accusation); the reverse merely declines
 * to recover a turn, which is the pre-existing behaviour.
 */

/** Prefixes that only ever read or load context, never mutate site state. */
const READ_META_PREFIXES = [
  "list_",
  "get_",
  "read_",
  "find_",
  "grep_",
  "search_",
  "query_",
  "inspect_",
  "screenshot_",
  "check_",
  "map_",
  "detect_",
  "describe_",
  "verify_",
] as const;

/**
 * Read/meta tools whose names don't carry one of the prefixes above.
 * `load_skill` is the load-bearing entry: it is what consumes loop 0 in every
 * skill-engaged turn, and treating it as work is exactly the bug being fixed.
 */
const READ_META_EXACT: ReadonlySet<string> = new Set(["load_skill", "read_page_more"]);

/**
 * True when calling `name` changes nothing an operator could see — a read, a
 * lookup, a screenshot, or loading a skill body into context.
 */
export function isReadOrMetaTool(name: string): boolean {
  if (READ_META_EXACT.has(name)) return true;
  return READ_META_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * True when calling `name` counts as the turn having done real work. Anything
 * not on the read/meta allowlist counts — including `offer_choices`, which is
 * how the model legitimately hands control back to the operator and therefore
 * must suppress the forced-tool recovery rather than trigger it.
 */
export function isWriteTool(name: string): boolean {
  return !isReadOrMetaTool(name);
}
