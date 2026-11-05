// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1460 — how an install runs AI, in the words every surface shares.
 * Client-safe: the admin UI renders these, admin-core words its refusals
 * with them. The concept is docs/dev/mcp-access.md.
 */

/**
 * - `provider`: a usable AI key exists; the install's own AI runs.
 * - `mcp_only`: the Owner chose to run without a key, through Power-MCP.
 * - `unset`: neither yet; the first-run gate asks the Owner.
 */
export type InstallAiMode = "provider" | "mcp_only" | "unset";

/** Prefix of every refusal for work that would need the install's own AI. */
export const NO_INSTALL_AI_PREFIX = "NoInstallAi:";

/** What this mode leaves off, in the sentence the wizard and Settings → AI share. */
export const MCP_ONLY_LEAVES_OFF =
  "The Live Edit chat and the AI work of the install itself stay off; your connected agent does that work.";

/** Why a chat token or the chat address is unavailable, and what works instead. */
export const CHAT_SURFACE_NEEDS_INSTALL_AI =
  "Chat access runs this site's own AI, and this install has no AI key. Use admin access (Power-MCP) instead: your agent does the AI work. Storing a key under Settings → AI makes chat access available.";

/**
 * The refusal for work that needs the install's own AI in this mode. Starts
 * with {@link NO_INSTALL_AI_PREFIX} and names both ways forward.
 *
 * @param what what would have run, as a noun phrase ("The chat")
 */
export function noInstallAiRefusal(what: string): string {
  return `${NO_INSTALL_AI_PREFIX} ${what} needs this install's own AI, and the Owner runs this install without an AI key (Power-MCP only). Do the work through an agent connected with an admin-scope MCP token (/settings/mcp), or store a key under Settings → AI (/settings/ai), which ends this mode at once.`;
}
