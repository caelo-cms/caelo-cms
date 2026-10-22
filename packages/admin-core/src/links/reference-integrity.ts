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
 * live pages with their chrome modules, structured sets, and plugin data
 * named through the plugins' link-locations hook.
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
} from "@caelo-cms/shared";
import type { LinkTargets } from "./link-targets.js";
import {
  fixFor,
  issueMessage,
  type ReferenceFix,
  type ReferencePlace,
  type ReferenceProblem,
} from "./reference-fix.js";
import type { ReferenceSourceModel, SourceField } from "./reference-sources.js";

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

/** A slot: one value at one place, scanned with one canonicaliser call. */
export type ReferenceSlot =
  | { readonly kind: "html"; readonly value: string; readonly where: string }
  | { readonly kind: "json"; readonly value: unknown; readonly where: string }
  | {
      readonly kind: "field-value";
      readonly field: SourceField;
      readonly value: unknown;
    }
  | { readonly kind: "field-default"; readonly field: SourceField };

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

  // ── Modules: their HTML, and per field the value or the default. ──
  const moduleHtml = (moduleId: string, pages: Iterable<string>) => {
    const m = model.modules.get(moduleId);
    if (!m) return;
    const key = `module-html:${m.id}`;
    const acc = placeOf(key, { kind: "module-html", moduleId: m.id, moduleName: m.name });
    for (const p of pages) acc.pages.add(p);
    addSlot(key, { kind: "html", value: m.html, where: "html" }, "html");
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
    addSlot(key, { kind: "field-default", field }, "default");
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
    for (const field of m.fields) {
      if (NESTED_KINDS.has(field.kind)) continue;
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
        addSlot(key, { kind: "field-value", field, value }, "value");
      } else {
        moduleDefault(m.id, field, u.pages);
      }
    }
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

  // ── Structured sets: a nav menu renders where its module does. ──
  const pagesByModuleSlug = new Map<string, Set<string>>();
  for (const [key, acc] of places) {
    if (!key.startsWith("module-html:")) continue;
    const m = model.modules.get((acc.place as { moduleId: string }).moduleId);
    if (m) pagesByModuleSlug.set(m.slug, acc.pages);
  }
  for (const s of model.sets) {
    const key = `set:${s.id}`;
    const acc = placeOf(key, {
      kind: "structured-set",
      setId: s.id,
      set: `${s.kind}/${s.slug}`,
      setName: s.name,
    });
    const navPages =
      s.kind === "nav-menu" ? pagesByModuleSlug.get(`nav-menu-${s.slug}`) : undefined;
    // Only nav menus render (through their `nav-menu-<slug>` module, see
    // preview-compose); a set nothing renders ships nowhere: warnings only.
    if (navPages) for (const p of navPages) acc.pages.add(p);
    s.items.forEach((item, i) => {
      addSlot(key, { kind: "json", value: item, where: `items[${i}]` }, `items[${i}]`);
    });
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
    if (!acc.siteWide && acc.pages.size === 0 && acc.place.kind !== "structured-set") continue;
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
      message: issueMessage(i.problem, acc.place, pageIds.map(pathOf), i.target, i.variant, fix),
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
      canonicaliseContentValues([slot.field], { [slot.field.name]: slot.value }, run);
      refs = collectLinkRefsDeep(slot.value).map((ref) => ({ ref, where }));
      break;
    case "field-default":
      where = `fields.${slot.field.name}.default`;
      canonicaliseFieldDefaults([slot.field], run);
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
