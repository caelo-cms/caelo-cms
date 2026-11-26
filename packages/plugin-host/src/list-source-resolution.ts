// SPDX-License-Identifier: MPL-2.0

/**
 * Resolve plugin list sources for a set of pages, batched per plugin
 * (epic #1107, `docs/lists.md` §6).
 *
 * Mirrors `collectContributions` (head/sitemap): one operation call per
 * contributing plugin covering every page in the render pass, rather than
 * a call per page. Both render paths — the editor preview and the static
 * generator — go through here, so a module renders identically in the
 * editor and on the deployed site.
 *
 * The answer crosses the plugin boundary, so it is checked here, before
 * anything renders it (CLAUDE.md §4 "Zod at every boundary"): only pages
 * that were asked about, only names the plugin claimed, at most
 * {@link LIST_MAX_ITEMS} entries per page and source, stable unique ids,
 * and every value valid for the field the source's `node` declares —
 * a key the node does not declare is refused, not passed through.
 *
 * Loud, per CLAUDE.md §2: a failing resolver op throws rather than
 * yielding an empty list (a preview reports it and renders without the
 * plugin, #1087), and a malformed answer throws everywhere. "The plugin
 * is broken" and "this page has no translations" must never look the
 * same — one is a bug to fix, the other is the correct empty state.
 */

import type { PluginListSourceSpec } from "@caelo-cms/plugin-sdk";
import {
  LIST_MAX_ITEMS,
  type PageUrlStyle,
  type PluginSourceEntry,
  pluginValueRefusedMarker,
  refusedPluginValue,
  validateFieldValue,
} from "@caelo-cms/shared";
import { z } from "zod";
import {
  isPluginDisabled,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";
import { overlayListSources } from "./list-source-overlays.js";
import { pluginListSourcesRegistry } from "./list-sources.js";
import {
  checkPluginMedia,
  checkPluginValue,
  describePluginMedia,
  pluginMediaId,
} from "./plugin-values.js";
import { reportPluginRenderFailure } from "./render-failures.js";
import { assertAnswerSize, chunkPageIds } from "./render-points.js";

/** pageId → source name → entries. A missing page or name means "not offered". */
export type ResolvedListSources = ReadonlyMap<
  string,
  Readonly<Record<string, PluginSourceEntry[]>>
>;

/**
 * Upper bound of one plugin's whole answer, serialized. Entries are text
 * for a page's chrome; a multi-megabyte answer is a plugin bug (or an
 * attempt to exhaust the render), refused before it is walked.
 */
export const LIST_SOURCE_ANSWER_MAX_BYTES = 4 * 1024 * 1024;

/**
 * #1729 — pages one list-source call is asked about. An answer grows with
 * its pages (a language switcher: a few hundred bytes per page), so a
 * build asks in chunks that keep each answer far below its 4 MB cap; a
 * preview asks about one page in one call.
 */
export const LIST_SOURCE_PAGES_PER_CALL = 1000;

const entryIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_.:-]{1,128}$/,
    "entry ids are 1-128 letters, digits, '_', '.', ':' or '-' and stay the same across renders",
  );

const answerSchema = z
  .object({
    sources: z.record(z.string(), z.record(z.string(), z.array(z.unknown()))),
  })
  .strict();

const entrySchema = z
  .object({ id: entryIdSchema, values: z.record(z.string(), z.unknown()) })
  .strict();

/**
 * Check one plugin's entries for one page and source against the
 * source's node definition. Throws with the path of the first problem.
 */
