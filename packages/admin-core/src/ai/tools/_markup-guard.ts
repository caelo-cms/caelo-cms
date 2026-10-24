// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #820 — write-time reuse hints for markup, the early half of the
 * core `structure` quality check (quality/checks/structure.ts).
 *
 * Two moments, both warnings on an already-successful write (like the
 * rest of the design guard), never a gate:
 *
 * - A module mint / html edit: is this markup structurally identical (or
 *   nearly) to a module the site already has, or does it contain another
 *   module's markup? Then place / nest that module instead of a copy.
 * - A field-value write: does a text/richtext value carry a component
 *   pattern (a step chain, a comparison table) that now sits in two or
 *   more placements? The second copy is the moment to make it a module.
 *   A one-off on one placement stays silent — that is allowed. One
 *   exception (#1068): a pattern written out three or more times side by
 *   side in one value is a list of items as hand-written HTML, on one
 *   placement too; the hint points at a module-list.
 *
 * Exact structural matches only for field values: near matches are the
 * quality check's job (it sees the whole staged build); here a hint has
 * to be certain enough to act on in the same turn.
 */

import { execute } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  isPattern,
  NEAR_MATCH_THRESHOLD,
  outermostPatterns,
  parseMarkup,
  patternLabel,
  repeatedSiblingPatterns,
  type SubtreeShape,
  shapeSimilarity,
  shapeTree,
  stripMustache,
  templateShape,
} from "@caelo-cms/shared";
import {
  hasRepeatCandidates,
  repeatedValueHints,
  type ValueInstance,
} from "./_repeated-value-guard.js";
import type { ToolContext, ToolDefinitionWithHandler } from "./dispatch.js";

/** A module as the guard compares against it. */
export interface CatalogModule {
  readonly id: string;
  readonly displayName: string;
  readonly html: string;
}

/** Most "contains module X" hints for one template. */
const MAX_NESTED_HINTS = 3;

/**
 * Hints for a module template being minted or edited.
 *
 * @param excludeModuleIds - the module(s) this write created or edited;
 *   they are in the catalog already and must not match themselves.
 */
export function moduleReuseHints(
  html: string,
  catalog: readonly CatalogModule[],
  excludeModuleIds: readonly string[] = [],
): string[] {
  const root = parseMarkup(stripMustache(html))[0];
  if (!root) return [];
  const shapes = shapeTree(root);
  const own = shapes.get(root);
  const others = catalog
    .filter((m) => !excludeModuleIds.includes(m.id))
    .map((m) => ({ m, shape: templateShape(m.html) }))
    .filter((o): o is { m: CatalogModule; shape: SubtreeShape } => o.shape !== null)
    .filter((o) => isPattern(o.shape));
  const hints: string[] = [];
  if (own && isPattern(own)) {
    const exact = others.find((o) => o.shape.signature === own.signature);
    const near = exact
      ? undefined
      : others
          .map((o) => ({ ...o, score: shapeSimilarity(own, o.shape) }))
          .filter((o) => o.score >= NEAR_MATCH_THRESHOLD)
          .sort((a, b) => b.score - a.score)[0];
    if (exact) {
      hints.push(
        `this markup is structurally identical to the existing module "${exact.m.displayName}" (${exact.m.id}) — place that module by moduleId with this content as values (edit_module it if it must change) instead of keeping a copy; two copies fail the structure quality check`,
      );
    } else if (near) {
      hints.push(
        `this markup is nearly identical to the existing module "${near.m.displayName}" (${near.m.id}) — reuse that module (add a field for what differs) instead of a near-copy`,
      );
    }
  }
  const bySig = new Map(others.map((o) => [o.shape.signature, o.m]));
  const nested = new Set<CatalogModule>();
  for (const [node, shape] of shapes) {
    if (node === root || !isPattern(shape)) continue;
    const m = bySig.get(shape.signature);
    if (m) nested.add(m);
  }
  for (const m of [...nested].slice(0, MAX_NESTED_HINTS)) {
    hints.push(
      `it contains the markup of module "${m.displayName}" (${m.id}) — nest that module through a \`module\` field ({{>field}}) instead of copying its HTML`,
    );
  }
  return hints;
}

