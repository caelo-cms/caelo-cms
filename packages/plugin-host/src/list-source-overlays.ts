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
  type ResolvedListOverlays,
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
    // An empty answer stays: "no entries left" and "did not answer" differ
    // to whoever keeps per-entry data.
    const entries = entriesByName[name];
    if (!entries) return [];
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

/** What {@link acceptedSourceValues} found in the plugins' answers. */
export interface AcceptedSourceValues {
  /** variant → `<name>/<entryId>` → field → value. */
  readonly byVariant: Map<string, Map<string, Record<string, unknown>>>;
  readonly issues: ListOverlayIssue[];
}

/**
 * Hold each plugin's answer to what was offered to THAT plugin: a field
 * marked for another contributor is not its to set, whichever plugin the
 * source trusted. A refused value keeps the source's text and is reported.
 *
 * @param answers the plugins' overlays.
 * @param offered plugin slug → the sources it was asked about.
 */
export function acceptedSourceValues(
  answers: ResolvedListOverlays,
  offered: ReadonlyMap<string, readonly ListResolveSource[]>,
): AcceptedSourceValues {
  const byVariant = new Map<string, Map<string, Record<string, unknown>>>();
  const issues: ListOverlayIssue[] = [];
  for (const { slug, overlays } of answers.plugins) {
    const sources = new Map((offered.get(slug) ?? []).map((src) => [src.name, src]));
    for (const [variant, overlay] of Object.entries(overlays)) {
      const values = byVariant.get(variant) ?? new Map<string, Record<string, unknown>>();
      byVariant.set(variant, values);
      for (const [address, value] of Object.entries(overlay.values)) {
        const a = parseValueAddress(address);
        const refuse = (reason: string) => issues.push({ variant, address, reason });
        if (a?.kind !== "pluginSource") {
          refuse("not a list source value address");
          continue;
        }
        const source = sources.get(a.source);
        const field = source?.fields.find((f) => f.name === a.field);
        if (!source || !field) {
          refuse("the source does not offer this field to this plugin");
          continue;
        }
        if (!source.entries.some((e) => e.id === a.itemId)) {
          refuse("no such list source entry");
          continue;
        }
        const bad = validateFieldValue({ ...field, required: false }, value, address);
        if (bad.length > 0) {
          refuse(bad[0]?.message ?? "invalid value");
          continue;
        }
        const key = `${a.source}/${a.itemId}`;
        values.set(key, { ...values.get(key), [a.field]: value });
      }
      for (const address of overlay.hidden) {
        issues.push({ variant, address, reason: "an entry of a list source cannot be hidden" });
      }
    }
  }
  return { byVariant, issues };
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
    const sources = markedSourceEntries(sourcesMarkedFor(lp.slug), entries).filter(
      (src) => src.entries.length > 0,
    );
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

  // Two plugins setting one address throw here, as in `list-resolve`.
  mergeListOverlays(answers);
  const { byVariant, issues } = acceptedSourceValues(answers, sourcesOf);
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
