// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout F) — reference integrity: the pure check.
 *
 * Internal links are stored as references (`caelo:page/<id>`,
 * `caelo:media/<id>`, rollout C). This walks every place a stored link
 * renders from (reference-sources.ts) and resolves each reference the way
 * the render does — through the same {@link SiteLinkIndex}, per rendering
 * page, so a German page's link is checked against the German version of
 * its target (rollout D). Literal paths that predate #724 are reported too.
 *
 * Policy (maintainer decisions on #724, `linkIssueSeverity`):
 *   - a missing target, or a target with no version in the rendering
 *     page's language, BLOCKS at Stage and at Publish live;
 *   - a draft target is a WARNING at Stage and BLOCKS Publish live /
 *     promote to production;
 *   - pre-#724 literal paths are WARNINGS (the link migration, rollout E,
 *     converts them). A literal that matches no page also fails the staged
 *     build's `links` check, which blocks Publish live on it.
 *   - a problem only on draft pages ships nowhere yet: a warning that turns
 *     into a block when the page is published.
 *
 * Only what renders is checked: page placements (and the field defaults a
 * value-less field shows), nested modules, the layouts and templates of
 * live pages with their chrome modules, and plugin data named through the
 * plugins' link-locations hook.
 *
 * Lists (epic #1107, reference-lists.ts) are followed the way they
 * render: a module's `list` field renders its shared list (and that
 * list's type's source defaults) on the module's pages, a list entry's
 * `module` field renders that module there too, and a page renders its
 * own terms and properties. Besides page / media links inside all of
 * those, the check resolves `caelo:list/<id>`, `caelo:term/<list>/<item>`
 * and embedded modules: one whose target is gone is `missing-list` /
 * `missing-term` / `missing-module`, blocking like a deleted page.
 */

import {
  canonicaliseContentValues,
  canonicaliseFieldDefaults,
  canonicaliseHtmlLinks,
  canonicaliseJsonLinks,
  collectLinkRefsDeep,
  dispatchedNestedRefs,
  findLinkRefs,
  type LinkCanonicaliseIssue,
  type LinkCanonicaliseRun,
  type LinkRef,
  type LinkRenderEnv,
  type LinkTargetLookup,
  linkCanonicaliseRun,
  linkIssueSeverity,
  type PendingLinkTarget,
  type SiteLinkIndex,
  urlFieldNamesInHtml,
} from "@caelo-cms/shared";
import { type ListFieldDef, listFieldsOf } from "../lists/local.js";
import type { LinkTargets } from "./link-targets.js";
import {
  fixFor,
  issueMessage,
  type ReferenceFix,
  type ReferencePlace,
  type ReferenceProblem,
} from "./reference-fix.js";
import {
  collectListRefs,
  collectTermRefs,
  entryIds,
  entryModules,
  type FoundTermRef,
  walkEntries,
} from "./reference-lists.js";
import type { ReferenceSourceModel, SourceField, SourceListType } from "./reference-sources.js";

export type { ReferenceFix, ReferencePlace, ReferenceProblem } from "./reference-fix.js";

/** The gate a check runs for: Stage, or Publish live / promote. */
export type ReferenceCheckEnv = Extract<LinkRenderEnv, "staging" | "production">;

/** One broken, unpublished or legacy link at one place. */
export interface ReferenceIssue {
  readonly problem: ReferenceProblem;
  /** `block` stops the gate; `warning` is reported. */
  readonly severity: "block" | "warning";
  /** The link as an author reads it: a page path, or what is gone. */
  readonly target: string;
  /**
   * The page the link resolves to, when there is one (null for a media
   * file or a literal that matches nothing). For `unpublished-target` the
   * draft page — the staged-build `links` check reads it to skip only the
   * rendered links this issue already reports (one defect, one finding).
   */
  readonly targetPageId: string | null;
  /** The rendering page's variant for `variant-missing` (a locale code). */
  readonly variant: string | null;
  /** Position inside the place (`values.cta_href`, `html`, `items[2].href`). */
  readonly where: string;
  readonly place: ReferencePlace;
  /** Pages the link renders on (with the problem); empty = site-wide / unknown. */
  readonly pageIds: readonly string[];
  /** True when the place renders on at least one published page (or site-wide). */
  readonly shipped: boolean;
  readonly message: string;
  readonly fix: ReferenceFix;
}