/** A pattern found in one field value of a write. */
interface ValuePattern {
  readonly field: string;
  readonly label: string;
  readonly shape: SubtreeShape;
}

/** The component patterns inside string values (and string list items). */
export function valuePatterns(values: Readonly<Record<string, unknown>>): ValuePattern[] {
  const out: ValuePattern[] = [];
  for (const [field, value] of Object.entries(values)) {
    const strings = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    for (const s of strings) {
      if (typeof s !== "string" || !s.includes("class=")) continue;
      for (const p of outermostPatterns(parseMarkup(s))) {
        out.push({ field, label: patternLabel(p.node), shape: p.shape });
      }
    }
  }
  return out;
}

/** A content instance as the field guard indexes it. */
export interface IndexedInstance {
  readonly id: string;
  readonly moduleDisplayName: string;
  readonly placementCount: number;
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * Hints for a field-value write, judged on the state AFTER the write.
 * A pattern counts as repeated when the placements carrying it add up to
 * two or more (an instance counts at least once: it was just written).
 */
export function fieldReuseHints(
  written: readonly Readonly<Record<string, unknown>>[],
  instances: readonly IndexedInstance[],
  catalog: readonly CatalogModule[],
): string[] {
  const found = written.flatMap(valuePatterns);
  if (found.length === 0) return [];
  const hints: string[] = written.flatMap(repeatedItemHints);
  const templates = new Map<string, CatalogModule>();
  for (const m of catalog) {
    const s = templateShape(m.html);
    if (s && isPattern(s)) templates.set(s.signature, m);
  }
  const carriers = new Map<string, IndexedInstance[]>();
  for (const inst of instances) {
    for (const p of valuePatterns(inst.values)) {
      const list = carriers.get(p.shape.signature) ?? [];
      if (!list.includes(inst)) list.push(inst);
      carriers.set(p.shape.signature, list);
    }
  }
  const seen = new Set<string>();
  for (const p of found) {
    if (seen.has(p.shape.signature)) continue;
    seen.add(p.shape.signature);
    const module = templates.get(p.shape.signature);
    if (module) {
      hints.push(
        `field \`${p.field}\` carries the markup of module "${module.displayName}" (${module.id}) as free HTML — place that module by moduleId with this content as values instead of pasting its HTML into a field`,
      );
      continue;
    }
    const list = carriers.get(p.shape.signature) ?? [];
    const placements = list.reduce((n, i) => n + Math.max(1, i.placementCount), 0);
    if (placements < 2) continue;
    const hosts = [...new Set(list.map((i) => `"${i.moduleDisplayName}"`))].join(", ");
    hints.push(
      `field \`${p.field}\` carries the pattern \`${p.label}\`, which is now free HTML in ${placements} placements (in ${hosts}) — the second copy is the moment to make it a module: mint ONE module from this markup with semantic fields (text-list / module-list for the repeating items), place it wherever the copies are with their values, and remove the free HTML; repeated free markup blocks Publish live in the structure quality check`,
    );
  }
  return hints;
}

/**
 * Hints for patterns a written value repeats side by side
 * ({@link repeatedSiblingPatterns}): the items of a list kept as copies.
 */
export function repeatedItemHints(values: Readonly<Record<string, unknown>>): string[] {
  const hints: string[] = [];
  for (const [field, value] of Object.entries(values)) {
    const strings = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    for (const s of strings) {
      if (typeof s !== "string" || !s.includes("class=")) continue;
      for (const r of repeatedSiblingPatterns(parseMarkup(s))) {
        hints.push(
          `field \`${field}\` writes the pattern \`${patternLabel(r.node)}\` out ${r.count} times side by side — that is a list of items as hand-written HTML, and each copy will be edited on its own and drift: mint ONE module for the item with semantic fields, give the host module a module-list field (text-list / link-list for plain items) with one entry per item, and remove the copies from this value; the structure quality check warns about it`,
        );
      }
    }
  }
  return hints;
}

/**
 * Whether a template contains any component-sized pattern. Only then can
 * it match another module, so a heading or a paragraph module never pays
 * for the catalog read.
 */
function containsPattern(html: string): boolean {
  const root = parseMarkup(stripMustache(html))[0];
  if (!root) return false;
  for (const shape of shapeTree(root).values()) if (isPattern(shape)) return true;
  return false;
}

/** The module catalog the caller's branch sees. Empty on a failed read. */
async function loadCatalog(ctx: ExecutionContext, toolCtx: ToolContext): Promise<CatalogModule[]> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.list", {
    includeDeleted: false,
  });
  // A failed read only loses the hint; the write it comments on succeeded.
  return r.ok ? ((r.value as { modules?: CatalogModule[] }).modules ?? []) : [];
}

