// SPDX-License-Identifier: MPL-2.0

/**
 * #1323 — plugin list source entries in the rendering page's variant.
 *
 * A plugin list source (`{{#consent_categories}}`) is data a plugin
 * generates per render, so it has no stored value a shared list's overlay
 * could address, and one plugin must never read another's storage. Core
 * has no locale concept (epic #380); it connects the two neutrally:
 *
 *   - a source marks a field for a `list-resolve` contributor with that
 *     contributor's own attribute (`ext.<pluginSlug>` on the field, the
 *     definition extension of `docs/lists.md` §9). Core reads no meaning
 *     into it, and without that plugin it is inert;
 *   - after the sources are resolved, core hands the contributor the
 *     marked fields' values in `scope.sources` and applies its answer by
 *     address, `source/<name>/item/<entryId>/<field>`, to each page of
 *     the variant.
 *
 * Everything else about an entry is structure and stays the source
 * plugin's: an answer may replace a marked field's value and nothing else.
 * It adds, removes and hides no entry, and it cannot reach an unmarked
 * field — the `key` and `required` of a consent category are what the
 * banner's choice and the visitor's stored decision mean.
 *
 * A source with marked fields promises the same entry id means the same
 * entry on every page: the texts are asked for per id, not per page.
 *
 * Applying it here, where every render path (editor preview, build,
 * `lists.preview_source`) gets its entries, means none of them can show a
 * different text. Loud like `list-resolve`: a failing contributor throws
 * (a preview reports it and shows the stored text, #1087), and a value the
 * answer may not set is reported to the plugin that sent it.
 */

import type { ListResolveSource, PluginListSourceSpec } from "@caelo-cms/plugin-sdk";
import {
  type ListOverlayIssue,
  type PluginSourceEntry,
  parseValueAddress,
  validateFieldValue,
} from "@caelo-cms/shared";
import type { RenderScope } from "./dispatch.js";
import { hasLinkResolveContributors, resolveLinkVariants } from "./link-resolve.js";
import {
  askListResolve,
  listResolveContributors,
  mergeListOverlays,
  reportListOverlayIssues,
} from "./list-resolve.js";
import { pluginListSourcesRegistry } from "./list-sources.js";

type FieldDef = PluginListSourceSpec["node"]["fields"][number];

/** The fields of `spec` that carry `pluginSlug`'s own attribute. */
function markedFields(spec: PluginListSourceSpec, pluginSlug: string): FieldDef[] {
  return spec.node.fields.filter((f) => f.ext?.[pluginSlug] !== undefined);
}

/** The active sources with fields marked for `pluginSlug`. */
export function sourcesMarkedFor(
  pluginSlug: string,
): { readonly name: string; readonly label: string; readonly fields: FieldDef[] }[] {
  return pluginListSourcesRegistry
    .catalogue()
    .filter((c) => c.active)
    .flatMap((c) => {
      const fields = markedFields(c.spec, pluginSlug);
      return fields.length > 0 ? [{ name: c.name, label: c.spec.label, fields }] : [];
    });
}

/**
 * The marked sources of one page's answer, as `scope.sources` carries
 * them: only the marked fields' values.
 *
 * @param sources the sources marked for the asker ({@link sourcesMarkedFor}).
 * @param entriesByName the entries, by source name.
 */
export function markedSourceEntries(
  sources: ReturnType<typeof sourcesMarkedFor>,
  entriesByName: Readonly<Record<string, readonly PluginSourceEntry[]>>,
): ListResolveSource[] {
  return sources.flatMap(({ name, label, fields }) => {
    const entries = entriesByName[name];
    if (!entries || entries.length === 0) return [];
    return [
      {
        name,
        label,
        fields,
        entries: entries.map((e) => ({
          id: e.id,
          values: Object.fromEntries(
            fields.flatMap((f) => (f.name in e.values ? [[f.name, e.values[f.name]]] : [])),
          ),
        })),
      },
    ];
  });
}