export function checkListSourceEntries(
  spec: PluginListSourceSpec,
  raw: readonly unknown[],
  where: string,
): PluginSourceEntry[] {
  if (raw.length > LIST_MAX_ITEMS) {
    throw new Error(
      `${where}: ${raw.length} entries, at most ${LIST_MAX_ITEMS} per page and source`,
    );
  }
  const fields = new Map(spec.node.fields.map((f) => [f.name, f]));
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const at = `${where}[${i}]`;
    const parsed = entrySchema.safeParse(item);
    if (!parsed.success) {
      throw new Error(
        `${at}: expected { id, values }: ${parsed.error.issues.map((x) => `${x.path.join(".") || "entry"}: ${x.message}`).join("; ")}`,
      );
    }
    const { id, values } = parsed.data;
    if (seen.has(id)) throw new Error(`${at}: entry id "${id}" appears twice`);
    seen.add(id);
    for (const key of Object.keys(values)) {
      if (!fields.has(key)) {
        throw new Error(
          `${at}.values.${key}: the source's node declares no field "${key}" (declared: ${[...fields.keys()].join(", ")})`,
        );
      }
    }
    for (const f of fields.values()) {
      const issues = validateFieldValue(f, values[f.name], `${at}.values.${f.name}`);
      if (issues.length > 0) {
        throw new Error(issues.map((x) => `${x.path}: ${x.message}`).join("; "));
      }
    }
    return { id, values };
  });
}

/**
 * @param pageIds pages being rendered in this pass.
 * @param pageUrlStyle the serving target's page URL style, handed to the
 *   plugin so the page links it lists equal the canonical URLs (#590).
 * @returns the entries each page may iterate, in the page's variant
 *   (#1323, `list-source-overlays.ts`), their values checked for the page
 *   (#1729, `plugin-values.ts`). Empty when no active plugin offers any —
 *   the common single-language case, which costs zero plugin calls.
 */
export async function resolveListSources(
  pageIds: ReadonlyArray<string>,
  scope: RenderScope,
  pageUrlStyle: PageUrlStyle,
): Promise<ResolvedListSources> {
  return checkSourceValues(
    await overlayListSources(await sourceEntriesOf(pageIds, scope, pageUrlStyle), scope),
  );
}

/**
 * #1729 (§4.5, Q2 A) — every value a page iterates from a plugin, the
 * plugin's own and an overlay's alike, checked for the field its source's
 * node declares: text escaped, richtext held to prose, links to the
 * allowed schemes, media to library images. A refused value is replaced by
 * its stand-in, so the page keeps the spot raw and records
 * `plugin-value-refused` (a render failure that blocks Publish live);
 * the rest of the source still renders.
 */
async function checkSourceValues(resolved: ResolvedListSources): Promise<ResolvedListSources> {
  if (resolved.size === 0) return resolved;
  const owners = new Map(pluginListSourcesRegistry.catalogue().map((c) => [c.name, c]));
  const mediaIds: string[] = [];
  for (const byName of resolved.values()) {
    for (const [name, entries] of Object.entries(byName)) {
      const media = owners.get(name)?.spec.node.fields.filter((f) => f.type === "media") ?? [];
      for (const entry of entries) {
        for (const f of media) {
          const id = pluginMediaId(entry.values[f.name]);
          if (id !== null) mediaIds.push(id);
        }
      }
    }
  }
  const facts = await describePluginMedia(mediaIds);
  const out = new Map<string, Record<string, PluginSourceEntry[]>>();
  for (const [pageId, byName] of resolved) {
    const bucket: Record<string, PluginSourceEntry[]> = {};
    for (const [name, entries] of Object.entries(byName)) {
      const owner = owners.get(name);
      if (!owner) {
        bucket[name] = [...entries];
        continue;
      }
      const fields = new Map(owner.spec.node.fields.map((f) => [f.name, f]));
      bucket[name] = entries.map((entry) => {
        const values: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(entry.values)) {
          const field = fields.get(key);
          if (!field) {
            values[key] = value;
            continue;
          }
          const mediaRule = field.type === "media" ? checkPluginMedia(value, facts) : null;
          const checked = mediaRule
            ? ({ ok: false, rule: mediaRule } as const)
            : checkPluginValue(field, value);
          values[key] = checked.ok
            ? checked.value
            : refusedPluginValue(
                pluginValueRefusedMarker(owner.pluginSlug, name, key, checked.rule),
              );
        }
        return { id: entry.id, values };
      });
    }
    out.set(pageId, bucket);
  }
  return out;
}

