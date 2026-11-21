// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R5, issue #1646) — listeners told when a plugin has been
 * registered in this process: loaded at boot, activated, reloaded or
 * updated. admin-core queues a plugin's `activation` batches from here
 * (once per version, so boot loads on every instance add nothing). A
 * listener runs once the registration is complete — configuration seeded,
 * onActivate done, list types, tools and skills in place — and never
 * blocks the load: a failure is logged, the load stands.
 */

import type { LoadedPlugin } from "./dispatch.js";

type Listener = (plugin: LoadedPlugin) => Promise<void> | void;

const listeners = new Set<Listener>();

/** Adds a listener; returns its removal. */
export function onPluginRegistered(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tells every listener; called by the loader once a registration is complete. */
export function notifyPluginRegistered(plugin: LoadedPlugin): void {
  for (const listener of listeners) {
    void Promise.resolve()
      .then(() => listener(plugin))
      .catch((e) =>
        console.error(
          `[plugin-host] a listener for plugin "${plugin.slug}" failed after it loaded:`,
          e instanceof Error ? e.message : e,
        ),
      );
  }
}