/** The design-guard findings for a module mint / html edit (empty when none). */
export async function moduleMarkupFindings(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  html: string,
  excludeModuleIds: readonly string[],
): Promise<string[]> {
  if (!containsPattern(html)) return [];
  return moduleReuseHints(html, await loadCatalog(ctx, toolCtx), excludeModuleIds);
}

/**
 * The write's targets for the #1062 repeated-value hint: which modules'
 * instances to compare against (resolved by `content_instances.list_module_peers`).
 */
export interface RepeatScope {
  readonly moduleIds?: readonly string[];
  readonly contentInstanceIds?: readonly string[];
  readonly placements?: readonly { pageId: string; blockName: string; position: number }[];
}

/** Suffix for a field-value write ("" when there is nothing to say). */
export async function fieldMarkupSuffix(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  written: readonly Readonly<Record<string, unknown>>[],
): Promise<string> {
  if (!written.some((v) => valuePatterns(v).length > 0)) return "";
  const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "content_instances.list", {});
  if (!res.ok) return "";
  const instances = ((res.value as { instances?: IndexedInstance[] }).instances ?? []).filter((i) =>
    Object.values(i.values).some((v) => JSON.stringify(v).includes("class=")),
  );
  const hints = fieldReuseHints(written, instances, await loadCatalog(ctx, toolCtx));
  return hints.length === 0 ? "" : ` 🎯 markup-guard: ${hints.join(". ")}.`;
}

/**
 * Suffix for the #1062 repeated-value hint ("" when there is nothing to
 * say). Reads only the instances of the modules the write touched, and
 * only when the write carries a value worth comparing.
 */
export async function repeatedValueSuffix(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  written: readonly Readonly<Record<string, unknown>>[],
  scope: RepeatScope,
): Promise<string> {
  const targets =
    (scope.moduleIds?.length ?? 0) +
    (scope.contentInstanceIds?.length ?? 0) +
    (scope.placements?.length ?? 0);
  if (targets === 0 || !hasRepeatCandidates(written)) return "";
  const res = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    ctx,
    "content_instances.list_module_peers",
    {
      moduleIds: [...new Set(scope.moduleIds ?? [])],
      contentInstanceIds: [...new Set(scope.contentInstanceIds ?? [])],
      placements: scope.placements ?? [],
    },
  );
  // A failed read only loses the hint; the write it comments on succeeded.
  if (!res.ok) return "";
  const hints = repeatedValueHints(
    written,
    (res.value as { instances: ValueInstance[] }).instances,
  );
  return hints.length === 0 ? "" : ` 🎯 shared-content: ${hints.join(". ")}.`;
}

/**
 * Wrap a field-value-writing tool so a successful write carries the field
 * markup hints and (with `scope`) the repeated-value hint. `pick` names
 * the value objects the input writes; `scope` names the modules /
 * instances / placements it writes to.
 */
export function withFieldMarkupGuard<T>(
  tool: ToolDefinitionWithHandler<T>,
  pick: (input: T) => readonly Readonly<Record<string, unknown>>[],
  scope?: (input: T) => RepeatScope,
): ToolDefinitionWithHandler<T> {
  return {
    ...tool,
    handler: async (ctx, input, toolCtx) => {
      const result = await tool.handler(ctx, input, toolCtx);
      if (!result.ok) return result;
      const written = pick(input);
      const suffix =
        (await fieldMarkupSuffix(ctx, toolCtx, written)) +
        (scope ? await repeatedValueSuffix(ctx, toolCtx, written, scope(input)) : "");
      return suffix ? { ...result, content: `${result.content}${suffix}` } : result;
    },
  };
}
