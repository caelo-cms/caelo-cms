// SPDX-License-Identifier: MPL-2.0

/**
 * #592 — the content-variants composition point: which content a
 * placement shows on the page being rendered.
 *
 * Site chrome — header, footer, menus — is placed once in a layout (or
 * as a content instance synced across pages), so without help every page
 * shows the same chrome in the same language. A plugin that knows more
 * about the page (international-site knows its locale) can answer, per
 * placement: render these values instead, or (layout placements only)
 * render this other module, or — loudly — this placement has a problem
 * (no variant for the page's language). Internal links inside the
 * values are not the plugin's business: core resolves them per page
 * through the link-resolve point (link-resolve.ts).
 *
 * Without an active contributor nothing changes and no plugin is called.
 * The editor preview and the static generator both resolve through here
 * in one batched call per contributing plugin, so the two surfaces show
 * the same chrome by construction.
 *
 * Loud (CLAUDE.md §2): a failing plugin op, an ill-formed answer, a
 * module override on a page placement, and two plugins answering for the
 * same placement all throw. Problems are not errors here — the caller
 * decides: the preview flags them, the build refuses to ship.
 *
 * #1729 — the pages are asked in chunks below the wire line, each answer
 * capped (render-points.ts), and every value is held to the rule for the
 * field of the module that renders it ({@link checkContentVariantValues},
 * §4.5) once the caller knows that module (a layout variant may render
 * another one): the preview (`preview-variants.ts`) and the build
 * (`content-variants-pass.ts`) both run it, for every plugin.
 */

