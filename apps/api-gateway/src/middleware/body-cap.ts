// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — the request body size cap. The implementation is shared with the
 * MCP-Auth-Proxy (@caelo-cms/shared body-cap.ts); the gateway's callers keep
 * importing it from here.
 */

export { readBodyWithCap } from "@caelo-cms/shared";
