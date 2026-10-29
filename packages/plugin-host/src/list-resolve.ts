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
 * Called once per build for every variant — the variants are known
 * before the first page renders, and the template engine resolves
 * synchronously — and once per editor preview for the rendered page's
 * variant, with the page's `scope` (#1223: the lists, content instances
 * and pages that page can show), so a preview costs what its page
 * costs. Without an active contributor (or without variants) nothing is
 * called.
 *
 * Loud (CLAUDE.md §2): a failing plugin op throws (a preview reports it
 * and renders without the overlays, #1087); an ill-formed answer, an
 * answer for a variant that was not asked about, and two plugins setting
 * the same address throw everywhere.
 */

import { type ListResolveScope, listResolveVariantOverlay } from "@caelo-cms/plugin-sdk";
import type { ListOverlayIssue, ListVariantOverlay } from "@caelo-cms/shared";
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
import { reportPluginRenderFailure } from "./render-failures.js";
import { recordPluginError } from "./runtime-health.js";

/** Upper bound of one plugin's serialized answer. */
export const LIST_RESOLVE_ANSWER_MAX_BYTES = 16 * 1024 * 1024;

/** One plugin's overlays, as plain JSON (they cross the build RPC). */
export interface PluginListOverlays {
  readonly slug: string;
  readonly overlays: Readonly<
    Record<
      string,
      { readonly values: Readonly<Record<string, unknown>>; readonly hidden: readonly string[] }
    >
  >;
}

/** Every contributing plugin's answer for one render. */
export interface ResolvedListOverlays {
  readonly plugins: readonly PluginListOverlays[];
}

const answerSchema = z
  .object({ overlays: z.record(z.string(), listResolveVariantOverlay) })
  .strict();

/** True when an active plugin answers the list-resolve point. */
export function hasListResolveContributors(): boolean {
  return contributors().length > 0;
}

function contributors() {
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
  const plugins: PluginListOverlays[] = [];
  if (variants.length === 0) return { plugins };
  const asked = new Set(variants);
  for (const lp of contributors()) {
    const operationName = lp.definition.listResolveOperation as string;
    const label = `list-resolve: ${lp.slug}.${operationName}`;
    const r = await runPluginOperation({
      invocation: renderInvocation(scope),
      pluginSlug: lp.slug,
      operationName,
      args: { variants: [...variants], ...(pageScope ? { scope: pageScope } : {}) },
    });
    if (!r.ok) {
      const reason = `${label} failed: ${r.error.kind}: ${r.error.message}`;
      // #1087 — a preview renders the stored values and flags the plugin.
      if (reportPluginRenderFailure(scope, { slug: lp.slug, point: "list-resolve", reason })) {
        continue;
      }
      throw new Error(reason);
    }
    const size = JSON.stringify(r.value ?? null).length;
    if (size > LIST_RESOLVE_ANSWER_MAX_BYTES) {
      throw new Error(
        `${label}: the answer is ${size} bytes, more than the ${LIST_RESOLVE_ANSWER_MAX_BYTES} a render accepts`,
      );
    }
    const parsed = answerSchema.safeParse(r.value);
    if (!parsed.success) {
      throw new Error(
        `${label}: expected { overlays: Record<variant, { values, hidden }> }: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    for (const variant of Object.keys(parsed.data.overlays)) {
      if (!asked.has(variant)) {
        throw new Error(
          `${label}: answered for variant "${variant}", which this render does not have`,
        );
      }
    }
    plugins.push({ slug: lp.slug, overlays: parsed.data.overlays });
  }
  return { plugins };
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
