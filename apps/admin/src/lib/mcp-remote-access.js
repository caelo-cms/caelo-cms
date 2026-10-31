// SPDX-License-Identifier: MPL-2.0
/**
 * Issue #968 — what Settings → MCP's "Connect AI tools by URL" card shows,
 * as data: whether to offer setup, and the addresses this person may use
 * with their purpose, audience, URL and suggested connector name. Pure, so
 * the card's rules (never "set up" once on; both addresses with purpose
 * for an Owner; only the usable ones for anyone else) are unit-tested.
 */
import { MCP_SURFACE_COPY, MCP_SURFACE_PERMISSION, mcpConnectorName, } from "@caelo-cms/shared";
const ORDER = ["chat", "admin"];
/**
 * The card for a viewer who may use `mayUse` and may (`canWrite`) set
 * remote MCP up.
 */
export function remoteAccessView(state, mayUse, canWrite) {
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
        adminHint: mayUse.chat && !mayUse.admin
            ? `${MCP_SURFACE_COPY.admin.title} is for roles that may change settings (${MCP_SURFACE_PERMISSION.admin}).`
            : null,
    };
}
