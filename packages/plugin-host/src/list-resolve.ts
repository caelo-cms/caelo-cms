// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — the `list-resolve` composition point (`docs/lists.md`
 * §9.3): what list values, entry visibility and page properties look
 * like in each output variant of the site.
 *
 * Core has no locale concept. A plugin that splits the site into
 * variants (international-site: one per language, through the
 * `link-resolve` partition) answers here with one overlay per variant:
 * values keyed by value address (`list/<listId>/item/<itemId>/<field>`,
 * `instance/<ciId>/<field>/item/<itemId>/<itemField>`,
 * `page/<pageId>/props/<field>`) and the addresses of entries hidden in
 * that variant. The shared resolver applies the overlay of the rendering
 * page's variant; an overlay can replace values and hide entries, never
 * add, remove or reorder them. Whatever the resolver refuses (an address
 * that names nothing, a structural `module` / `term` value, a value
 * failing its field) is reported to the contributing plugin's error
 * channel (`plugin_errors`, #1008) — loud, attributed, and never a
 * reason to switch the plugin off.
 *
 * Always asked before the pages it is for render (the template engine
 * resolves synchronously), with a `scope` (#1223: the lists, content
 * instances and pages those pages can show): once per editor preview for
 * the rendered page's variant, so a preview costs what its page costs,
 * and once per page batch of a build for the batch's variants (#1307,
 * the generator's `list-overlay-batches.ts`), so a build's call costs
 * what the batch costs. Only a list's source preview still asks without
 * a scope (the whole site). Without an active contributor (or without
 * variants) nothing is called.
 *
 * Loud (CLAUDE.md §2): a failing plugin op throws (a preview reports it
 * and renders without the overlays, #1087); an ill-formed answer, an
 * answer for a variant that was not asked about, and two plugins setting
 * the same address throw everywhere.
 */

import { isDeepStrictEqual } from "node:util";
import { type ListResolveScope, listResolveVariantOverlay } from "@caelo-cms/plugin-sdk";
import type { ListOverlayIssue, ListVariantOverlay, PluginMediaFacts } from "@caelo-cms/shared";
import { z } from "zod";
import {
  hostInfra,
  hostSystemActorId,
  isPluginDisabled,
  loadedPlugins,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";
import { describePluginMedia, pluginMediaId } from "./plugin-values.js";
import { reportPluginRenderFailure } from "./render-failures.js";
import {
  assertAnswerSize,
  RENDER_POINT_CHUNK_BYTES,
  type RenderPointCall,
} from "./render-points.js";
import { recordPluginError } from "./runtime-health.js";

/** Upper bound of one call's serialized answer. */
export const LIST_RESOLVE_ANSWER_MAX_BYTES = 16 * 1024 * 1024;

const LIST_RESOLVE_CALL: RenderPointCall = {
  point: "list-resolve",
  maxAnswerBytes: LIST_RESOLVE_ANSWER_MAX_BYTES,
};

/** One variant's overlay of one plugin, as plain JSON. */
interface PluginVariantOverlay {
  readonly values: Readonly<Record<string, unknown>>;
  readonly hidden: readonly string[];
}

/** One plugin's overlays, as plain JSON (they cross the build RPC). */
export interface PluginListOverlays {
  readonly slug: string;
  readonly overlays: Readonly<Record<string, PluginVariantOverlay>>;
}

/** Every contributing plugin's answer for one render. */
export interface ResolvedListOverlays {
  readonly plugins: readonly PluginListOverlays[];
  /**
   * #1729 — what the media table says of every `caelo:media/<id>` the
   * answers carry (`describePluginMedia`), so the list resolver can hold a
   * `media` field's overlay to library images (§4.5) without a read of its
   * own. JSON, like the overlays.
   */
  readonly media?: Readonly<Record<string, PluginMediaFacts>>;
}

const answerSchema = z
  .object({ overlays: z.record(z.string(), listResolveVariantOverlay) })
  .strict();

/** True when an active plugin answers the list-resolve point. */
export function hasListResolveContributors(): boolean {
  return listResolveContributors().length > 0;
}

/** The plugins answering `list-resolve`, in a stable order. */
export function listResolveContributors() {
  return loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.listResolveOperation === "string")
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Ask every contributing plugin for its overlays.
 *
 * @param variants the output variants of this render (the distinct
 *   variants of the `link-resolve` partition).
 * @param pageScope what the one page a preview renders can show from
 *   lists; absent = the whole site (a build).
 */
export async function resolveListOverlays(
  variants: ReadonlyArray<string>,
  scope: RenderScope,
  pageScope?: ListResolveScope,
): Promise<ResolvedListOverlays> {
  if (variants.length === 0) return { plugins: [] };
  return askListResolve(listResolveContributors(), variants, scope, () => pageScope);
}

/** One plugin's overlays while its parts arrive, by variant and address. */
export type OverlayAccumulator = Map<
  string,
  { readonly values: Map<string, unknown>; readonly hidden: Set<string> }
>;

/**
 * Merge one part of a plugin's answer into `into`. Keyed by Map, not by
 * object: a variant token or an address is any string the plugin names,
 * `constructor` and `__proto__` included, and an object would hand back
 * an inherited property for it.
 *
 * @throws on a variant the render did not ask about, or an address two
 *   parts give different values.
 */
export function mergeOverlayPart(
  into: OverlayAccumulator,
  part: Readonly<
    Record<string, { readonly values: Record<string, unknown>; readonly hidden: readonly string[] }>
  >,
  asked: ReadonlySet<string>,
  label: string,
): void {
  for (const [variant, overlay] of Object.entries(part)) {
    if (!asked.has(variant)) {
      throw new Error(
        `${label}: answered for variant "${variant}", which this render does not have`,
      );
    }
    let merged = into.get(variant);
    if (merged === undefined) {
      merged = { values: new Map(), hidden: new Set() };
      into.set(variant, merged);
    }
    for (const [address, value] of Object.entries(overlay.values)) {
      // Parts of one scope may each carry an address (an answer may be
      // wider than its scope); they must agree on its value.
      if (merged.values.has(address) && !isDeepStrictEqual(merged.values.get(address), value)) {
        throw new Error(
          `${label}: "${address}" in variant ${variant} has two different values in one render`,
        );
      }
      merged.values.set(address, value);
    }
    for (const address of overlay.hidden) merged.hidden.add(address);
  }
}

/** The merged overlays as an answer carries them (own properties only, via `Object.fromEntries`). */
export function overlaysRecord(
  from: OverlayAccumulator,
): Record<string, { values: Record<string, unknown>; hidden: string[] }> {
  return Object.fromEntries(
    [...from].map(([variant, o]) => [
      variant,
      { values: Object.fromEntries(o.values), hidden: [...o.hidden] },
    ]),
  );
}

/**
 * Ask these plugins for their overlays of `variants`.
 *
 * @param scopeFor the `scope` each plugin is asked with; a plugin's answer
 *   is only as wide as its scope, and #1323's source texts differ per asker.
 */
export async function askListResolve(
  plugins: ReturnType<typeof listResolveContributors>,
  variants: ReadonlyArray<string>,
  scope: RenderScope,
  scopeFor: (pluginSlug: string) => ListResolveScope | undefined,
): Promise<ResolvedListOverlays> {
  const answers: PluginListOverlays[] = [];
  const asked = new Set(variants);
  for (const lp of plugins) {
    const operationName = lp.definition.listResolveOperation as string;
    const label = `list-resolve: ${lp.slug}.${operationName}`;
    const overlays: OverlayAccumulator = new Map();
    let failed = false;
    // #1729 — a scope too big for one wire line is asked in parts
    // (render-points.ts); a preview's scope is one page's and fits in one.
    for (const pageScope of chunkListResolveScope(scopeFor(lp.slug))) {
      const r = await runPluginOperation({
        invocation: renderInvocation(scope),
        pluginSlug: lp.slug,
        operationName,
        args: { variants: [...variants], ...(pageScope ? { scope: pageScope } : {}) },
        maxAnswerBytes: LIST_RESOLVE_ANSWER_MAX_BYTES,
      });
      if (!r.ok) {
        const reason = `${label} failed: ${r.error.kind}: ${r.error.message}`;
        // #1087 — a preview renders the stored values and flags the plugin.
        if (reportPluginRenderFailure(scope, { slug: lp.slug, point: "list-resolve", reason })) {
          failed = true;
          break;
        }
        throw new Error(reason);
      }
      // A shipped plugin answers in-process: held to the cap a sandboxed
      // answer meets while its parts arrive.
      assertAnswerSize(LIST_RESOLVE_CALL, label, r.value);
      const parsed = answerSchema.safeParse(r.value);
      if (!parsed.success) {
        throw new Error(
          `${label}: expected { overlays: Record<variant, { values, hidden }> }: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      }
      mergeOverlayPart(overlays, parsed.data.overlays, asked, label);
    }
    if (failed) continue;
    answers.push({ slug: lp.slug, overlays: overlaysRecord(overlays) });
  }
  const mediaIds = answers.flatMap((p) =>
    Object.values(p.overlays).flatMap((o) =>
      Object.values(o.values).flatMap((v) => {
        const id = pluginMediaId(v);
        return id === null ? [] : [id];
      }),
    ),
  );
  if (mediaIds.length === 0) return { plugins: answers };
  return {
    plugins: answers,
    media: Object.fromEntries(await describePluginMedia(mediaIds)),
  };
}

/**
 * #1729 — a `list-resolve` scope in parts whose JSON stays within the
 * render-point chunk (512 KB): its lists, content instances and pages
 * split in order, then the entries of its plugin sources, each part
 * carrying the name, label and fields of the sources it holds entries of.
 * No scope (a build asks about the whole site) is one call without one.
 */
export function chunkListResolveScope(
  scope: ListResolveScope | undefined,
  maxBytes = RENDER_POINT_CHUNK_BYTES,
): (ListResolveScope | undefined)[] {
  if (scope === undefined) return [undefined];
  if (Buffer.byteLength(JSON.stringify(scope)) <= maxBytes) return [scope];
  const json = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  const empty = (): ListResolveScope => ({ listIds: [], contentInstanceIds: [], pageIds: [] });
  const EMPTY_BYTES = json(empty());
  const parts: ListResolveScope[] = [];
  let part = empty();
  let bytes = EMPTY_BYTES;
  /** Start a new part when `size` more bytes would not fit a part that holds something. */
  const room = (size: number) => {
    if (bytes + size > maxBytes && bytes > EMPTY_BYTES) {
      parts.push(part);
      part = empty();
      bytes = EMPTY_BYTES;
    }
  };
  for (const key of ["listIds", "contentInstanceIds", "pageIds"] as const) {
    for (const id of scope[key]) {
      const size = json(id) + 1;
      room(size);
      (part[key] as string[]).push(id);
      bytes += size;
    }
  }
  // `,"sources":[]` in a part, written once per part.
  const SOURCES_KEY_BYTES = json({ sources: [] }) - 1;
  for (const source of scope.sources ?? []) {
    const header = { name: source.name, label: source.label, fields: source.fields };
    const headerBytes = json({ ...header, entries: [] }) + 1;
    let holder: NonNullable<ListResolveScope["sources"]>[number] | undefined;
    for (const entry of source.entries) {
      const size = json(entry) + 1;
      room(size + (holder ? 0 : headerBytes + (part.sources ? 0 : SOURCES_KEY_BYTES)));
      // A new part holds none of this source yet: its metadata opens it there.
      if (holder && !part.sources?.includes(holder)) holder = undefined;
      if (!holder) {
        if (!part.sources) {
          part.sources = [];
          bytes += SOURCES_KEY_BYTES;
        }
        holder = { ...header, entries: [] };
        part.sources.push(holder);
        bytes += headerBytes;
      }
      holder.entries.push(entry);
      bytes += size;
    }
  }
  parts.push(part);
  return parts;
}

/**
 * Merge the plugins' answers into the resolver's `ListRenderData.overlays`
 * shape. Two plugins setting the same address in one variant cannot both
 * decide what it shows; whichever won would silently override the other,
 * so that throws. Hidden addresses union.
 */
export function mergeListOverlays(resolved: ResolvedListOverlays): Map<string, ListVariantOverlay> {
  const values = new Map<string, Map<string, unknown>>();
  const hidden = new Map<string, Set<string>>();
  const owner = new Map<string, string>();
  const owners = new Map<string, Map<string, string>>();
  const media: ReadonlyMap<string, PluginMediaFacts> = new Map(
    Object.entries(resolved.media ?? {}),
  );
  for (const p of resolved.plugins) {
    for (const [variant, o] of Object.entries(p.overlays)) {
      const v = values.get(variant) ?? new Map<string, unknown>();
      for (const [address, value] of Object.entries(o.values)) {
        const key = `${variant}|${address}`;
        const other = owner.get(key);
        if (other !== undefined && other !== p.slug) {
          throw new Error(
            `list-resolve: "${address}" in variant ${variant} is set by both "${other}" and "${p.slug}". An address can have one overlay.`,
          );
        }
        owner.set(key, p.slug);
        v.set(address, value);
        const o = owners.get(variant) ?? new Map<string, string>();
        o.set(address, p.slug);
        owners.set(variant, o);
      }
      values.set(variant, v);
      const h = hidden.get(variant) ?? new Set<string>();
      for (const address of o.hidden) h.add(address);
      hidden.set(variant, h);
    }
  }
  const out = new Map<string, ListVariantOverlay>();
  for (const variant of new Set([...values.keys(), ...hidden.keys()])) {
    out.set(variant, {
      values: values.get(variant) ?? new Map(),
      hidden: hidden.get(variant) ?? new Set(),
      // #1729 — who set each value and what the media table says of the
      // media they name: the resolver checks each value for its field (§4.5).
      owners: owners.get(variant) ?? new Map(),
      media,
    });
  }
  return out;
}

/** The plugin whose overlay carried `issue`, or null when none did. */
export function overlayIssueOwner(
  resolved: ResolvedListOverlays,
  issue: ListOverlayIssue,
): string | null {
  for (const p of resolved.plugins) {
    const o = p.overlays[issue.variant];
    if (!o) continue;
    if (Object.hasOwn(o.values, issue.address) || o.hidden.includes(issue.address)) return p.slug;
  }
  return null;
}

/** How many refused entries one recorded error names; the count says the rest. */
const ISSUES_PER_REPORT = 20;

/**
 * Report the overlay entries a render refused to the plugins that sent
 * them: one `plugin_errors` record per plugin and render (repeats of the
 * same refusal fold into one row by fingerprint), phase `render`, class
 * `plugin`. Health in `list_plugins` / Settings → Plugins shows it; the
 * plugin keeps running (#1008).
 */
export async function reportListOverlayIssues(
  resolved: ResolvedListOverlays,
  issues: readonly ListOverlayIssue[],
): Promise<void> {
  const byPlugin = new Map<string, ListOverlayIssue[]>();
  for (const issue of issues) {
    const slug = overlayIssueOwner(resolved, issue);
    if (slug === null) continue;
    const list = byPlugin.get(slug) ?? [];
    list.push(issue);
    byPlugin.set(slug, list);
  }
  for (const [slug, list] of byPlugin) {
    const shown = list
      .slice(0, ISSUES_PER_REPORT)
      .map((i) => `[${i.variant}] ${i.address}: ${i.reason}`)
      .join("; ");
    const more =
      list.length > ISSUES_PER_REPORT ? `; and ${list.length - ISSUES_PER_REPORT} more` : "";
    await recordPluginError({
      infra: hostInfra(),
      systemActorId: hostSystemActorId(),
      slug,
      pluginId: loadedPlugins.bySlug(slug)?.pluginId ?? null,
      phase: "render",
      error: new Error(
        `list-resolve: the render refused ${list.length} overlay entr${list.length === 1 ? "y" : "ies"} (an overlay may only replace values of existing entries and hide them): ${shown}${more}`,
      ),
    });
  }
}
