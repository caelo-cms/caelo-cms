// SPDX-License-Identifier: MPL-2.0

/**
 * #1748 — the write-side checks of the core value structure rule
 * (`@caelo-cms/shared` core-value-structure.ts): a value that would change
 * the markup around its placeholder is refused where it is written, with
 * the spelling and the fix.
 *
 * A value and the module HTML that places it are written separately, so
 * both sides check what they can see:
 *
 * - a content instance's values against its module (in
 *   `validateNestedRefs`, content-instances.ts);
 * - a module write (create, or an update of its HTML or fields) against
 *   its fields' defaults, the shared lists its list fields bind and the
 *   site texts its HTML reads by key ({@link moduleWriteValueProblems});
 * - a shared list write against the modules whose list field binds it
 *   ({@link listWriteValueProblems}).
 *
 * What neither side sees is found by the Stage: the engine records the
 * `value-breaks-markup` render failure, which Publish live refuses. That
 * is a module's existing placements when its HTML changes and a
 * placement that points a list field at a shared list the module does not
 * fix (both would make a write read every placement), a site text a
 * module reads by key when the text changes (nothing indexes which module
 * reads which key), and a page's title or properties.
 */

import type { ErrorDetail, TransactionRunner } from "@caelo-cms/query-api";
import {
  describeValueBreaksMarkup,
  type ListItem,
  listEntryValueProblems,
  moduleValueProblems,
  SITE_TEXTS_LIST_TYPE,
  siteTextValueProblems,
} from "@caelo-cms/shared";
import { listFieldsOf, loadModulesInView, parseListRef } from "../../lists/local.js";
import { loadListEntities } from "../../lists/store.js";
import { loadModuleStateWithBranchOverlay } from "../../snapshots/index.js";

/** A module's fields as stored (an array of field objects). */
type StoredFields = readonly unknown[];

/** The fields with a name and a kind, as the walks read them. */
function namedFields(fields: StoredFields): { name: string; kind: string; default?: unknown }[] {
  return fields.flatMap((f) => {
    if (typeof f !== "object" || f === null) return [];
    const o = f as { name?: unknown; kind?: unknown; default?: unknown };
    if (typeof o.name !== "string") return [];
    return [
      {
        name: o.name,
        kind: typeof o.kind === "string" ? o.kind : "text",
        ...(o.default !== undefined ? { default: o.default } : {}),
      },
    ];
  });
}

/** The defaults a module's fields render with where a placement sets no value. */
function defaultsOf(fields: StoredFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of namedFields(fields)) if (f.default !== undefined) out[f.name] = f.default;
  return out;
}

/**
 * What a module write would render that breaks the markup around a
 * placeholder, as the refusal's text; null when nothing does.
 *
 * @param previous the module as it was (an update): defaults, list
 *   bindings and site texts the same HTML already placed are not this
 *   write's doing and pass (a Stage still reports them).
 */
