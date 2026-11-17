// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #968 — the facts about Caelo's MCP access paths that the admin UI,
 * the remote resolver's error messages and the docs must agree on: which
 * surface needs which permission, what each surface is for in plain words,
 * and how a client app's key reads to a person. Client-safe (no server
 * imports): Settings → MCP renders it, admin-core words refusals with it.
 * The concept is docs/dev/mcp-access.md.
 */

/**
 * An MCP surface: `chat` asks the site's own AI to do the work
 * (`caelo_chat`); `power` hands the calling agent every tool that AI has, so
 * the agent does the work itself (Power-MCP, #376).
 */
export type McpSurfaceName = "chat" | "power";

/** The surfaces, in the order the UI lists them. */
export const MCP_SURFACE_NAMES = ["chat", "power"] as const satisfies readonly McpSurfaceName[];

/**
 * The name the Power surface had before #1636. Three things outside this
 * repo still hold it, so it stays accepted on the way in and is never
 * written or shown:
 *
 * - the address `/api/mcp/admin` of connectors added before the rename, and
 *   the OAuth tokens sealed for it (apps/mcp-auth-proxy);
 * - rows stored before it (`mcp_tokens.scope`, `mcp_remote_connections.surface`);
 * - the program `caelo-admin-mcp` in client configs (packages/mcp-server).
 *
 * Removed with 1.0 (#1638).
 */
export const LEGACY_POWER_SURFACE_NAME = "admin";

/** What an address segment under `/api/mcp/` or a stored value may be. */
export type McpAddressName = McpSurfaceName | typeof LEGACY_POWER_SURFACE_NAME;

/** Every address under `/api/mcp/` a client may be connected to. */
export const MCP_ADDRESS_NAMES = [
  ...MCP_SURFACE_NAMES,
  LEGACY_POWER_SURFACE_NAME,
] as const satisfies readonly McpAddressName[];

/** The surface an address or a stored value names. */
export function mcpSurfaceOf(name: McpAddressName): McpSurfaceName {
  return name === LEGACY_POWER_SURFACE_NAME ? "power" : name;
}

/** The values rows of `surface` may be stored under: its name, and the legacy one. */
export function storedMcpSurfaceValues(surface: McpSurfaceName): readonly McpAddressName[] {
  return surface === "power" ? ["power", LEGACY_POWER_SURFACE_NAME] : [surface];
}

/** The Power-MCP program of `@caelo-cms/mcp-server`, as client snippets name it. */
export const MCP_POWER_BIN = "caelo-power-mcp";

/**
 * The programs `@caelo-cms/mcp-server` ships in this release (its
 * package.json `bin`; `caelo-admin-mcp` is {@link MCP_POWER_BIN}'s name
 * before #1636). The admin announces them in the shim's version handshake,
 * so a shim started under a name this release lacks re-runs the one it has
 * (packages/mcp-server/src/version-handshake.ts). That package is published
 * on its own and cannot import this one: `scripts/mcp-server-bins.test.ts`
 * holds the two lists together.
 */
export const MCP_SERVER_BINS = ["caelo-mcp-server", MCP_POWER_BIN, "caelo-admin-mcp"] as const;

/**
 * The permission for working on a site through an AI: sending a turn in the
 * Live Edit chat and using either MCP surface (#1636). One rule, because it
 * is one thing: on every path an AI actor bound to the person runs the same
 * tool catalogue in the site's draft, behind the same approval gates. A
 * path that needed more would only move people to another one.
 * `scripts/ai-work-permission.test.ts` fails when a path uses another.
 */
export const AI_WORK_PERMISSION = "content.write";

/** The permission each MCP surface needs ({@link AI_WORK_PERMISSION}). */
export const MCP_SURFACE_PERMISSION: Readonly<Record<McpSurfaceName, typeof AI_WORK_PERMISSION>> = {
  chat: AI_WORK_PERMISSION,
  power: AI_WORK_PERMISSION,
};

/** What a surface does and who may use it, in the words the UI and errors use. */
export const MCP_SURFACE_COPY: Readonly<
  Record<McpSurfaceName, { readonly title: string; readonly does: string; readonly who: string }>
> = {
  chat: {
    title: "Chat with this site's AI",
    does: "The AI tool sends requests to Caelo's own AI, which builds and edits the site like the Live Edit chat does.",
    who: `Everyone who may edit content (${AI_WORK_PERMISSION}).`,
  },
  power: {
    title: "Power-MCP: your AI tool does the work",
    does: "The AI tool gets every tool Caelo's AI has and does the work itself, on its own AI subscription, in the site's draft. Approval-gated actions still wait for a click in Caelo from someone whose role allows that change.",
    who: `Everyone who may edit content (${AI_WORK_PERMISSION}).`,
  },
};

/**
 * A suggested connector name, so two connectors to one site in the same AI
 * tool are told apart: "Caelo viu.one (Chat)", "Caelo viu.one (Power)".
 */
export function mcpConnectorName(siteHost: string, surface: McpSurfaceName): string {
  return `Caelo ${siteHost} (${surface === "power" ? "Power" : "Chat"})`;
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