import { isDeepStrictEqual } from "node:util";
import {
  type ContentVariantPage,
  type ContentVariantResolution,
  contentVariantResolution,
} from "@caelo-cms/plugin-sdk";
import {
  LIST_REF_RE,
  type PluginListOwner,
  type PluginMediaFacts,
  parseLinkFieldValue,
  pluginLocalList,
  pluginValue,
  pluginValueRefusedMarker,
  refusedPluginValue,
} from "@caelo-cms/shared";
import {
  isPluginDisabled,
  loadedPlugins,
  type RenderScope,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";
import {
  checkPluginMedia,
  checkPluginValue,
  describePluginMedia,
  pluginMediaId,
} from "./plugin-values.js";
import { reportPluginRenderFailure } from "./render-failures.js";
import { assertAnswerSize, chunkItems, type RenderPointCall } from "./render-points.js";

/** #1729 — the largest answer one content-variants call returns, serialized. */
export const CONTENT_VARIANTS_ANSWER_MAX_BYTES = 4 * 1024 * 1024;

const CONTENT_VARIANTS_CALL: RenderPointCall = {
  point: "content-variants",
  maxAnswerBytes: CONTENT_VARIANTS_ANSWER_MAX_BYTES,
};

/** One placement's resolved answer; `problems` always present (maybe empty). */
export interface ResolvedContentVariant {
  readonly pluginSlug: string;
  readonly moduleId?: string;
  /** As the plugin answered: check them with {@link checkContentVariantValues} before rendering. */
  readonly values?: Readonly<Record<string, unknown>>;
  readonly problems: readonly string[];
  /** #1729 — what the media table says of the media `values` name (§4.5). */
  readonly media?: Readonly<Record<string, PluginMediaFacts>>;
}

/** pageId → placementKey → answer. A missing entry renders as stored. */
export type ResolvedContentVariants = ReadonlyMap<
  string,
  ReadonlyMap<string, ResolvedContentVariant>
>;

/** True when an active plugin resolves content variants — callers skip
 *  building the placement payload entirely otherwise. */
export function hasContentVariantContributors(): boolean {
  return contributors().length > 0;
}

function contributors() {
  return loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.contentVariantsOperation === "string")
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Ask every contributing plugin which content each placement shows.
 *
 * @param pages every page of the render pass with its placements.
 */
export async function resolveContentVariants(
  pages: ReadonlyArray<ContentVariantPage>,
  scope: RenderScope,
): Promise<ResolvedContentVariants> {
  const out = new Map<string, Map<string, ResolvedContentVariant>>();
  if (pages.length === 0) return out;
  const plugins = contributors();
  if (plugins.length === 0) return out;

  const scopeByKey = new Map<string, "layout" | "page">();
  for (const p of pages) {
    for (const pl of p.placements) scopeByKey.set(`${p.pageId}|${pl.key}`, pl.scope);
  }

  for (const lp of plugins) {
    const operationName = lp.definition.contentVariantsOperation as string;
    const label = `content-variants: ${lp.slug}.${operationName}`;
    // #1729 — one call per chunk of pages (render-points.ts): a preview
    // asks about its one page, a build in calls below the 1 MB wire line.
    const resolutions: Record<string, Record<string, unknown>> = {};
    let failed = false;
    for (const chunk of chunkItems(pages)) {
      const r = await runPluginOperation({
        invocation: renderInvocation(scope),
        pluginSlug: lp.slug,
        operationName,
        args: { pages: chunk },
        maxAnswerBytes: CONTENT_VARIANTS_ANSWER_MAX_BYTES,
      });
      if (!r.ok) {
        const reason = `${label} failed: ${r.error.kind}: ${r.error.message}`;
        // #1087 — a preview shows core's content for this plugin's
        // placements and flags it; a build throws.
        if (
          reportPluginRenderFailure(scope, { slug: lp.slug, point: "content-variants", reason })
        ) {
          failed = true;
          break;
        }
        throw new Error(reason);
      }
      // A shipped plugin answers in-process: held to the cap a sandboxed
      // answer meets while its parts arrive.
      assertAnswerSize(CONTENT_VARIANTS_CALL, label, r.value);
      const answer = r.value as { resolutions?: unknown } | null;
      const byPage = answer?.resolutions ?? {};
      if (typeof byPage !== "object" || byPage === null || Array.isArray(byPage)) {
        throw new Error(
          `${label}: expected { resolutions: Record<pageId, Record<placementKey, …>> }`,
        );
      }
      const asked = new Set(chunk.map((p) => p.pageId));
      for (const [pageId, byKey] of Object.entries(byPage as Record<string, unknown>)) {
        if (!asked.has(pageId)) {
          throw new Error(
            `content-variants: plugin "${lp.slug}" answered for page ${pageId}, which is not part of this render pass`,
          );
        }
        resolutions[pageId] = byKey as Record<string, unknown>;
      }
    }
    if (failed) continue;
    for (const [pageId, byKey] of Object.entries(resolutions)) {
      const perPage = out.get(pageId) ?? new Map<string, ResolvedContentVariant>();
      for (const [key, raw] of Object.entries(byKey)) {
        const placementScope = scopeByKey.get(`${pageId}|${key}`);
        if (placementScope === undefined) {
          throw new Error(
            `content-variants: plugin "${lp.slug}" answered for placement "${key}" on page ${pageId}, which is not part of this render pass`,
          );
        }
        const parsed = contentVariantResolution.safeParse(raw);
        if (!parsed.success) {
          throw new Error(
            `content-variants: plugin "${lp.slug}" returned an invalid resolution for placement "${key}" on page ${pageId}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          );
        }
        const res: ContentVariantResolution = parsed.data;
        if (res.moduleId !== undefined && placementScope !== "layout") {
          throw new Error(
            `content-variants: plugin "${lp.slug}" swapped the module of page placement "${key}" on page ${pageId}; only layout placements may render a different module`,
          );
        }
        const existing = perPage.get(key);
        if (existing) {
          // Two plugins rewriting one placement cannot both win; whichever
          // did would silently drop the other's content.
          throw new Error(
            `content-variants: placement "${key}" on page ${pageId} is resolved by both "${existing.pluginSlug}" and "${lp.slug}". A placement can have at most one resolver.`,
          );
        }
        perPage.set(key, {
          pluginSlug: lp.slug,
          ...(res.moduleId !== undefined ? { moduleId: res.moduleId } : {}),
          ...(res.values !== undefined ? { values: res.values } : {}),
          problems: res.problems ?? [],
        });
      }
      out.set(pageId, perPage);
    }
  }
  return withMediaFacts(out);
}

/** Attach to each answer what the media table says of the media its values name. */
async function withMediaFacts(
  resolved: Map<string, Map<string, ResolvedContentVariant>>,
): Promise<Map<string, Map<string, ResolvedContentVariant>>> {
  const idsOf = (res: ResolvedContentVariant): string[] => {
    const ids: string[] = [];
    walkStrings(res.values, (s) => {
      const id = pluginMediaId(s);
      if (id !== null) ids.push(id);
    });
    return ids;
  };
  const all = [...resolved.values()].flatMap((byKey) => [...byKey.values()].flatMap(idsOf));
  if (all.length === 0) return resolved;
  const facts = await describePluginMedia(all);
  for (const byKey of resolved.values()) {
    for (const [key, res] of byKey) {
      const ids = idsOf(res);
      if (ids.length === 0) continue;
      byKey.set(key, {
        ...res,
        media: Object.fromEntries(
          ids.flatMap((id) => {
            const f = facts.get(id);
            return f ? [[id, f]] : [];
          }),
        ),
      });
    }
  }
  return resolved;
}

/** Visit every string inside a JSON value. */
function walkStrings(value: unknown, visit: (s: string) => void): void {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const v of value) walkStrings(v, visit);
  else if (value !== null && typeof value === "object")
    for (const v of Object.values(value)) walkStrings(v, visit);
}

/** A module field as the content-variants check reads it. */
export interface ContentVariantField {
  readonly name: string;
  readonly kind?: string;
}

/**
 * #1729 (§4.5, Q2 A) — the values a content variant hands a placement,
 * checked for the fields of the module that renders them, for every
 * plugin. A value equal to what core would render there (`stored`) is
 * core's own and stays as it is. Otherwise:
 *
 * - `text`: HTML-escaped; `richtext`: prose only; `url`, `link`: the link
 *   rule; `image`: a library image (`caelo:media/<id>`); `number`,
 *   `boolean`: their type.
 * - `list`: its entries are checked without their list type (which the
 *   point does not carry): every string held to the prose rule, every
 *   `href` to the link rule, every media reference to the media rule.
 * - `module`, `module-list`: structure, which a variant may not change
 *   (a layout variant swaps the whole module instead).
 * - A key the module does not declare.
 *
 * A refused value becomes its stand-in (`plugin-value-refused`), which the
 * template engine records as a render failure and keeps raw: Publish live
 * refuses it, never a cleaned or source-language value.
 *
 * @param key the placement (`layout:<block>:<i>`), named in the marker.
 */
export function checkContentVariantValues(input: {
  readonly pluginSlug: string;
  readonly key: string;
  readonly fields: ReadonlyArray<ContentVariantField>;
  readonly stored: Readonly<Record<string, unknown>>;
  readonly values: Readonly<Record<string, unknown>>;
  readonly media?: Readonly<Record<string, PluginMediaFacts>>;
}): Record<string, unknown> {
  const fields = new Map(input.fields.map((f) => [f.name, f.kind ?? "text"]));
  const media = new Map(Object.entries(input.media ?? {}));
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input.values)) {
    const kind = fields.get(name);
    if (kind !== undefined && isDeepStrictEqual(value, input.stored[name])) {
      out[name] = value;
      continue;
    }
    const checked =
      kind === undefined
        ? ({ ok: false, rule: "undeclared-field" } as const)
        : variantValueCheck(kind, value, media, () => ({
            plugin: input.pluginSlug,
            address: `${input.key}/${name}`,
            ...(input.media ? { media: input.media } : {}),
          }));
    // A checked value stays the plugin's: the template engine escapes or
    // refuses it by where the module places it. A list is checked where it
    // renders (pluginLocalList) or names a shared list.
    out[name] = checked.ok
      ? kind === "list" || checked.value === undefined || checked.value === null
        ? checked.value
        : pluginValue(
            {
              plugin: input.pluginSlug,
              point: "content-variants",
              address: `${input.key}/${name}`,
              type: kind ?? "text",
            },
            checked.value,
          )
      : refusedPluginValue(
          pluginValueRefusedMarker(
            input.pluginSlug,
            "content-variants",
            `${input.key}/${name}`,
            checked.rule,
          ),
        );
  }
  return out;
}

type Check =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly rule: string };

function variantValueCheck(
  kind: string,
  value: unknown,
  media: ReadonlyMap<string, PluginMediaFacts>,
  owner: () => PluginListOwner,
): Check {
  if (value === undefined || value === null) return { ok: true, value };
  switch (kind) {
    // No write checked a variant's shape: a value of another type would
    // reach the template unescaped (an array is stringified as it is).
    case "text":
    case "richtext":
      return typeof value === "string"
        ? checkPluginValue({ name: "v", label: "v", type: kind }, value)
        : { ok: false, rule: `type-${kind}` };
    case "url":
      return typeof value === "string"
        ? checkPluginValue({ name: "v", label: "v", type: "link" }, value)
        : { ok: false, rule: "type-url" };
    case "link":
      return parseLinkFieldValue(value) !== null
        ? checkPluginValue({ name: "v", label: "v", type: "link" }, value)
        : { ok: false, rule: "type-link" };
    case "image": {
      if (pluginMediaId(value) === null) return { ok: false, rule: "media-not-library-image" };
      const rule = checkPluginMedia(value, media);
      return rule === null ? { ok: true, value } : { ok: false, rule };
    }
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, rule: "type-number" };
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, rule: "type-boolean" };
    case "list":
      // Local entries are checked where the list renders, against the
      // fields of its list type; a shared list is chosen by reference.
      if (Array.isArray(value)) return { ok: true, value: pluginLocalList(owner(), value) };
      return typeof value === "string" && LIST_REF_RE.test(value)
        ? { ok: true, value }
        : { ok: false, rule: "type-list" };
    default:
      return { ok: false, rule: "structural-field" };
  }
}

/**
 * The marker the preview's missing-content surface shows for a problem,
 * and the build names in its refusal — one wording for both surfaces.
 */
export function contentVariantProblemMarker(pluginSlug: string, problem: string): string {
  return `content-variant:${pluginSlug}:${problem}`;
}