/**
 * The entries the plugins answered, as they stored them: what a variant
 * overlay starts from, and the text a translation is made of.
 *
 * @param pageIds pages being rendered in this pass.
 * @param pageUrlStyle see {@link resolveListSources}.
 */
export async function sourceEntriesOf(
  pageIds: ReadonlyArray<string>,
  scope: RenderScope,
  pageUrlStyle: PageUrlStyle,
): Promise<Map<string, Record<string, PluginSourceEntry[]>>> {
  const out = new Map<string, Record<string, PluginSourceEntry[]>>();
  if (pageIds.length === 0) return out;
  const sources = pluginListSourcesRegistry.activeByOperation();
  if (sources.size === 0) return out;
  for (const source of sources.values()) {
    // An Owner's hot disable leaves the source registered until restart;
    // its names are dormant now (dormantListSourceNames), never called.
    if (isPluginDisabled(source.pluginSlug)) continue;
    // #1729 — one call per chunk of pages (render-points.ts): a preview asks
    // once, a 50 000-page build in a few calls below the wire line.
    for (const chunk of chunkPageIds(pageIds, { maxIds: LIST_SOURCE_PAGES_PER_CALL })) {
      if (!(await askChunk(source, chunk))) break;
    }
  }
  return out;

  /** Ask one plugin about one chunk; false when a preview skips the plugin (#1087). */
  async function askChunk(
    source: { pluginSlug: string; operationName: string; specs: Map<string, PluginListSourceSpec> },
    chunk: string[],
  ): Promise<boolean> {
    const label = `list-sources: ${source.pluginSlug}.${source.operationName}`;
    const r = await runPluginOperation({
      invocation: renderInvocation(scope),
      pluginSlug: source.pluginSlug,
      operationName: source.operationName,
      args: { pageIds: chunk, pageUrlStyle },
      maxAnswerBytes: LIST_SOURCE_ANSWER_MAX_BYTES,
    });
    if (!r.ok) {
      const reason = `${label} failed: ${r.error.kind}: ${r.error.message}`;
      // #1087 — a preview renders this plugin's sources as not offered and
      // flags it; a build throws.
      if (
        reportPluginRenderFailure(scope, { slug: source.pluginSlug, point: "list-sources", reason })
      ) {
        return false;
      }
      throw new Error(reason);
    }
    assertAnswerSize(
      { point: "list-sources", maxAnswerBytes: LIST_SOURCE_ANSWER_MAX_BYTES },
      label,
      r.value,
    );
    const asked = new Set(chunk);
    const parsed = answerSchema.safeParse(r.value);
    if (!parsed.success) {
      throw new Error(
        `${label}: expected { sources: Record<pageId, Record<name, entries[]>> }: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    for (const [pageId, byName] of Object.entries(parsed.data.sources)) {
      if (!asked.has(pageId)) {
        throw new Error(`${label}: answered for page ${pageId}, which is not part of this render`);
      }
      const bucket = out.get(pageId) ?? {};
      for (const [name, raw] of Object.entries(byName)) {
        // A plugin may only fill names it claimed. Anything else would
        // let it shadow another plugin's source by answering for it.
        const spec = source.specs.get(name);
        if (!spec) {
          throw new Error(`${label}: returned source "${name}", which the plugin did not declare`);
        }
        bucket[name] = checkListSourceEntries(
          spec,
          raw,
          `${source.pluginSlug}.${name} (page ${pageId})`,
        );
      }
      out.set(pageId, bucket);
    }
    return true;
  }
}

/**
 * Declared source names nobody answers right now (name → plugin slug):
 * the plugin is not running, or the Owner disabled it without a restart.
 * The renderer turns these into "the plugin is switched off" markers; a
 * build that still contains one refuses to publish (#605).
 */
export function dormantListSourceNames(): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(pluginListSourcesRegistry.dormantNames());
  for (const source of pluginListSourcesRegistry.activeByOperation().values()) {
    if (!isPluginDisabled(source.pluginSlug)) continue;
    for (const name of source.specs.keys()) out[name] = source.pluginSlug;
  }
  return out;
}
