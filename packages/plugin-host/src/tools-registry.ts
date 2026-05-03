// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/tools-registry — in-memory registry of AI tools
 * registered by Tier-1 plugins at activation time.
 *
 * P11 statically registered tools in `packages/admin-core/src/ai/tools/index.ts`.
 * P11.5 makes the surface dynamic: plugins call `ctx.tools.register(spec)` from
 * inside their `definePlugin` factory; the host inserts the spec here keyed by
 * (pluginSlug, toolName); chat-runner queries `listAllRegisteredTools()` per
 * turn and folds the result into its tool catalogue.
 *
 * Disable / re-enable a plugin = remove / re-add its tools from this registry.
 */

import type { PluginToolSpec } from "@caelo-cms/plugin-sdk";
import { isPluginDisabled } from "./dispatch.js";

export interface RegisteredPluginTool {
  readonly pluginSlug: string;
  readonly spec: PluginToolSpec;
}

class ToolsRegistry {
  readonly #byPlugin = new Map<string, Map<string, PluginToolSpec>>();

  register(pluginSlug: string, spec: PluginToolSpec): void {
    let bucket = this.#byPlugin.get(pluginSlug);
    if (!bucket) {
      bucket = new Map();
      this.#byPlugin.set(pluginSlug, bucket);
    }
    bucket.set(spec.name, spec);
  }

  unregisterPlugin(pluginSlug: string): void {
    this.#byPlugin.delete(pluginSlug);
  }

  list(): ReadonlyArray<RegisteredPluginTool> {
    const out: RegisteredPluginTool[] = [];
    for (const [pluginSlug, bucket] of this.#byPlugin) {
      // Audit fix #2: disabled plugins drop out of the catalogue without
      // a process restart. setPluginDisabled flips the flag; chat-runner
      // queries this on the next turn.
      if (isPluginDisabled(pluginSlug)) continue;
      for (const spec of bucket.values()) {
        out.push({ pluginSlug, spec });
      }
    }
    return out;
  }

  /** Lookup a (pluginSlug, toolName) pair. Used by the chat-runner's tool
   *  dispatcher to find the routing target for an AI tool call.
   *  Returns null for disabled plugins so the runner falls through to
   *  the regular tool path (or surfaces "unknown tool"). */
  resolve(toolName: string): RegisteredPluginTool | null {
    for (const [pluginSlug, bucket] of this.#byPlugin) {
      if (isPluginDisabled(pluginSlug)) continue;
      const spec = bucket.get(toolName);
      if (spec) return { pluginSlug, spec };
    }
    return null;
  }

  /** Test-only — clears the registry between fixtures. */
  reset(): void {
    this.#byPlugin.clear();
  }
}

/**
 * Process-singleton. Each Caelo host process keeps one tools registry that
 * outlives request boundaries. The chat-runner imports it; the loader writes
 * to it at startup; on plugin disable the tools-registry entry is removed.
 */
export const pluginToolsRegistry = new ToolsRegistry();
