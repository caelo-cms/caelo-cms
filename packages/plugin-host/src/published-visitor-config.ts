// SPDX-License-Identifier: MPL-2.0

/**
 * #1655 — a plugin's released visitor-visible configuration, for the
 * declarations the host runs on the public side (`onlyIf: { config }`).
 *
 * The admin publishes it with the release (`published_plugin_visitor_config`,
 * #1654); the gateway reads and caches it, and registers its reader here at
 * startup, so a public declaration's switch is exactly as live as the
 * Publish live that shipped it. Without a reader (an admin process) nothing
 * is published to read: a declaration gated on a config leaf then stores
 * nothing, like a switch that is off.
 */

/** Reads a plugin's released visitor-visible values (leaf path → value), or null. */
export type PublishedVisitorConfigReader = (
  pluginId: string,
) => Promise<Readonly<Record<string, unknown>> | null>;

let reader: PublishedVisitorConfigReader | null = null;

/** Registers the reader (the gateway, at startup); null removes it. */
export function setPublishedVisitorConfigReader(r: PublishedVisitorConfigReader | null): void {
  reader = r;
}

/** The plugin's released visitor-visible values, or null when none are readable here. */
export async function publishedVisitorConfig(
  pluginId: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  return reader ? reader(pluginId) : null;
}
