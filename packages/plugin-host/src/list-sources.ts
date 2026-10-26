// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin list sources — the `{{#name}}…{{/name}}` entries a module can
 * iterate, and what a list type's `source: { kind: "plugin", name }`
 * node generates (epic #1107, `docs/lists.md` §6).
 *
 * A plugin knows things a page needs to show but nobody authors: which
 * translations of this page are published, how many comments it has. The
 * plugin supplies only DATA under a claimed name, typed by a node
 * definition of the shared field system; the module — authored by the
 * AI, styled with the site — writes the markup:
 *
 *   <nav>{{#language_links}}<a href="{{href}}">{{label}}</a>{{/language_links}}</nav>
 *
 * Because resolution happens per rendered page, a module carrying this
 * works in a LAYOUT: one placement in the chrome covers every page.
 *
 * ## Names are claimed, and claims survive deactivation
 *
 * `name` is exclusive site-wide, like a URL slot: two plugins must never
 * disagree about what `{{#language_links}}` means.
 *
 * The registry deliberately remembers names declared by plugins that are
 * INSTALLED BUT NOT RUNNING. Activation is a hard state — an inactive
 * plugin contributes nothing — but a module written while it ran still
 * contains `{{#language_links}}`. With the memory, the render says which
 * plugin is switched off (`list-source-unavailable:<name>
 * plugin=<slug>`), which is the actual problem and one click from fixed.
 */

import type { PluginListSourceSpec } from "@caelo-cms/plugin-sdk";

interface ActiveSource {
  readonly pluginSlug: string;
  readonly spec: PluginListSourceSpec;
  /** Operation name that resolves this plugin's sources for a page set. */
  readonly operationName: string;
}

class ListSourcesRegistry {
  /** Live sources — only from plugins that are actually running. */
  readonly #active = new Map<string, ActiveSource>();
  /** Every name any INSTALLED plugin declares, running or not. */
  readonly #declared = new Map<string, { pluginSlug: string; spec: PluginListSourceSpec }>();

  /**
   * Record that a plugin declares these names, whether or not it runs.
   * Called for every plugin the host discovers, before the activation
   * gate. Idempotent across reboots; a later version's declaration
   * replaces the earlier one.
   */
  declare(pluginSlug: string, specs: readonly PluginListSourceSpec[]): void {
    for (const spec of specs) {
      const existing = this.#declared.get(spec.name);
      if (existing && existing.pluginSlug !== pluginSlug) {
        throw new Error(
          `list source "${spec.name}" is already declared by plugin "${existing.pluginSlug}" — conflicts with "${pluginSlug}". Names are exclusive site-wide.`,
        );
      }
      this.#declared.set(spec.name, { pluginSlug, spec });
    }
  }

  /** Activate a running plugin's sources. `declare` must have run first. */
  register(
    pluginSlug: string,
    specs: readonly PluginListSourceSpec[],
    operationName: string,
  ): void {
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
  activeByOperation(): Map<
    string,
    { pluginSlug: string; operationName: string; specs: Map<string, PluginListSourceSpec> }
  > {
    const out = new Map<
      string,
      { pluginSlug: string; operationName: string; specs: Map<string, PluginListSourceSpec> }
    >();
    for (const [name, entry] of this.#active) {
      const key = `${entry.pluginSlug}.${entry.operationName}`;
      const bucket = out.get(key) ?? {
        pluginSlug: entry.pluginSlug,
        operationName: entry.operationName,
        specs: new Map<string, PluginListSourceSpec>(),
      };
      bucket.specs.set(name, entry.spec);
      out.set(key, bucket);
    }
    return out;
  }

  /**
   * Names that are declared but not currently live — the render path
   * turns these into "the plugin is switched off" rather than "unknown
   * source".
   */
  dormantNames(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [name, entry] of this.#declared) {
      if (!this.#active.has(name)) out.set(name, entry.pluginSlug);
    }
    return out;
  }

  /** Every declared source, for the AI-facing catalogue and module validation. */
  catalogue(): Array<{
    name: string;
    pluginSlug: string;
    active: boolean;
    spec: PluginListSourceSpec;
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

export const pluginListSourcesRegistry = new ListSourcesRegistry();