export async function moduleWriteValueProblems(
  tx: TransactionRunner,
  branchId: string | null,
  module: {
    readonly slug: string;
    readonly html: string;
    readonly fields: StoredFields;
    readonly previous?: { readonly html: string; readonly fields: StoredFields };
  },
): Promise<string | null> {
  const sameHtml = module.previous !== undefined && module.previous.html === module.html;
  const lines: string[] = [];
  for (const p of moduleValueProblems(
    module.html,
    namedFields(module.fields),
    defaultsOf(module.fields),
    sameHtml && module.previous ? defaultsOf(module.previous.fields) : undefined,
  )) {
    lines.push(describeValueBreaksMarkup(`the default of ${p.where}`, p.problem, module.slug));
  }

  // The shared lists its list fields bind, newly placed by this HTML.
  const before = new Map(
    listFieldsOf(module.previous?.fields ?? []).map((f) => [f.name, f.list ?? f.default]),
  );
  const bound = listFieldsOf(module.fields).flatMap((f) => {
    const ref = f.list ?? f.default;
    const id = parseListRef(ref);
    if (id === null || (sameHtml && before.get(f.name) === ref)) return [];
    return [{ field: f.name, id }];
  });
  if (bound.length > 0) {
    const lists = new Map(
      (
        await loadListEntities(tx, "list", branchId, { ids: [...new Set(bound.map((b) => b.id))] })
      ).map((l) => [l.id, l]),
    );
    for (const b of bound) {
      const list = lists.get(b.id);
      if (!list) continue;
      const label = `the shared list "${list.state.slug}" (bound by field "${b.field}")`;
      for (const p of listEntryValueProblems(
        module.html,
        b.field,
        list.state.items,
        [],
        undefined,
        label,
      )) {
        lines.push(describeValueBreaksMarkup(p.where, p.problem, module.slug));
      }
    }
  }

  // The site texts it reads by key.
  if (!sameHtml && /\{\{\s*&?\s*site_text\./.test(module.html)) {
    const texts = await loadSiteTexts(tx, branchId);
    for (const t of siteTextValueProblems(module.html, texts)) {
      lines.push(describeValueBreaksMarkup(`the site text "${t.key}"`, t.problem, module.slug));
    }
  }
  if (lines.length === 0) return null;
  return (
    `This module would show ${lines.length === 1 ? "a value" : `${lines.length} values`} that break the page's markup where it places ${lines.length === 1 ? "it" : "them"}; nothing was saved. ` +
    `${lines.join(" ")} Fix the value (set_content_instance_values_many for a default's placement value, update_modules_many for the default, patch_list_items_many for a list entry or site text), or place it where it cannot break, then retry.`
  );
}

/** The site texts (`key` → text) of the caller's view: every list of the site-texts type. */
async function loadSiteTexts(
  tx: TransactionRunner,
  branchId: string | null,
): Promise<Map<string, string>> {
  const [type] = await loadListEntities(tx, "listType", branchId, {
    slugs: [SITE_TEXTS_LIST_TYPE],
  });
  const out = new Map<string, string>();
  if (!type) return out;
  for (const list of await loadListEntities(tx, "list", branchId, { listTypeIds: [type.id] })) {
    for (const item of list.state.items) {
      const { key, text } = item.values as { key?: unknown; text?: unknown };
      if (typeof key === "string" && typeof text === "string" && !out.has(key)) {
        out.set(key, text);
      }
    }
  }
  return out;
}

/**
 * The entries of shared list `listId` a write would store that break the
 * markup where a module renders them: the modules whose list field binds
 * the list (`module_refs`, the read `lists.get`'s usage makes). Each
 * problem is addressed in the list's entries (`["items", 0, "values",
 * "text"]`). An entry `previous` holds with the same value passes.
 */
export async function listWriteValueProblems(
  tx: TransactionRunner,
  branchId: string | null,
  list: {
    readonly id: string;
    readonly slug: string;
    readonly items: readonly ListItem[];
    readonly previous?: readonly ListItem[];
  },
): Promise<ErrorDetail[]> {
  const ref = `caelo:list/${list.id}`;
  // The module fields that render the list.
  const renders = new Map<string, Set<string>>();
  for (const m of await loadModulesInView(tx, branchId, { referencing: [list.id] })) {
    for (const f of listFieldsOf(m.fields)) {
      if (f.list !== ref && f.default !== ref) continue;
      renders.set(m.id, (renders.get(m.id) ?? new Set()).add(f.name));
    }
  }
  const out: ErrorDetail[] = [];
  const seen = new Set<string>();
  for (const [moduleId, fields] of renders) {
    const mod = await loadModuleStateWithBranchOverlay(tx, moduleId, branchId);
    if (mod === null || mod.deletedAt !== null) continue;
    for (const field of fields) {
      for (const p of listEntryValueProblems(
        mod.html,
        field,
        list.items,
        ["items"],
        list.previous,
        `list "${list.slug}"`,
      )) {
        const key = p.path.join("/");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          path: p.path,
          message: describeValueBreaksMarkup(p.where, p.problem, mod.slug),
        });
      }
    }
  }
  return out;
}