/** Every page's entries of each source once, by entry id. */
function distinctEntries(
  byPage: ReadonlyMap<string, Readonly<Record<string, readonly PluginSourceEntry[]>>>,
): Record<string, PluginSourceEntry[]> {
  const out = new Map<string, Map<string, PluginSourceEntry>>();
  for (const sources of byPage.values()) {
    for (const [name, entries] of Object.entries(sources)) {
      const seen = out.get(name) ?? new Map<string, PluginSourceEntry>();
      for (const e of entries) if (!seen.has(e.id)) seen.set(e.id, e);
      out.set(name, seen);
    }
  }
  return Object.fromEntries([...out].map(([name, m]) => [name, [...m.values()]]));
}

/** The value replacing `address` in `entries`, or why it may not. */
function overlaidField(
  address: string,
  value: unknown,
  markedByName: ReadonlyMap<string, ReadonlyMap<string, FieldDef>>,
): { name: string; id: string; field: string } | { refused: string } {
  const a = parseValueAddress(address);
  if (a?.kind !== "pluginSource") return { refused: "not a list source value address" };
  const field = markedByName.get(a.source)?.get(a.field);
  if (!field) return { refused: "the source does not offer this field to an overlay" };
  const bad = validateFieldValue({ ...field, required: false }, value, address);
  if (bad.length > 0) return { refused: bad[0]?.message ?? "invalid value" };
  return { name: a.source, id: a.itemId, field: a.field };
}

/**
 * The entries of `resolved` in each page's variant. Costs no plugin call
 * unless an answered source has fields marked for a running contributor.
 *
 * @param resolved the plugins' entries per page.
 */
export async function overlayListSources(
  resolved: Map<string, Record<string, PluginSourceEntry[]>>,
  scope: RenderScope,
): Promise<Map<string, Record<string, PluginSourceEntry[]>>> {
  if (resolved.size === 0) return resolved;
  const entries = distinctEntries(resolved);
  const asked = listResolveContributors().flatMap((lp) => {
    const sources = markedSourceEntries(sourcesMarkedFor(lp.slug), entries);
    return sources.length > 0 ? [{ lp, sources }] : [];
  });
  if (asked.length === 0 || !hasLinkResolveContributors()) return resolved;

  const pageIds = [...resolved.keys()];
  const partition = await resolveLinkVariants(pageIds, scope);
  const variants = [...new Set([...partition.values()].map((v) => v.variant))];
  if (variants.length === 0) return resolved;
  const sourcesOf = new Map(asked.map((a) => [a.lp.slug, a.sources]));
  const answers = await askListResolve(
    asked.map((a) => a.lp),
    variants,
    scope,
    (slug) => ({ listIds: [], contentInstanceIds: [], pageIds: [], sources: sourcesOf.get(slug) }),
  );

  const markedByName = new Map<string, Map<string, FieldDef>>();
  for (const { sources } of asked) {
    for (const s of sources) {
      const fields = markedByName.get(s.name) ?? new Map<string, FieldDef>();
      for (const f of s.fields) fields.set(f.name, f as FieldDef);
      markedByName.set(s.name, fields);
    }
  }
  const issues: ListOverlayIssue[] = [];
  /** variant → `<name>/<entryId>` → field → value. */
  const byVariant = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [variant, overlay] of mergeListOverlays(answers)) {
    const values = new Map<string, Record<string, unknown>>();
    for (const [address, value] of overlay.values) {
      const hit = overlaidField(address, value, markedByName);
      if ("refused" in hit) {
        issues.push({ variant, address, reason: hit.refused });
        continue;
      }
      const key = `${hit.name}/${hit.id}`;
      values.set(key, { ...values.get(key), [hit.field]: value });
    }
    for (const address of overlay.hidden) {
      issues.push({ variant, address, reason: "an entry of a list source cannot be hidden" });
    }
    byVariant.set(variant, values);
  }
  if (issues.length > 0) await reportListOverlayIssues(answers, issues);

  const out = new Map<string, Record<string, PluginSourceEntry[]>>();
  for (const [pageId, sources] of resolved) {
    const variant = partition.get(pageId)?.variant;
    const values = variant === undefined ? undefined : byVariant.get(variant);
    if (!values || values.size === 0) {
      out.set(pageId, sources);
      continue;
    }
    out.set(
      pageId,
      Object.fromEntries(
        Object.entries(sources).map(([name, list]) => [
          name,
          list.map((e) => {
            const over = values.get(`${name}/${e.id}`);
            return over ? { id: e.id, values: { ...e.values, ...over } } : e;
          }),
        ]),
      ),
    );
  }
  return out;
}
