// SPDX-License-Identifier: MPL-2.0

/**
 * issue #301 — the set of AI tool names the chat-runner could put in a
 * catalogue right now: every built-in tool plus the currently
 * registered Tier-1 plugin tools. Used by the skills ops to validate
 * `allowlistedTools` at save/activation time against reality instead
 * of a hand-maintained list.
 */

import { pluginToolsRegistry } from "@caelo-cms/plugin-host";

import { createDefaultToolRegistry } from "./index.js";

// The built-in registry is static per process; plugin tools change with
// activation state, so they are re-read on every call.
let cachedBuiltinNames: ReadonlySet<string> | null = null;

/** Every live AI tool name (built-in registry ∪ active Tier-1 plugin tools). */
export function liveToolNames(): Set<string> {
  if (!cachedBuiltinNames) {
    cachedBuiltinNames = new Set(
      createDefaultToolRegistry()
        .list()
        .map((t) => t.name),
    );
  }
  const names = new Set(cachedBuiltinNames);
  for (const { spec } of pluginToolsRegistry.list()) names.add(spec.name);
  return names;
}