export interface ReferenceScanInput {
  readonly model: ReferenceSourceModel;
  readonly lookup: LinkTargetLookup;
  readonly targets: LinkTargets;
  /** The render-time index (env + link-resolve partition) of the scope. */
  readonly index: SiteLinkIndex;
  readonly env: ReferenceCheckEnv;
}

/** Mirrors the nested-module renderer's depth limit: nothing deeper renders. */
const NESTED_MAX_DEPTH = 8;
const NESTED_KINDS = new Set(["module", "module-list"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A primitive placeholder (`{{name}}`, `{{{name}}}`, `{{&name}}`): what
// makes the template engine render a stored value, declared or not.
const PLACEHOLDER_RE = /\{\{\{?\s*&?\s*([A-Za-z][A-Za-z0-9_]*)\s*\}?\}\}/g;

/** How one module's HTML uses its values (see {@link moduleValueUse}). */
interface ModuleValueUse {
  /** Lowercased names put whole into a link attribute (#852). */
  readonly urlNames: ReadonlySet<string>;
  /** Lowercased names any primitive placeholder renders. */
  readonly rendered: ReadonlySet<string>;
}

/**
 * Which values a module's HTML renders, and which of them as a link. The
 * engine puts every stored value into its view (lowercased) and
 * `{{name}}` renders it whether or not a field declares it, so an
 * undeclared key in `href="{{name}}"` ships a link like a declared one.
 */
function moduleValueUse(html: string): ModuleValueUse {
  const rendered = new Set<string>();
  for (const m of html.matchAll(PLACEHOLDER_RE)) rendered.add((m[1] as string).toLowerCase());
  return { urlNames: urlFieldNamesInHtml(html), rendered };
}

interface PlaceAcc {
  readonly place: ReferencePlace;
  readonly pages: Set<string>;
  /** Site-wide: renders on every page, or on pages nobody can name. */
  siteWide: boolean;
  /** Content shown through a synced placement: fixed on the instance. */
  synced: boolean;
}

interface IssueAcc {
  readonly problem: ReferenceProblem;
  readonly target: string;
  readonly targetPageId: string | null;
  readonly variant: string | null;
  readonly where: string;
  readonly placeKey: string;
  readonly pages: Set<string>;
}

/** A list reference to resolve (see reference-lists.ts). */
type StructRef =
  | { readonly kind: "list"; readonly listId: string; readonly where: string }
  | { readonly kind: "term"; readonly term: FoundTermRef; readonly where: string }
  | {
      readonly kind: "module";
      readonly moduleId: string;
      readonly contentInstanceId: string;
      readonly where: string;
    };

/** What one shared list renders besides its own entries, found once. */
interface ListRenders {
  /** Lists its entries reference (a `page_terms` vocabulary, …). */
  readonly lists: readonly string[];
  /** Modules its entries embed. */
  readonly modules: readonly { moduleId: string; contentInstanceId: string }[];
}

/** A slot: one value at one place, scanned with one canonicaliser call. */
export type ReferenceSlot =
  | { readonly kind: "html"; readonly value: string; readonly where: string }
  | { readonly kind: "json"; readonly value: unknown; readonly where: string }
  | {
      readonly kind: "field-value";
      readonly field: SourceField;
      readonly value: unknown;
      /** The module HTML puts this value whole into a link attribute. */
      readonly asUrl?: boolean;
    }
  | { readonly kind: "field-default"; readonly field: SourceField; readonly asUrl?: boolean };

/** Run the check. Issues are sorted: blocks first, then by place. */
export function scanReferenceIntegrity(input: ReferenceScanInput): ReferenceIssue[] {
  const { model, targets, index, env } = input;
  const pageInfo = new Map(targets.pages.map((p) => [p.id, p]));
  const livePage = (id: string) => pageInfo.has(id) && model.pageTemplates.has(id);
  const places = new Map<string, PlaceAcc>();
  const slots = new Map<string, ReferenceSlot[]>();
  const placeOf = (key: string, place: ReferencePlace): PlaceAcc => {
    let acc = places.get(key);
    if (!acc) {
      acc = { place, pages: new Set(), siteWide: false, synced: false };
      places.set(key, acc);
    }
    return acc;
  };
  const addSlot = (key: string, slot: ReferenceSlot, slotKey: string) => {
    const list = slots.get(key) ?? [];
    if (!list.some((s) => slotId(s) === slotKey)) list.push(slot);
    slots.set(key, list);
  };

  // ── List references (epic #1107): recorded per place, resolved below. ──
  const structural = new Map<string, Map<string, StructRef>>();
  const addStruct = (placeKey: string, r: StructRef) => {
    const id =
      r.kind === "list"
        ? r.listId
        : r.kind === "term"
          ? r.term.ref
          : `${r.moduleId}/${r.contentInstanceId}`;
    const refs = structural.get(placeKey) ?? new Map<string, StructRef>();
    refs.set(`${r.kind}\u0000${r.where}\u0000${id}`, r);
    structural.set(placeKey, refs);
  };
  /** Record the list and term references in `value`; returns the lists it names. */
  const recordRefs = (placeKey: string, value: unknown, where: string): string[] => {
    const lists = collectListRefs(value);
    for (const listId of lists) addStruct(placeKey, { kind: "list", listId, where });
    for (const term of collectTermRefs(value)) addStruct(placeKey, { kind: "term", term, where });
    return lists;
  };
  const typeBySlug = new Map([...model.listTypes.values()].map((t) => [t.slug, t]));
  const moduleAndInstanceExist = (moduleId: string, contentInstanceId: string) =>
    model.modules.has(moduleId) && model.instances.get(contentInstanceId)?.moduleId === moduleId;

  // A list type's source nodes render their query defaults wherever a
  // list of the type renders.
  const scannedTypes = new Set<string>();
  const renderListType = (t: SourceListType, pages: Iterable<string>) => {
    const sourced = Object.entries(t.def.nodes).filter(([, n]) => n.source !== undefined);
    if (sourced.length === 0) return;
    const key = `list-type:${t.id}`;
    const acc = placeOf(key, { kind: "list-type", listTypeId: t.id, listTypeSlug: t.slug });
    for (const p of pages) acc.pages.add(p);
    if (scannedTypes.has(t.id)) return;
    scannedTypes.add(t.id);
    for (const [node, n] of sourced) {
      const where = `nodes.${node}.source`;
      addSlot(key, { kind: "json", value: n.source, where }, where);
      recordRefs(key, n.source, where);
    }
  };

  const listRenders = new Map<string, ListRenders>();
  /**
   * A shared list renders on `pages`: its entries (links, terms, nested
   * list references) are checked there, the modules they embed render
   * there, and so do the lists they name.
   */
  const renderList = (listId: string, pages: ReadonlySet<string>, seen = new Set<string>()) => {
    const l = model.lists.get(listId);
    if (!l || seen.has(listId)) return;
    seen.add(listId);
    const key = `list:${l.id}`;
    const acc = placeOf(key, {
      kind: "list",
      listId: l.id,
      listSlug: l.slug,
      listName: l.name,
    });
    for (const p of pages) acc.pages.add(p);
    const type = model.listTypes.get(l.listTypeId);
    let renders = listRenders.get(l.id);
    if (!renders) {
      const lists = new Set<string>();
      for (const { item, where } of walkEntries(l.items)) {
        const stored = { values: item.values, ...(item.query ? { query: item.query } : {}) };
        addSlot(key, { kind: "json", value: stored, where }, where);
        for (const id of recordRefs(key, stored, where)) lists.add(id);
      }
      const modules = type ? entryModules(type.def, l.items) : [];
      for (const em of modules) addStruct(key, { kind: "module", ...em });
      renders = { lists: [...lists], modules };
      listRenders.set(l.id, renders);
    }
    for (const em of renders.modules) {
      if (!moduleAndInstanceExist(em.moduleId, em.contentInstanceId)) continue;
      nestedQueue.push({
        moduleId: em.moduleId,
        instanceId: em.contentInstanceId,
        pages: new Set(pages),
        nested: true,
        synced: false,
      });
    }
    for (const nested of renders.lists) renderList(nested, pages, seen);
    if (type) renderListType(type, pages);
  };

  // ── Modules: their HTML, and per field the value or the default. ──
  const moduleHtml = (moduleId: string, pages: Iterable<string>) => {
    const m = model.modules.get(moduleId);
    if (!m) return;
    const key = `module-html:${m.id}`;
    const acc = placeOf(key, { kind: "module-html", moduleId: m.id, moduleName: m.name });
    for (const p of pages) acc.pages.add(p);
    addSlot(key, { kind: "html", value: m.html, where: "html" }, "html");
  };
  const valueUse = new Map<string, ModuleValueUse>();
  const valueUseOf = (moduleId: string, html: string): ModuleValueUse => {
    let use = valueUse.get(moduleId);
    if (!use) {
      use = moduleValueUse(html);
      valueUse.set(moduleId, use);
    }
    return use;
  };
  const moduleDefault = (moduleId: string, field: SourceField, pages: Iterable<string>) => {
    const m = model.modules.get(moduleId);
    if (!m || field.default === undefined || field.default === null) return;
    const key = `module-default:${m.id}:${field.name}`;
    const acc = placeOf(key, {
      kind: "module-default",
      moduleId: m.id,
      moduleName: m.name,
      field: field.name,
    });
    for (const p of pages) acc.pages.add(p);
    const asUrl = valueUseOf(m.id, m.html).urlNames.has(field.name.toLowerCase());
    addSlot(key, { kind: "field-default", field, asUrl }, "default");
  };

  type Unit = {
    moduleId: string;
    instanceId: string | null;
    pages: Set<string>;
    nested: boolean;
    synced: boolean;
  };
  const nestedQueue: Unit[] = [];
  const renderUnit = (u: Unit) => {
    const m = model.modules.get(u.moduleId);
    if (!m) return;
    moduleHtml(m.id, u.pages);
    const inst = u.instanceId ? model.instances.get(u.instanceId) : undefined;
    // Only the nested modules the template dispatches render (the
    // renderer is lazy): a `module` field the HTML no longer references
    // ships nothing, so its links must not block. The engine itself says
    // which refs it dispatches.
    for (const ref of dispatchedNestedRefs(m.html, m.fields, inst?.values ?? {})) {
      if (!UUID_RE.test(ref.moduleId) || !UUID_RE.test(ref.contentInstanceId)) continue;
      nestedQueue.push({
        moduleId: ref.moduleId,
        instanceId: ref.contentInstanceId,
        pages: u.pages,
        nested: true,
        synced: false,
      });
    }
    const use = valueUseOf(m.id, m.html);
    // Stored keys no field declares still render where a placeholder
    // names them (the engine's view holds every value), so they are
    // checked like a `text` field; keys nothing renders ship nowhere.
    const declared = new Set(m.fields.map((f) => f.name));
    const undeclared: SourceField[] = Object.keys(inst?.values ?? {})
      .filter((k) => !declared.has(k) && use.rendered.has(k.toLowerCase()))
      .map((name) => ({ name, kind: "text" }));
    for (const field of [...m.fields, ...undeclared]) {
      if (NESTED_KINDS.has(field.kind)) continue;
      const asUrl = use.urlNames.has(field.name.toLowerCase());
      const has = inst !== undefined && Object.hasOwn(inst.values, field.name);
      const value = has ? inst.values[field.name] : field.default;
      if (has && inst) {
        const key = `content:${inst.id}:${field.name}`;
        const acc = placeOf(key, {
          kind: "content",
          moduleId: m.id,
          moduleName: m.name,
          contentInstanceId: inst.id,
          field: field.name,
          nested: u.nested,
        });
        for (const p of u.pages) acc.pages.add(p);
        if (u.synced) acc.synced = true;
        addSlot(key, { kind: "field-value", field, value, asUrl }, "value");
      } else {
        moduleDefault(m.id, field, u.pages);
      }
    }
    for (const lf of listFieldsOf(m.fields)) renderListField(m.id, m.name, lf, inst, u);
  };

  /**
   * One `list` field of a rendering module (docs/lists.md §7): the field's
   * own definition (fixed list, source), then the value the placement
   * shows — its content instance's value, else the field default. Page
   * links inside a local list are the field slot's (above); here the
   * list, term and embedded-module references.
   */
  const renderListField = (
    moduleId: string,
    moduleName: string,
    lf: ListFieldDef,
    inst: { id: string; values: Readonly<Record<string, unknown>> } | undefined,
    u: Unit,
  ) => {
    if (lf.list !== undefined || lf.source !== undefined) {
      const key = `module-field:${moduleId}:${lf.name}`;
      const acc = placeOf(key, { kind: "module-field", moduleId, moduleName, field: lf.name });
      for (const p of u.pages) acc.pages.add(p);
      if (lf.source !== undefined) {
        const where = `fields.${lf.name}.source`;
        addSlot(key, { kind: "json", value: lf.source, where }, where);
        recordRefs(key, lf.source, where);
      }
      for (const listId of recordRefs(key, lf.list, `fields.${lf.name}.list`)) {
        renderList(listId, u.pages);
      }
    }
    const has = inst !== undefined && Object.hasOwn(inst.values, lf.name);
    const value = has && inst ? inst.values[lf.name] : lf.default;
    if (value === undefined || value === null) return;
    // The same places the field slot above used for this value.
    const key =
      has && inst ? `content:${inst.id}:${lf.name}` : `module-default:${moduleId}:${lf.name}`;
    const where = has ? `values.${lf.name}` : `fields.${lf.name}.default`;
    if ((lf.bind ?? "local") !== "local") {
      for (const listId of recordRefs(key, value, where)) renderList(listId, u.pages);
      return;
    }
    for (const { item, where: entry } of walkEntries(value)) {
      const stored = { values: item.values, ...(item.query ? { query: item.query } : {}) };
      for (const listId of recordRefs(key, stored, `${where} ${entry}`)) {
        renderList(listId, u.pages);
      }
    }
    const type = typeBySlug.get(lf.listType);
    if (!type) return;
    for (const em of entryModules(type.def, value)) {
      addStruct(key, { kind: "module", ...em, where: `${where} ${em.where}` });
      if (!moduleAndInstanceExist(em.moduleId, em.contentInstanceId)) continue;
      nestedQueue.push({
        moduleId: em.moduleId,
        instanceId: em.contentInstanceId,
        pages: u.pages,
        nested: true,
        synced: false,
      });
    }
    renderListType(type, u.pages);
  };

  for (const pl of model.placements) {
    if (!livePage(pl.pageId)) continue;
    renderUnit({
      moduleId: pl.moduleId,
      instanceId: pl.contentInstanceId,
      pages: new Set([pl.pageId]),
      nested: false,
      synced: pl.syncMode === "synced",
    });
  }

  // ── Templates and layouts of live pages, with the layout chrome. ──
  const pagesByTemplate = new Map<string, Set<string>>();
  for (const [pageId, templateId] of model.pageTemplates) {
    if (!livePage(pageId)) continue;
    const set = pagesByTemplate.get(templateId) ?? new Set<string>();
    set.add(pageId);
    pagesByTemplate.set(templateId, set);
  }
  const pagesByLayout = new Map<string, Set<string>>();
  for (const [templateId, pages] of pagesByTemplate) {
    const t = model.templates.get(templateId);
    if (!t) continue;
    const key = `template-html:${t.id}`;
    const acc = placeOf(key, { kind: "template-html", templateId: t.id, templateName: t.name });
    for (const p of pages) acc.pages.add(p);
    addSlot(key, { kind: "html", value: t.html, where: "html" }, "html");
    if (t.layoutId) {
      const set = pagesByLayout.get(t.layoutId) ?? new Set<string>();
      for (const p of pages) set.add(p);
      pagesByLayout.set(t.layoutId, set);
    }
  }
  for (const [layoutId, pages] of pagesByLayout) {
    const l = model.layouts.get(layoutId);
    if (!l) continue;
    const key = `layout-html:${l.id}`;
    const acc = placeOf(key, { kind: "layout-html", layoutId: l.id, layoutName: l.name });
    for (const p of pages) acc.pages.add(p);
    addSlot(key, { kind: "html", value: l.html, where: "html" }, "html");
    for (const block of l.blocks) {
      for (const moduleId of block.moduleIds) {
        // Layout placements have no content instance: defaults render.
        renderUnit({ moduleId, instanceId: null, pages, nested: false, synced: false });
      }
    }
  }

  // ── Pages: their terms and properties (what queries and {{page.*}} read). ──
  for (const [pageId, data] of model.pageData) {
    if (!livePage(pageId)) continue;
    const key = `page:${pageId}`;
    const acc = placeOf(key, {
      kind: "page",
      pageId,
      pagePath: pageInfo.get(pageId)?.path ?? pageId,
    });
    acc.pages.add(pageId);
    const one = new Set([pageId]);
    recordRefs(key, data.terms, "terms");
    // A vocabulary renders on the pages carrying its terms (page_terms,
    // `{{#page.terms.<vocabulary>}}`): its entries' links ship there.
    for (const term of collectTermRefs(data.terms)) renderList(term.listId, one);
    for (const [name, v] of Object.entries(data.properties)) {
      const where = `properties.${name}`;
      addSlot(key, { kind: "json", value: v, where }, where);
      recordRefs(key, v, where);
    }
  }

  // ── Nested modules, breadth-first, cycle-safe, depth-capped. ──
  const seen = new Set<string>();
  let level = nestedQueue.splice(0);
  for (let depth = 0; depth < NESTED_MAX_DEPTH && level.length > 0; depth += 1) {
    for (const u of level) {
      const k = `${u.moduleId}:${u.instanceId}:${[...u.pages].sort().join(",")}`;
      if (seen.has(k)) continue;
      seen.add(k);
      renderUnit(u);
    }
    level = nestedQueue.splice(0);
  }

  // ── Plugin data named by the plugins' link-locations hook. ──
  model.plugins.forEach((pv, i) => {
    const key = `plugin:${pv.pluginSlug}:${i}`;
    const acc = placeOf(key, { kind: "plugin", pluginSlug: pv.pluginSlug, label: pv.label });
    // A plugin location names no page; its references resolve as stored.
    acc.siteWide = true;
    if (pv.fields) {
      const values =
        pv.value !== null && typeof pv.value === "object" && !Array.isArray(pv.value)
          ? (pv.value as Record<string, unknown>)
          : {};
      for (const field of pv.fields) {
        if (Object.hasOwn(values, field.name)) {
          addSlot(key, { kind: "field-value", field, value: values[field.name] }, field.name);
        }
      }
    } else {
      addSlot(key, { kind: "json", value: pv.value, where: "value" }, "value");
    }
  });

  const itemIdsOf = new Map<string, ReadonlySet<string>>();
  const brokenStructRef = (r: StructRef): { problem: ReferenceProblem; target: string } | null => {
    switch (r.kind) {
      case "list":
        return model.lists.has(r.listId)
          ? null
          : { problem: "missing-list", target: `a deleted list (${r.listId})` };
      case "term": {
        const l = model.lists.get(r.term.listId);
        if (!l) {
          return {
            problem: "missing-term",
            target: `"${r.term.ref}", whose vocabulary list (${r.term.listId}) was deleted`,
          };
        }
        let ids = itemIdsOf.get(l.id);
        if (!ids) {
          ids = entryIds(l.items);
          itemIdsOf.set(l.id, ids);
        }
        return ids.has(r.term.itemId)
          ? null
          : {
              problem: "missing-term",
              target: `entry ${r.term.itemId} of vocabulary "${l.slug}" (${l.id}), which was removed`,
            };
      }
      case "module": {
        const m = model.modules.get(r.moduleId);
        if (!m) return { problem: "missing-module", target: `a deleted module (${r.moduleId})` };
        return model.instances.get(r.contentInstanceId)?.moduleId === r.moduleId
          ? null
          : {
              problem: "missing-module",
              target: `content instance ${r.contentInstanceId} of module "${m.name}", which was deleted`,
            };
      }
    }
  };

  // ── Resolve every slot. ──
  const issues = new Map<string, IssueAcc>();
  const record = (
    placeKey: string,
    problem: ReferenceProblem,
    target: string,
    targetPageId: string | null,
    variant: string | null,
    where: string,
    page: string | null,
  ) => {
    const key = `${placeKey}\u0000${where}\u0000${problem}\u0000${target}\u0000${targetPageId ?? ""}\u0000${variant ?? ""}`;
    let acc = issues.get(key);
    if (!acc) {
      acc = { problem, target, targetPageId, variant, where, placeKey, pages: new Set() };
      issues.set(key, acc);
    }
    if (page !== null) acc.pages.add(page);
  };
  const pathOf = (pageId: string) => pageInfo.get(pageId)?.path ?? pageId;
  const isPublished = (pageId: string) => pageInfo.get(pageId)?.status === "published";

  for (const [placeKey, acc] of places) {
    const renderPages: (string | null)[] =
      acc.siteWide || acc.pages.size === 0 ? [null] : [...acc.pages];
    if (!acc.siteWide && acc.pages.size === 0) continue;
    for (const slot of slots.get(placeKey) ?? []) {
      const found = scanSlot(slot, input.lookup);
      for (const { ref, where } of found.refs) {
        for (const page of renderPages) {
          const r = index.forPage(page).resolve(ref);
          if (r.status === "missing") {
            record(placeKey, "missing-target", goneLabel(ref), null, null, where, page);
          } else if (r.status === "no-variant") {
            const target = ref.kind === "page" ? `"${pathOf(ref.pageId)}"` : goneLabel(ref);
            const targetPageId = ref.kind === "page" ? ref.pageId : null;
            record(placeKey, "variant-missing", target, targetPageId, r.variant, where, page);
          } else if (r.status === "unpublished" && (page === null || isPublished(page))) {
            const target = `"${pathOf(r.pageId)}"`;
            record(placeKey, "unpublished-target", target, r.pageId, null, where, page);
          }
        }
      }
      for (const hit of found.literals) {
        const draft = hit.pageId !== null && !isPublished(hit.pageId);
        for (const page of renderPages) {
          if (draft && (page === null || isPublished(page))) {
            const target = `"${hit.display}"`;
            record(placeKey, "unpublished-target", target, hit.pageId, null, hit.where, page);
          } else {
            const target = `"${hit.display}"`;
            record(placeKey, "literal-link", target, hit.pageId, null, hit.where, page);
          }
        }
      }
      for (const bad of found.broken) {
        for (const page of renderPages) {
          record(placeKey, "broken-literal", `"${bad.value}"`, null, null, bad.where, page);
        }
      }
      for (const p of found.pending) {
        for (const page of renderPages) {
          record(placeKey, "pending-import-link", `"${p.value}"`, null, null, p.where, page);
        }
      }
    }
    for (const r of structural.get(placeKey)?.values() ?? []) {
      const broken = brokenStructRef(r);
      if (!broken) continue;
      for (const page of renderPages) {
        record(placeKey, broken.problem, broken.target, null, null, r.where, page);
      }
    }
  }

  const out: ReferenceIssue[] = [];
  for (const i of issues.values()) {
    const acc = places.get(i.placeKey) as PlaceAcc;
    const pageIds = [...i.pages].sort();
    const shipped = acc.siteWide || pageIds.some(isPublished);
    const severity = severityOf(i.problem, env, shipped);
    // Shared by several pages, or synced on one: the instance is the place to fix.
    const instanceLevel = acc.pages.size > 1 || acc.synced;
    const fix = fixFor(i.problem, acc.place, i.target, i.variant, i.where, instanceLevel);
    out.push({
      problem: i.problem,
      severity,
      target: i.target,
      targetPageId: i.targetPageId,
      variant: i.variant,
      where: i.where,
      place: acc.place,
      pageIds,
      shipped,
      message: issueMessage(
        i.problem,
        acc.place,
        pageIds.map(pathOf),
        i.target,
        i.variant,
        fix,
        i.where,
      ),
      fix,
    });
  }
  return out.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "block" ? -1 : 1) ||
      a.message.localeCompare(b.message),
  );
}

