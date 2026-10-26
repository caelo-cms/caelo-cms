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
  validateFieldValue,
} from "@caelo-cms/shared";
import { z } from "zod";
import {
  isPluginDisabled,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";
import { pluginListSourcesRegistry } from "./list-sources.js";
import { reportPluginRenderFailure } from "./render-failures.js";

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
 * @returns the entries each page may iterate. Empty when no active plugin
 *   offers any — the common single-language case, which costs zero
 *   plugin calls.
 */
export async function resolveListSources(
  pageIds: ReadonlyArray<string>,
  scope: RenderScope,
  pageUrlStyle: PageUrlStyle,
): Promise<ResolvedListSources> {
  const out = new Map<string, Record<string, PluginSourceEntry[]>>();
  if (pageIds.length === 0) return out;
  const sources = pluginListSourcesRegistry.activeByOperation();
  if (sources.size === 0) return out;
  const asked = new Set(pageIds);

  for (const source of sources.values()) {
    // An Owner's hot disable leaves the source registered until restart;
    // its names are dormant now (dormantListSourceNames), never called.
    if (isPluginDisabled(source.pluginSlug)) continue;
    const label = `list-sources: ${source.pluginSlug}.${source.operationName}`;
    const r = await runPluginOperation({
      invocation: renderInvocation(scope),
      pluginSlug: source.pluginSlug,
      operationName: source.operationName,
      args: { pageIds: [...pageIds], pageUrlStyle },
    });
    if (!r.ok) {
      const reason = `${label} failed: ${r.error.kind}: ${r.error.message}`;
      // #1087 — a preview renders this plugin's sources as not offered and
      // flags it; a build throws.
      if (
        reportPluginRenderFailure(scope, { slug: source.pluginSlug, point: "list-sources", reason })
      ) {
        continue;
      }
      throw new Error(reason);
    }
    const size = JSON.stringify(r.value ?? null).length;
    if (size > LIST_SOURCE_ANSWER_MAX_BYTES) {
      throw new Error(
        `${label}: the answer is ${size} bytes, more than the ${LIST_SOURCE_ANSWER_MAX_BYTES} a render accepts`,
      );
    }
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
  }
  return out;
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
