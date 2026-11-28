// SPDX-License-Identifier: MPL-2.0

/**
 * What one call's arguments may take on the way to a plugin, and how they
 * are measured (epic #1751). A sandboxed plugin receives a call as ONE
 * message of at most `SANDBOX_MESSAGE_BYTES` (sandbox-protocol.ts); the
 * calls core cuts by size measure against the same budget:
 *
 * - the Stage audit's fact batches (audit-fact-wire.ts), whose facts may be
 *   shortened, the cut named in `truncatedFacts`;
 * - the structured-data and sitemap-entries calls (composition-calls.ts),
 *   whose page records are never shortened: a record that does not fit is
 *   refused as `record-too-large`.
 *
 * The cutting stays with each caller, because what may be cut differs; the
 * budget and the measure are one.
 */

import { SANDBOX_MESSAGE_BYTES } from "./sandbox-protocol.js";

/**
 * The bytes a call's arguments may take: one sandbox message, less room for
 * the rest of it (the plugin's slug and version, the invocation, the theme
 * tokens, the handle flags; a few KB in practice).
 */
export const PLUGIN_CALL_ARGS_BYTES = SANDBOX_MESSAGE_BYTES - 64 * 1024;

const encoder = new TextEncoder();

/** The bytes `value` takes as JSON on the wire. */
export function jsonWireBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}
