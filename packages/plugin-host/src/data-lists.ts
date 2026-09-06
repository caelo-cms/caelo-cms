// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin-provided data lists — the `{{#name}}…{{/name}}` sources a
 * module can iterate.
 *
 * A plugin knows things a page needs to show but nobody authors: which
 * translations of this page are published, how many comments it has.
 * The old answer was `staticRender`, which splices a fixed block of the
 * plugin's HTML into a placeholder. That works for a self-contained
 * widget and is wrong for a list: the plugin ends up owning markup and
 * classes no theme can reach, so the same switcher looks identical on
 * every site (CLAUDE.md §1A — the AI decides implementation).
 *
 * Here the plugin supplies only DATA under a claimed name, and the
 * module — authored by the AI, styled with the site — writes the
 * markup:
 *
 *   <nav>{{#language_links}}<a href="{{href}}">{{label}}</a>{{/language_links}}</nav>
 *
 * Because resolution happens per rendered page, a module carrying this
 * works in a LAYOUT: one placement in the chrome covers every page. The
 * `staticRender` placeholder could not, since it needs the page's own
 * id baked into its HTML.
 *
 * ## Names are claimed, and claims survive deactivation
 *
 * `name` is exclusive site-wide, like a URL slot: two plugins must
 * never disagree about what `{{#language_links}}` means.
 *
 * The registry deliberately remembers names declared by plugins that
 * are INSTALLED BUT NOT RUNNING. Activation is a hard state — an
 * inactive plugin contributes nothing — but a module written while it
 * ran still contains `{{#language_links}}`. Without the memory the
 * template engine would report an unknown field and the operator would
 * hunt a typo; with it, the render says the plugin is switched off,
 * which is the actual problem and is one click from fixed.
 */

import type { PluginDataListSpec } from "@caelo-cms/plugin-sdk";

/** One element of a list: flat string keys, safe to substitute. */
export type DataListItem = Readonly<Record<string, string>>;

interface ActiveSource {
  readonly pluginSlug: string;
  readonly spec: PluginDataListSpec;
  /** Operation name that resolves this plugin's lists for a page set. */
  readonly operationName: string;
}

class DataListsRegistry {
  /** Live sources — only from plugins that are actually running. */
  readonly #active = new Map<string, ActiveSource>();
  /** Every name any INSTALLED plugin declares, running or not. */
  readonly #declared = new Map<string, { pluginSlug: string; spec: PluginDataListSpec }>();

  /**
   * Record that a plugin declares these names, whether or not it runs.
   * Called for every plugin the host discovers, before the activation
   * gate. Idempotent across reboots.
   */
  declare(pluginSlug: string, specs: readonly PluginDataListSpec[]): void {
    for (const spec of specs) {
      const existing = this.#declared.get(spec.name);
      if (existing && existing.pluginSlug !== pluginSlug) {
        throw new Error(
          `data-list name "${spec.name}" is already declared by plugin "${existing.pluginSlug}" — conflicts with "${pluginSlug}". Names are exclusive site-wide.`,
        );
      }
      this.#declared.set(spec.name, { pluginSlug, spec });
    }
  }

  /** Activate a running plugin's sources. `declare` must have run first. */
  register(pluginSlug: string, specs: readonly PluginDataListSpec[], operationName: string): void {
    for (const spec of specs) {
      this.#active.set(spec.name, { pluginSlug, spec, operationName });
    }
  }

  /** Drop a plugin's LIVE sources; its declarations stay known. */
  unregisterPlugin(pluginSlug: string): void {
    for (const [name, entry] of this.#active) {
      if (entry.pluginSlug === pluginSlug) this.#active.delete(name);
    }
  }

  /** Live sources grouped by the operation that resolves them. */
  activeByOperation(): Map<string, { pluginSlug: string; operationName: string; names: string[] }> {
    const out = new Map<string, { pluginSlug: string; operationName: string; names: string[] }>();
    for (const [name, entry] of this.#active) {
      const key = `${entry.pluginSlug}.${entry.operationName}`;
      const bucket = out.get(key) ?? {
        pluginSlug: entry.pluginSlug,
        operationName: entry.operationName,
        names: [],
      };
      bucket.names.push(name);
      out.set(key, bucket);
    }
    return out;
  }

  /**
   * Names that are declared but not currently live — the render path
   * turns these into "the plugin is switched off" rather than "unknown
   * field", which is the difference between an actionable message and
   * a wild goose chase.
   */
  dormantNames(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [name, entry] of this.#declared) {
      if (!this.#active.has(name)) out.set(name, entry.pluginSlug);
    }
    return out;
  }

  /** Every declared list, for the AI-facing catalogue. */
  catalogue(): Array<{
    name: string;
    pluginSlug: string;
    active: boolean;
    spec: PluginDataListSpec;
  }> {
    return [...this.#declared.entries()]
      .map(([name, e]) => ({
        name,
        pluginSlug: e.pluginSlug,
        active: this.#active.has(name),
        spec: e.spec,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  reset(): void {
    this.#active.clear();
    this.#declared.clear();
  }
}

export const pluginDataListsRegistry = new DataListsRegistry();
