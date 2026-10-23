// SPDX-License-Identifier: MPL-2.0

/**
 * The MCP bearer secret: 32 random bytes, hex, `mcp_`-prefixed so a leaked
 * token is greppable in logs. Only its SHA-256 is stored (`mcp_tokens.token_hash`).
 * Shared by `mcp_tokens.create` (the Owner's own Mint button) and the
 * credential handoff issuer (#971), which mints the plaintext only when the
 * approving Owner asks for it.
 */
export async function mintMcpTokenSecret(): Promise<{ plaintext: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const plaintext = `mcp_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return { plaintext, hash: await hashMcpTokenSecret(plaintext) };
}

/** SHA-256 hex of a plaintext MCP token — the lookup key in `mcp_tokens`. */
export async function hashMcpTokenSecret(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintext));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
