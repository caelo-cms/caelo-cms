// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #968 — what Settings → MCP's "Connect AI tools by URL" card shows,
 * as data: whether to offer setup, and the addresses this person may use
 * with their purpose, audience, URL and suggested connector name. Pure, so
 * the card's rules (never "set up" once on; both addresses with purpose
 * for an Owner; only the usable ones for anyone else) are unit-tested.
 */

import {
  MCP_SURFACE_COPY,
  MCP_SURFACE_PERMISSION,
  type McpSurfaceName,
  mcpConnectorName,
} from "@caelo-cms/shared";

/** Where remote MCP stands on this install (Settings → MCP loader). */
export type RemoteMcpState =
  | { status: "not-available"; reason: string }
  | { status: "needs-upgrade"; nextStep: string; missing: readonly string[] }
  | { status: "off"; signInSettingsPath: string }
  | {
      status: "on";
      urls: Readonly<Record<McpSurfaceName, string>>;
      /** Host the suggested connector names use ("Caelo viu.one (Chat)"). */
      siteHost: string;
    };

/** One address the card lists. */
export interface RemoteSurfaceView {
  readonly surface: McpSurfaceName;
  readonly title: string;
  readonly does: string;
  readonly who: string;
  readonly url: string;
  readonly connectorName: string;
}

/** The card's content for one viewer. */
export interface RemoteAccessView {
  /** A "Set up remote MCP" link (Owner, remote MCP off); null otherwise. */
  readonly setupHref: string | null;
  /** The addresses this viewer may use; empty unless remote MCP is on. */
  readonly surfaces: readonly RemoteSurfaceView[];
  /** A note that full admin access exists but needs another role, when that applies. */
  readonly adminHint: string | null;
}

const ORDER: readonly McpSurfaceName[] = ["chat", "admin"];

/**
 * The card for a viewer who may use `mayUse` and may (`canWrite`) set
 * remote MCP up.
 */
export function remoteAccessView(
  state: RemoteMcpState,
  mayUse: Readonly<Record<McpSurfaceName, boolean>>,
  canWrite: boolean,
): RemoteAccessView {
  if (state.status !== "on") {
    return {
      setupHref: state.status === "off" && canWrite ? state.signInSettingsPath : null,
      surfaces: [],
      adminHint: null,
    };
  }
  const surfaces = ORDER.filter((s) => mayUse[s]).map((surface) => ({
    surface,
    ...MCP_SURFACE_COPY[surface],
    url: state.urls[surface],
    connectorName: mcpConnectorName(state.siteHost, surface),
  }));
  return {
    setupHref: null,
    surfaces,
    adminHint:
      mayUse.chat && !mayUse.admin
        ? `${MCP_SURFACE_COPY.admin.title} is for roles that may change settings (${MCP_SURFACE_PERMISSION.admin}).`
        : null,
  };
}