function severityOf(
  problem: ReferenceProblem,
  env: ReferenceCheckEnv,
  shipped: boolean,
): "block" | "warning" {
  if (!shipped) return "warning";
  switch (problem) {
    case "missing-target":
    case "missing-list":
    case "missing-term":
    case "missing-module":
      return linkIssueSeverity(env, "missing") ?? "warning";
    case "variant-missing":
      return linkIssueSeverity(env, "no-variant") ?? "warning";
    case "unpublished-target":
      return linkIssueSeverity(env, "unpublished") ?? "warning";
    case "literal-link":
    case "broken-literal":
    case "pending-import-link":
      return "warning";
  }
}

function goneLabel(ref: LinkRef): string {
  return ref.kind === "page"
    ? `a deleted page (${ref.pageId})`
    : `a deleted media file (${ref.mediaId})`;
}

function slotId(s: ReferenceSlot): string {
  switch (s.kind) {
    case "html":
    case "json":
      return s.where;
    case "field-value":
      return `value:${s.field.name}`;
    case "field-default":
      return `default:${s.field.name}`;
  }
}

interface SlotFindings {
  readonly refs: { ref: LinkRef; where: string }[];
  /** Literal paths / media URLs that resolve (pre-#724 storage form). */
  readonly literals: { display: string; pageId: string | null; where: string }[];
  /** Literal links that resolve to nothing. */
  readonly broken: LinkCanonicaliseIssue[];
  /** Links to pages an active import planned (kept literal until it finishes). */
  readonly pending: PendingLinkTarget[];
}

