// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #968 — the facts about Caelo's MCP access paths that the admin UI,
 * the remote resolver's error messages and the docs must agree on: which
 * surface needs which permission, what each surface is for in plain words,
 * and how a client app's key reads to a person. Client-safe (no server
 * imports): Settings → MCP renders it, admin-core words refusals with it.
 * The concept is docs/dev/mcp-access.md.
 */

/** A remote MCP surface: talk to the site's AI, or drive its admin tools. */
export type McpSurfaceName = "chat" | "admin";

/**
 * The permission each remote surface needs. Chat writes content through
 * Caelo's own AI; admin exposes every tool the AI has, so it needs what an
 * admin-scoped MCP token needs. Owners have both.
 */
export const MCP_SURFACE_PERMISSION: Readonly<
  Record<McpSurfaceName, "content.write" | "settings.write">
> = {
  chat: "content.write",
  admin: "settings.write",
};

/** What a surface does and who may use it, in the words the UI and errors use. */
export const MCP_SURFACE_COPY: Readonly<
  Record<McpSurfaceName, { readonly title: string; readonly does: string; readonly who: string }>
> = {
  chat: {
    title: "Chat with this site's AI",
    does: "The AI tool sends requests to Caelo's own AI, which builds and edits the site like the Live Edit chat does.",
    who: "Everyone who may edit content (content.write).",
  },
  admin: {
    title: "Full admin access",
    does: "The AI tool gets every tool Caelo's AI has and does the work itself, on a preview branch. Approval-gated actions still wait for an Owner's click.",
    who: "Owners and roles that may change settings (settings.write).",
  },
};

/**
 * A suggested connector name, so two connectors to one site in the same AI
 * tool are told apart: "Caelo viu.one (Chat)", "Caelo viu.one (Admin)".
 */
export function mcpConnectorName(siteHost: string, surface: McpSurfaceName): string {
  return `Caelo ${siteHost} (${surface === "admin" ? "Admin" : "Chat"})`;
}

/**
 * How a client app's key (the gateway's `mcpClientKey`) reads to a person.
 * Known CIMD documents get their product name; a DCR key shows the name the
 * app registered with (unverified — anyone can register any name).
 */
export function describeMcpClient(clientKey: string | null): string {
  if (clientKey === null) return "An app from before per-app connections";
  if (clientKey.startsWith("dcr:sha256:") || clientKey.startsWith("sha256:")) {
    return "An app that did not give its name";
  }
  if (clientKey.startsWith("dcr:")) return clientKey.slice(4);
  let url: URL;
  try {
    url = new URL(clientKey);
  } catch {
    return clientKey;
  }
  if (url.hostname === "chatgpt.com") return "ChatGPT";
  if (url.hostname === "claude.ai") {
    return url.pathname.includes("claude-code") ? "Claude Code" : "Claude";
  }
  return url.hostname;
}
