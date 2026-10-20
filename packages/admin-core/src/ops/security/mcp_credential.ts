// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — the credential fields of the `mcp.*` ops (a bearer token or
 * a remote IAP credential), in a leaf module: mcp_tokens.ts and
 * mcp_principal.ts import each other's functions, and these schemas are
 * read while their op definitions evaluate, so they must not sit on that
 * cycle. See mcp_principal.ts for how a credential resolves.
 */

import { z } from "zod";

/** A remote MCP surface: `chat` (caelo_chat) or `admin` (Power-MCP). */
export const mcpRemoteSurface = z.enum(["chat", "admin"]);
export type McpRemoteSurface = z.infer<typeof mcpRemoteSurface>;

/** The remote credential an `/api/mcp/remote/<surface>` request carries into an op. */
export const mcpRemoteCredential = z
  .object({
    /** The request's `x-goog-iap-jwt-assertion`; re-verified by the op. */
    iapCredential: z.string().min(16).max(16_384),
    surface: mcpRemoteSurface,
  })
  .strict();
export type McpRemoteCredential = z.infer<typeof mcpRemoteCredential>;

/**
 * The credential fields every `mcp.*` op accepts; exactly one is set
 * ({@link exactlyOneMcpCredential}). `plaintextToken` and
 * `remote.iapCredential` match the audit redaction pattern, so neither secret
 * reaches an audit hash.
 */
export const mcpCredentialShape = {
  plaintextToken: z.string().min(8).max(200).optional(),
  remote: mcpRemoteCredential.optional(),
};

/** The flat input form of {@link mcpCredentialShape}. */
export interface McpCredentialInput {
  readonly plaintextToken?: string | undefined;
  readonly remote?: McpRemoteCredential | undefined;
}

/** Zod refinement: a request authenticates one way, never both or neither. */
export const exactlyOneMcpCredential = {
  check: (v: { readonly plaintextToken?: unknown; readonly remote?: unknown }): boolean =>
    (v.plaintextToken !== undefined) !== (v.remote !== undefined),
  message: "authenticate with exactly one of plaintextToken or remote",
};
