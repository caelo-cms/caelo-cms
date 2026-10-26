// SPDX-License-Identifier: MPL-2.0

/**
 * Replay-time rewrite of Tool Search `tool_reference` blocks that name a
 * retired tool.
 *
 * A tool-search result in a persisted turn lists the deferred tools it
 * loaded as `{type: "tool_reference", toolName}`. Anthropic validates every
 * replayed reference against the request's `tools` and rejects the whole
 * request when one is missing ("Tool reference 'set_media_alt' not found in
 * available tools", verified against the live API 2026-10-26). A chat that
 * once searched for a tool we have since retired would therefore 400 on
 * every future turn — the same permanent-wedge class history-repair.ts heals
 * for pairing faults.
 *
 * The fix is explicit, not a guess (CLAUDE.md §2): only names listed in
 * `RETIRED_TOOLS` are rewritten, each to the live tool that replaced it, and
 * every rewrite is reported to the caller for a loud log line. Client
 * tool-call blocks under old names are left alone — the API accepts those in
 * history (their args keep the old shape, so renaming them would misdescribe
 * what ran).
 */

import type { ChatMessageInput } from "../provider.js";
import { RETIRED_TOOLS } from "../tools/retired-tools.js";

/** One rewritten reference, for logging. */
export interface RetiredReferenceRewrite {
  readonly from: string;
  readonly to: string;
}

function rewriteDeep(value: unknown, rewrites: RetiredReferenceRewrite[]): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const r = rewriteDeep(v, rewrites);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? next : value;
  }
  if (typeof value !== "object" || value === null) return value;
  const obj = value as Record<string, unknown>;
  if (obj.type === "tool_reference") {
    // The SDK persists `toolName`; the raw wire shape uses `tool_name`.
    for (const key of ["toolName", "tool_name"] as const) {
      const name = obj[key];
      if (typeof name === "string" && Object.hasOwn(RETIRED_TOOLS, name)) {
        const to = RETIRED_TOOLS[name]?.target;
        if (to) {
          rewrites.push({ from: name, to });
          return { ...obj, [key]: to };
        }
      }
    }
    return value;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const r = rewriteDeep(v, rewrites);
    if (r !== v) changed = true;
    next[k] = r;
  }
  return changed ? next : value;
}

/**
 * Rewrites retired-tool `tool_reference` blocks in replayed history, in both
 * shapes: SDK passthrough rows (`sdkMessages`) and reconstructed rows
 * (`toolCalls[].result` / `serverToolCalls[].result`). Unchanged messages
 * are returned by identity.
 *
 * @returns the messages plus every rewrite made (empty when nothing matched).
 */
export function rewriteRetiredToolReferences(messages: readonly ChatMessageInput[]): {
  messages: ChatMessageInput[];
  rewrites: RetiredReferenceRewrite[];
} {
  const rewrites: RetiredReferenceRewrite[] = [];
  const out = messages.map((m) => rewriteDeep(m, rewrites) as ChatMessageInput);
  return { messages: out, rewrites };
}
