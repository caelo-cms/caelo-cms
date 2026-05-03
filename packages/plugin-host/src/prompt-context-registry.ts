// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo/plugin-host/prompt-context-registry — plugin-registered system-prompt
 * blocks. The chat-runner queries this on every turn and folds non-empty
 * renderer outputs into the volatile chunk array.
 *
 * Why this exists: P11 had translation's prompt block hard-coded as inline
 * text in `chat-runner.ts`. P11.5 moves it to the plugin so each Tier-1 plugin
 * owns its own context (translation → "pending jobs"; comments → "pending
 * moderation"; newsletter → "subscribers per locale"; etc.). chat-runner just
 * iterates this registry, no plugin-specific code paths.
 *
 * Renderers are async — they may hit the DB to count pending rows. Failure
 * isolation: if a renderer throws, its block is omitted (caller logs); other
 * plugins' blocks still render.
 */

import { isPluginDisabled } from "./dispatch.js";

export interface PromptContextRenderer {
  readonly pluginSlug: string;
  readonly label: string;
  readonly render: () => Promise<string>;
}

class PromptContextRegistry {
  readonly #byPlugin = new Map<string, Map<string, PromptContextRenderer>>();

  register(renderer: PromptContextRenderer): void {
    let bucket = this.#byPlugin.get(renderer.pluginSlug);
    if (!bucket) {
      bucket = new Map();
      this.#byPlugin.set(renderer.pluginSlug, bucket);
    }
    bucket.set(renderer.label, renderer);
  }

  unregisterPlugin(pluginSlug: string): void {
    this.#byPlugin.delete(pluginSlug);
  }

  /** Render every registered block. Returns blocks in stable insertion
   *  order (per-plugin alphabetical by slug, label alphabetical). Empty
   *  strings are dropped (a plugin can return "" to opt out for this turn).
   *  Disabled plugins are skipped (audit fix #2). */
  async renderAll(): Promise<string[]> {
    const out: string[] = [];
    for (const slug of [...this.#byPlugin.keys()].sort()) {
      if (isPluginDisabled(slug)) continue;
      const bucket = this.#byPlugin.get(slug);
      if (!bucket) continue;
      for (const label of [...bucket.keys()].sort()) {
        const renderer = bucket.get(label);
        if (!renderer) continue;
        try {
          const body = await renderer.render();
          if (body.trim().length > 0) out.push(body);
        } catch (e) {
          // Best-effort: a failing renderer doesn't bring the turn down.
          console.warn(
            `[plugin-host] prompt-context renderer ${slug}/${label} threw:`,
            (e as Error).message,
          );
        }
      }
    }
    return out;
  }

  reset(): void {
    this.#byPlugin.clear();
  }
}

export const pluginPromptContextRegistry = new PromptContextRegistry();
