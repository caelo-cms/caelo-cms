// SPDX-License-Identifier: MPL-2.0

/**
 * Read/meta vs. write classification for tool names — the cheap structural
 * pre-filter in front of the narrate-then-stop judge (issue #106 redesign).
 *
 * It answers exactly one question: "has this turn actually CHANGED anything
 * yet?" A text-only `end_turn` AFTER a write is an ordinary closing summary and
 * needs no scrutiny at all. A text-only `end_turn` after only read/meta work
 * MIGHT be the model narrating work it never did — or might be it answering a
 * question the operator asked. This file cannot tell those apart, and does not
 * try: it only decides whether `turn-completeness-judge.ts` is worth a call.
 *
 * The old guard leaned on `loop === 0` ("hasn't acted yet"), which silently
 * stopped being true when progressive-disclosure skills made `load_skill`
 * occupy loop 0. Classifying the tool NAME is the honest form of the same
 * question and is language-agnostic.
 *
 * Read/meta is an explicit allowlist and everything else counts as a write, so
 * a NEW tool is treated as consequential until someone deliberately lists it.
 * That bias is the safe one: mis-classifying a write as read/meta would send an
 * already-finished turn to the judge (a wasted call, and a chance at a wrong
 * verdict); the reverse merely skips a recovery.
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
