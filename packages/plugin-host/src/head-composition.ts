// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/head-composition — the head + sitemap
 * contribution points (#391, epic #380 decision 1).
 *
 * Plugins DECLARE contribution kinds in their manifest (capability
 * `head_contributions`, release-signed only) and supply an operation
 * that returns TYPED entries per page. The host Zod-validates every
 * entry, merges additively with stable-key dedup, and fails LOUDLY on
 * contradictions — two plugins (or one plugin twice) asserting
 * different values under the same key is a bug to surface, never a
 * last-writer-wins coin flip.
 *
 * Serialization (`renderHeadEntries`, below) is consumed by the static
 * generator AND the admin preview through the same call — the
 * historical hreflang bug was exactly two hand-kept head assemblies
 * drifting apart.
 */

import {
  type HeadEntry,
  headEntry,
  type SitemapContribution,
  sitemapContribution,
} from "@caelo-cms/plugin-sdk";
import { isPluginDisabled, loadedPlugins, runPluginOperation } from "./dispatch.js";

interface ContributionSource {
  readonly pluginSlug: string;
  readonly operationName: string;
}

function contributingPlugins(): ContributionSource[] {
  const out: ContributionSource[] = [];
  for (const lp of loadedPlugins.all()) {
    if (isPluginDisabled(lp.slug)) continue;
    const kinds = lp.definition.contributes ?? [];
    if (kinds.length === 0) continue;
    const op = lp.definition.contributionsOperation;
    if (!op) {
      throw new Error(
        `head-composition: plugin "${lp.slug}" declares contributes=[${kinds.join(", ")}] but no contributionsOperation`,
      );
    }
    out.push({ pluginSlug: lp.slug, operationName: op });
  }
  return out;
}

/** Stable identity key: same key must mean same value (else: loud). */
function headEntryKey(e: HeadEntry): string {
  if (e.kind === "link") {
    return `link|${e.rel}|${e.hreflang ?? ""}|${e.media ?? ""}`;
  }
  return `meta|${e.name ?? ""}|${e.property ?? ""}`;
}

function headEntryValue(e: HeadEntry): string {
  return e.kind === "link" ? `${e.href}|${e.type ?? ""}` : e.content;
}

export interface CollectedContributions {
  readonly head: Map<string, HeadEntry[]>;
  readonly sitemap: Map<string, SitemapContribution>;
}

/**
 * Collect + validate + merge all plugins' head/sitemap contributions
 * for the given pages. Loud (no-fallbacks): a failing contribution op,
 * an entry that fails the Zod shape, and contradictory entries under
 * one key all throw — silently dropping a contribution would ship a
 * page whose head disagrees with what the plugin believes it published.
 */
export async function collectContributions(
  pageIds: ReadonlyArray<string>,
  opts: { siteBaseUrl: string },
): Promise<CollectedContributions> {
  const head = new Map<string, HeadEntry[]>();
  const headKeys = new Map<string, Map<string, { value: string; source: string }>>();
  const sitemap = new Map<string, SitemapContribution>();
  if (pageIds.length === 0) return { head, sitemap };

  for (const source of contributingPlugins()) {
    const r = await runPluginOperation({
      pluginSlug: source.pluginSlug,
      operationName: source.operationName,
      args: { pageIds: [...pageIds], siteBaseUrl: opts.siteBaseUrl },
    });
    if (!r.ok) {
      throw new Error(
        `head-composition: ${source.pluginSlug}.${source.operationName} failed: ${r.error.kind}: ${r.error.message}`,
      );
    }
    const value = r.value as {
      head?: Record<string, unknown[]>;
      sitemap?: Record<string, unknown>;
    };

    for (const [pageId, rawEntries] of Object.entries(value.head ?? {})) {
      const perPage = head.get(pageId) ?? [];
      const perPageKeys =
        headKeys.get(pageId) ?? new Map<string, { value: string; source: string }>();
      for (const raw of rawEntries) {
        const parsed = headEntry.safeParse(raw);
        if (!parsed.success) {
          throw new Error(
            `head-composition: plugin "${source.pluginSlug}" returned an invalid head entry for page ${pageId}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          );
        }
        const key = headEntryKey(parsed.data);
        const valueSig = headEntryValue(parsed.data);
        const existing = perPageKeys.get(key);
        if (existing) {
          if (existing.value === valueSig) continue; // exact duplicate — dedup
          throw new Error(
            `head-composition: contradictory head entries for page ${pageId} under key "${key}": "${existing.value}" (from ${existing.source}) vs "${valueSig}" (from ${source.pluginSlug}). Contributions must agree or stay disjoint.`,
          );
        }
        perPageKeys.set(key, { value: valueSig, source: source.pluginSlug });
        perPage.push(parsed.data);
      }
      head.set(pageId, perPage);
      headKeys.set(pageId, perPageKeys);
    }

    for (const [pageId, raw] of Object.entries(value.sitemap ?? {})) {
      const parsed = sitemapContribution.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `head-composition: plugin "${source.pluginSlug}" returned an invalid sitemap contribution for page ${pageId}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      const existing = sitemap.get(pageId);
      if (!existing) {
        sitemap.set(pageId, parsed.data);
        continue;
      }
      // Merge: exclusion is sticky-true; alternates concatenate with
      // hreflang-key dedup + contradiction check.
      const mergedAlternates = [...(existing.alternates ?? [])];
      for (const alt of parsed.data.alternates ?? []) {
        const clash = mergedAlternates.find((a) => a.hreflang === alt.hreflang);
        if (clash) {
          if (clash.href === alt.href) continue;
          throw new Error(
            `head-composition: contradictory sitemap alternates for page ${pageId} hreflang="${alt.hreflang}": "${clash.href}" vs "${alt.href}"`,
          );
        }
        mergedAlternates.push(alt);
      }
      sitemap.set(pageId, {
        ...(existing.exclude || parsed.data.exclude ? { exclude: true } : {}),
        ...(mergedAlternates.length > 0 ? { alternates: mergedAlternates } : {}),
      });
    }
  }

  return { head, sitemap };
}

// ---------------------------------------------------------------------------
// Serialization — ONE renderer for generator + preview.
// ---------------------------------------------------------------------------

function escapeAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Serialize validated head entries to the HTML block appended after the
 * core SEO head. Deterministic order (stable sort by identity key) so
 * generator and preview emit byte-identical output for the same
 * entries regardless of plugin iteration order.
 */
export function renderHeadEntries(entries: ReadonlyArray<HeadEntry>): string {
  const sorted = [...entries].sort((a, b) => headEntryKey(a).localeCompare(headEntryKey(b)));
  const lines: string[] = [];
  for (const e of sorted) {
    if (e.kind === "link") {
      const attrs = [
        `rel="${escapeAttr(e.rel)}"`,
        ...(e.hreflang ? [`hreflang="${escapeAttr(e.hreflang)}"`] : []),
        `href="${escapeAttr(e.href)}"`,
        ...(e.media ? [`media="${escapeAttr(e.media)}"`] : []),
        ...(e.type ? [`type="${escapeAttr(e.type)}"`] : []),
      ];
      lines.push(`<link ${attrs.join(" ")} />`);
    } else {
      const ident =
        e.name !== undefined
          ? `name="${escapeAttr(e.name)}"`
          : `property="${escapeAttr(e.property ?? "")}"`;
      lines.push(`<meta ${ident} content="${escapeAttr(e.content)}" />`);
    }
  }
  return lines.join("\n");
}

/**
 * The ONE head-assembly join for generator + preview: core SEO head
 * block + contributed entries. Byte parity between the two surfaces is
 * by construction — both call this with the same inputs.
 */
export function composeHeadBlock(
  seoHeadBlock: string,
  entries: ReadonlyArray<HeadEntry> | undefined,
): string {
  if (!entries || entries.length === 0) return seoHeadBlock;
  return `${seoHeadBlock}\n${renderHeadEntries(entries)}`;
}
