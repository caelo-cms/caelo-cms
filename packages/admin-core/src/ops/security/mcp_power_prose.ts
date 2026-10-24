// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #413 — surface-honest prose for the Power-MCP surface.
 *
 * Prompt chunks, tool descriptions and the DB-seeded skill bodies (served
 * via mcp.get_context and load_skill) were authored for Caelo's own
 * chat-runner, so they freely recommend tools that POWER_MCP_EXCLUDED_TOOLS
 * strips from the external surface. The seeded skills cannot be rewritten
 * per surface (they are operator data), so the serve boundary adds ONE
 * note after the text naming every excluded tool the text mentions, with
 * the routing the external agent should use instead (the reasons in
 * POWER_MCP_EXCLUDED_TOOLS are written as exactly that routing).
 *
 * #1044 — the note used to sit inline after every mention
 * (`spawn_subagent [not available on this surface — …]`). An external agent
 * writing docs about these tools copied the names together with their
 * notes into a content value, and the annotated text went live; to the
 * agent it looked as if the write had been rewritten. The text itself now
 * stays exactly as authored and the note is a separate block after it, so
 * a tool name copied from served prose is just the name.
 *
 * `findExcludedToolMentions` is the other side of the same coin: it
 * reports mentions the note does NOT cover. The consistency tests run it
 * over everything the surface serves — composed system context, served
 * tool descriptions, exported skill bodies — so prose recommending an
 * excluded tool cannot ship silently again (the #413 bug class; prior
 * instances #159, #411, #414). Both functions derive everything from the
 * exclusion map they are handed: when #412 removes a tool from the map,
 * its mentions stop being noted AND stop being violations, with no test
 * change needed.
 *
 * Only instruction prose gets the note. Tool results carrying site data
 * (content values, module bodies, page HTML) must round-trip byte-for-byte,
 * or a read-modify-write persists the note into the site (bug 2c323d9a) —
 * see `surfaceToolResultContent` in mcp_power.ts.
 */

/** Opening marker of the note. Shared by the writer and the scanner so
 *  "noted" means exactly one thing. */
const NOTE_OPEN =
  "[Not available on this surface — this text names tools this connection does not serve; do not call them:";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A whole-word mention of `name`. `\b` treats `_` as a word character, so a
 * name never matches inside a longer tool name (`spawn_subagent` does not
 * match in `spawn_subagents`).
 */
function mentionOf(name: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`);
}

/** Splits served text into the authored part and the trailing note (if any). */
function splitNote(text: string): { body: string; note: string } {
  const at = text.lastIndexOf(NOTE_OPEN);
  if (at < 0) return { body: text, note: "" };
  return { body: text.slice(0, at).replace(/(?:\n\n| )$/, ""), note: text.slice(at) };
}

/** How the note lists a tool, so the scanner can tell which ones it covers. */
const listed = (name: string) => `\`${name}\``;

/**
 * Appends one note after `text` naming every excluded tool the text
 * mentions and why. The text itself is returned byte-for-byte; text that
 * mentions none is returned unchanged. Multi-line text gets the note as a
 * paragraph with one line per tool, a one-line text (a skill description
 * in a list) gets it on the same line. Idempotent: an existing note is
 * replaced, never doubled. A `]` in a reason would end the note early, so
 * it is folded to `)`.
 */
export function withUnavailableToolsNote(
  text: string,
  excluded: ReadonlyMap<string, string>,
): string {
  const { body } = splitNote(text);
  const mentioned = [...excluded].filter(
    ([name]) => body.includes(name) && mentionOf(name).test(body),
  );
  if (mentioned.length === 0) return body;
  const items = mentioned.map(
    ([name, reason]) => `${listed(name)} (${reason.replaceAll("]", ")")})`,
  );
  return body.includes("\n")
    ? `${body}\n\n${NOTE_OPEN}\n${items.map((i) => `- ${i}`).join("\n")}]`
    : `${body} ${NOTE_OPEN} ${items.join(", ")}.]`;
}

/**
 * Returns the excluded tool names the text mentions that its note does NOT
 * cover — i.e. prose still recommending a tool this surface refuses. A
 * mention the note lists is honest (the note tells the agent NOT to use the
 * tool and what to use instead) and is not reported.
 */
export function findExcludedToolMentions(text: string, excludedNames: Iterable<string>): string[] {
  const { body, note } = splitNote(text);
  const found: string[] = [];
  for (const name of excludedNames) {
    if (!body.includes(name) || !mentionOf(name).test(body)) continue;
    if (!note.includes(listed(name))) found.push(name);
  }
  return found;
}
