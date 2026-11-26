// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — a plugin value the host refused before it reached a page
 * (docs/dev/external-plugin-brokers.md §4.5 and §6.2; the checks live in
 * the plugin host, `plugin-values.ts` and `head-vocabulary.ts`). `<source>`
 * is a list source's name, {@link PLUGIN_HEAD_POINT} or
 * {@link PLUGIN_SHARE_IMAGES_POINT}. The refused value is replaced by
 * {@link refusedPluginValue}, so the render keeps the spot raw and records
 * `plugin-value-refused:<plugin>.<source>.<field>:<rule>`, a render failure
 * in the #1604 sense: the preview lists it, a Stage ships the spot raw and
 * records it, and Publish live refuses the build. A refusal is never a
 * cleaned value (CLAUDE.md §2, no fallbacks).
 */

/** Marker kind of a plugin value the host refused. */
export const PLUGIN_VALUE_REFUSED = "plugin-value-refused";

/**
 * #1729 — the `<source>` of a refusal from the head-contribution point
 * (head entries, sitemap adjustments, the document language): not a list
 * source, which is snake_case and never holds a hyphen.
 */
export const PLUGIN_HEAD_POINT = "head-composition";

/** #1729 — the `<source>` of a refused default share image (field `image`). */
export const PLUGIN_SHARE_IMAGES_POINT = "share-images";

/** The key of a refused value's stand-in; a plugin entry value can never be an object with it. */
const REFUSED_KEY = "$caeloRefused";

/** The marker of a refused value: which plugin, source and field, and the rule it broke. */
export function pluginValueRefusedMarker(
  plugin: string,
  source: string,
  field: string,
  rule: string,
): string {
  return `${PLUGIN_VALUE_REFUSED}:${plugin}.${source}.${field}:${rule}`;
}

/** The stand-in a refused value is replaced by; JSON, so it crosses a build's process boundary. */
export function refusedPluginValue(marker: string): { readonly $caeloRefused: string } {
  return { [REFUSED_KEY]: marker } as { readonly $caeloRefused: string };
}

/** The marker of a refused value's stand-in, or null for any other value. */
export function refusedPluginValueMarker(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const marker = (value as Record<string, unknown>)[REFUSED_KEY];
  return typeof marker === "string" ? marker : null;
}

/** The parts of a `plugin-value-refused` marker's body (what follows the kind). */
export function parsePluginValueRefused(body: string): {
  readonly plugin: string;
  readonly source: string;
  readonly field: string;
  readonly rule: string;
} {
  const at = body.lastIndexOf(":");
  const where = at < 0 ? body : body.slice(0, at);
  const [plugin = "", source = "", field = ""] = where.split(".");
  return { plugin, source, field, rule: at < 0 ? "" : body.slice(at + 1) };
}
