// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #413 — surface-honest prose for the Power-MCP surface.
 *
 * Prompt chunks, tool descriptions, tool-result hints and the DB-seeded
 * skill bodies were authored for Caelo's own chat-runner, so they freely
 * recommend tools that POWER_MCP_EXCLUDED_TOOLS strips from the external
 * surface. The seeded skills cannot be rewritten per surface (they are
 * operator data), so the serve boundary annotates instead: every mention
 * of an excluded tool gains an inline
 * `[not available on this surface — <reason>]` note whose reason carries
 * the routing the external agent should use instead (the reasons in
 * POWER_MCP_EXCLUDED_TOOLS are written as exactly that routing).
 *
 * `findExcludedToolMentions` is the other side of the same coin: it
 * reports mentions that are NOT annotated. The consistency tests run it
 * over everything the surface serves — composed system context, served
 * tool descriptions, exported skill bodies — so prose recommending an
 * excluded tool cannot ship silently again (the #413 bug class; prior
 * instances #159, #411, #414). Both functions derive everything from the
 * exclusion map they are handed: when #412 removes a tool from the map,
 * its mentions stop being annotated AND stop being violations, with no
 * test change needed.
 */

/** Opening marker of an annotation note. Shared by the annotator and the
 *  scanner so "annotated" means exactly one thing. */
const NOTE_OPEN = "[not available on this surface — ";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches a whole-word mention of `name`, consuming an optional closing
 * backtick so the note lands OUTSIDE inline code (`` `x` [note] ``, not
 * `` `x [note]` ``). `\b` treats `_` as a word character, so a name never
 * matches inside a longer tool name (`spawn_subagent` does not match in
 * `spawn_subagents`). The lookahead skips mentions that already carry a
 * note, making annotation idempotent and letting the scanner count only
 * bare recommendations.
 */
function bareMention(name: string): RegExp {
  // `(?=(\`?))\1` consumes the optional closing backtick ATOMICALLY:
  // ECMAScript discards a lookahead's interior choice points once it has
  // succeeded, so the engine cannot backtrack to the "no backtick" branch
  // and sneak past the not-already-annotated guard that follows.
  return new RegExp(
    `\\b${escapeRegExp(name)}\\b(?=(\`?))\\1(?!\\s*${escapeRegExp(NOTE_OPEN)})`,
    "g",
  );
}

/**
 * Appends an inline unavailability note after every bare mention of an
 * excluded tool. Text without mentions is returned unchanged. A `]` in a
 * reason would truncate the note span for the scanner, so it is folded to
 * `)` defensively.
 */
export function annotateExcludedToolMentions(
  text: string,
  excluded: ReadonlyMap<string, string>,
): string {
  let out = text;
  for (const [name, reason] of excluded) {
    if (!out.includes(name)) continue;
    const note = ` ${NOTE_OPEN}${reason.replaceAll("]", ")")}]`;
    out = out.replace(bareMention(name), (mention) => `${mention}${note}`);
  }
  return out;
}

/**
 * Returns the excluded tool names the text mentions WITHOUT an
 * unavailability note — i.e. prose still recommending a tool this surface
 * refuses. An annotated mention is honest (it tells the agent NOT to use
 * the tool and what to use instead) and is not reported.
 */
export function findExcludedToolMentions(text: string, excludedNames: Iterable<string>): string[] {
  const found: string[] = [];
  for (const name of excludedNames) {
    if (!text.includes(name)) continue;
    if (bareMention(name).test(text)) found.push(name);
  }
  return found;
}