/**
 * Scan one slot: the references in it (resolved by the caller, per
 * rendering page) and its literal links, classified by the write-time
 * canonicaliser in report mode — the same rules that decide what a link
 * is (rollout C), so the check and the write path never disagree.
 */
export function scanSlot(slot: ReferenceSlot, lookup: LinkTargetLookup): SlotFindings {
  const literals: SlotFindings["literals"] = [];
  let where = "";
  const recording: LinkTargetLookup = {
    ...lookup,
    pageIdForPath(path) {
      const id = lookup.pageIdForPath(path);
      // A literal `/` is not legacy storage: the write path keeps it literal
      // while no homepage exists yet (site chrome is built first), and the
      // root cannot dangle — a Stage refuses a site without one.
      if (id !== null && path !== "/") literals.push({ display: path, pageId: id, where });
      return id;
    },
    mediaIdForSlug(slug) {
      const id = lookup.mediaIdForSlug(slug);
      if (id !== null) literals.push({ display: `/_caelo/media/${slug}`, pageId: null, where });
      return id;
    },
  };
  const run: LinkCanonicaliseRun = linkCanonicaliseRun(recording, { mode: "report" });
  let refs: { ref: LinkRef; where: string }[];
  switch (slot.kind) {
    case "html":
      where = slot.where;
      canonicaliseHtmlLinks(slot.value, run, slot.where);
      refs = findLinkRefs(slot.value).map((ref) => ({ ref, where: slot.where }));
      break;
    case "json":
      where = slot.where;
      canonicaliseJsonLinks(slot.value, run, slot.where);
      refs = collectLinkRefsDeep(slot.value).map((ref) => ({ ref, where: slot.where }));
      break;
    case "field-value":
      where = `values.${slot.field.name}`;
      canonicaliseContentValues(
        [slot.field],
        { [slot.field.name]: slot.value },
        run,
        slot.asUrl ? new Set([slot.field.name.toLowerCase()]) : undefined,
      );
      refs = collectLinkRefsDeep(slot.value).map((ref) => ({ ref, where }));
      break;
    case "field-default":
      where = `fields.${slot.field.name}.default`;
      canonicaliseFieldDefaults(
        [slot.field],
        run,
        slot.asUrl ? new Set([slot.field.name.toLowerCase()]) : undefined,
      );
      refs = collectLinkRefsDeep(slot.field.default).map((ref) => ({ ref, where }));
      break;
  }
  return {
    refs,
    literals,
    // Dangling references are resolved by the caller (it also knows
    // drafts and language versions); only literal problems come from here.
    broken: run.issues.filter(
      (i) => i.kind !== "dangling-page-ref" && i.kind !== "dangling-media-ref",
    ),
    pending: run.pending,
  };
}
