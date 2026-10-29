// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — the values of `list` module fields (docs/lists.md §7),
 * checked and normalised on every write that stores one: module field
 * defaults (modules.create / update — layout chrome renders from them)
 * and content instance values (content_instances.create / set_values).
 *
 *   - `local`: an entry array, validated against the list type with
 *     `validateListItems` — which also assigns the ids of new entries (the
 *     renderer reports an entry without an id as `list-malformed`) — plus
 *     the field's `min` / `max` and the DB-backed entry checks;
 *   - `shared`: `caelo:list/<id>` of an existing list of the field's type
 *     (a placement value only when the module did not fix `list`);
 *   - `source`: a query's editable knobs, or `terms` for the term_pages
 *     system source (the only per-placement input a system source reads).
 *
 * Everything is read in the caller's branch view. Messages name the field
 * and the next step.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext, ListItem, ListTypeDef } from "@caelo-cms/shared";
import {
  listPaginationSchema,
  pageQueryPartialSchema,
  splitPaginationValue,
  TERM_REF_RE,
  validateListItems,
} from "@caelo-cms/shared";
import { canonicaliseLinksForWrite } from "../links/canonicalise.js";
import { canonicaliseEntryLinks, checkEntryRefs, describeIssues } from "../ops/lists/_shared.js";
import { bindingOf, type ListFieldDef, listFieldsOf, parseListRef } from "./local.js";
import { loadListEntities, loadListEntity } from "./store.js";

type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

async function normaliseOne(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  branchId: string | null,
  field: ListFieldDef,
  value: unknown,
  where: string,
): Promise<Outcome<unknown>> {
  const types = await loadListEntities(tx, "listType", branchId, { slugs: [field.listType] });
  const type = types[0];
  if (!type) {
    return {
      ok: false,
      message: `${where}: list type "${field.listType}" does not exist — use one of list_types.list's slugs as listType, or create the type first (list_types.upsert_many).`,
    };
  }
  const bind = bindingOf(field);
  if (bind === "local") {
    // Reads humanise entry links (`/_caelo/media/<slug>` for a media field
    // of any name), and the generic value canonicaliser only knows link-ish
    // KEY names — so a read-modify-write would fail the media check
    // (#1121 review). Canonicalise by the list type's field declarations
    // first, like shared lists. `report` mode: links to pages an import
    // will still build were already decided by the caller's own pass.
    let input = value;
    if (Array.isArray(value) && value.every((e) => typeof e === "object" && e !== null)) {
      const def = type.state.definition;
      const canon = await canonicaliseLinksForWrite(
        tx,
        ctx,
        (run) => canonicaliseEntryLinks(def, value as ListItem[], run, where),
        { mode: "report" },
      );
      if (canon.ok) input = canon.value;
    }
    const validated = validateListItems(type.state.definition, input, { path: where });
    if (validated.issues.length > 0) {
      return {
        ok: false,
        // #1149 — name the fields right here, not a read the AI must call.
        message: `${describeIssues(validated.issues)}. Entries of list type "${field.listType}" take: ${describeNodeFields(type.state.definition)} (* = required).`,
      };
    }
    const n = validated.items.length;
    if (field.min !== undefined && n < field.min) {
      return { ok: false, message: `${where}: at least ${field.min} entries, got ${n}.` };
    }
    if (field.max !== undefined && n > field.max) {
      return { ok: false, message: `${where}: at most ${field.max} entries, got ${n}.` };
    }
    const refIssues = await checkEntryRefs(
      tx,
      branchId,
      type.state.definition,
      validated.items,
      null,
    );
    if (refIssues.length > 0) return { ok: false, message: describeIssues(refIssues) };
    return { ok: true, value: validated.items };
  }
  if (bind === "shared") {
    const listId = parseListRef(value);
    if (listId === null) {
      return {
        ok: false,
        message: `${where}: a shared list field takes caelo:list/<id> — lists.list shows the lists of type "${field.listType}".`,
      };
    }
    const list = await loadListEntity(tx, "list", branchId, listId);
    if (!list || list.state.deletedAt !== null) {
      return {
        ok: false,
        message: `${where}: list ${listId} does not exist — lists.list shows the lists.`,
      };
    }
    if (list.state.listTypeId !== type.id) {
      return {
        ok: false,
        message: `${where}: list "${list.state.slug}" is not of list type "${field.listType}" — bind a list of that type.`,
      };
    }
    return { ok: true, value };
  }
  // #1257 — a paginated field's placement may set its own `paginate`
  // (page size, follow-up indexing) next to the source's knobs.
  if (field.paginate !== undefined) {
    const { paginate, rest } = splitPaginationValue(value);
    if (paginate !== undefined) {
      const p = listPaginationSchema.safeParse(paginate);
      if (!p.success) {
        return {
          ok: false,
          message: `${where}.paginate: {per_page?: 1..50, follow_ups?: "index" | "noindex"} — ${p.error.issues[0]?.message ?? "invalid"}.`,
        };
      }
    }
    // The knobs are checked as for the unpaginated source.
    const { paginate: _settings, ...plain } = field;
    const inner = await normaliseOne(tx, ctx, branchId, plain, rest ?? {}, where);
    if (!inner.ok) return inner;
    const knobs = inner.value as Record<string, unknown>;
    return {
      ok: true,
      value: { ...knobs, ...(paginate !== undefined ? { paginate } : {}) },
    };
  }
  if (value !== null && typeof value === "object" && Object.hasOwn(value as object, "paginate")) {
    return {
      ok: false,
      message: `${where}.paginate: the module field "${field.name}" is not paginated — set paginate on the field itself (update_modules_many) to list every match across follow-up pages.`,
    };
  }
  // source: a system source takes only what the resolver reads from the
  // placement — `terms` for term_pages (#1121 review); no other system
  // or plugin source has per-placement knobs.
  if (field.source !== undefined && field.source.kind !== "query") {
    const overrides = (value ?? {}) as Record<string, unknown>;
    if (typeof overrides !== "object" || Array.isArray(overrides)) {
      return { ok: false, message: `${where}: a source override is an object.` };
    }
    const allowed =
      field.source.kind === "system" && field.source.name === "term_pages" ? ["terms"] : [];
    const bad = Object.keys(overrides).filter((k) => !allowed.includes(k));
    if (bad.length > 0) {
      return {
        ok: false,
        message: `${where}: ${bad.join(", ")} cannot be set per placement on this ${field.source.kind} source — accepted: ${allowed.join(", ") || "nothing"}.`,
      };
    }
    const terms = overrides.terms;
    if (
      terms !== undefined &&
      (!Array.isArray(terms) || terms.some((t) => typeof t !== "string" || !TERM_REF_RE.test(t)))
    ) {
      return {
        ok: false,
        message: `${where}: terms must be term references (caelo:term/<listId>/<itemId>) — get_list on the vocabulary shows its entry ids.`,
      };
    }
    return { ok: true, value: overrides };
  }
  // query source: knob overrides.
  const parsed = pageQueryPartialSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      message: `${where}: invalid query override: ${parsed.error.issues[0]?.message ?? ""}.`,
    };
  }
  const editable = field.source?.kind === "query" ? field.source.editable : [];
  const bad = Object.keys(parsed.data).filter((k) => !(editable as readonly string[]).includes(k));
  if (bad.length > 0) {
    return {
      ok: false,
      message: `${where}: ${bad.join(", ")} cannot be set per placement — editable: ${editable.join(", ") || "none"}.`,
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Normalise the `list` fields' defaults of a module field array (ids
 * assigned, values checked). Returns the fields to persist.
 */
export async function normaliseListFieldDefaults<F>(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  branchId: string | null,
  fields: readonly F[],
): Promise<Outcome<F[]>> {
  const out: F[] = [];
  for (const f of fields) {
    const [lf] = listFieldsOf([f]);
    if (!lf) {
      out.push(f);
      continue;
    }
    if (lf.list !== undefined && bindingOf(lf) === "shared") {
      const fixed = await normaliseOne(tx, ctx, branchId, lf, lf.list, `fields.${lf.name}.list`);
      if (!fixed.ok) return fixed;
    }
    if (lf.default === undefined) {
      out.push(f);
      continue;
    }
    const r = await normaliseOne(tx, ctx, branchId, lf, lf.default, `fields.${lf.name}.default`);
    if (!r.ok) return r;
    out.push({ ...(f as object), default: r.value } as F);
  }
  return { ok: true, value: out };
}

/**
 * Normalise a content instance's values for the module's `list` fields
 * (in place, like the url coercion of content_instances). A value for a
 * shared field whose module fixes the list is refused: the module decides.
 */
export async function normaliseListFieldValues(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  branchId: string | null,
  moduleFields: readonly unknown[],
  values: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  for (const f of listFieldsOf(moduleFields)) {
    const v = values[f.name];
    if (v === undefined || v === null) continue;
    if (bindingOf(f) === "shared" && f.list !== undefined) {
      return {
        ok: false,
        message: `values.${f.name}: the module binds this field to ${f.list} for every placement — edit that list (lists.patch_items_many) instead of setting a value here.`,
      };
    }
    const r = await normaliseOne(tx, ctx, branchId, f, v, `values.${f.name}`);
    if (!r.ok) return r;
    values[f.name] = r.value;
  }
  return { ok: true };
}

/** `link {label*, link*}; …` — each node kind with its fields, `*` = required. */
function describeNodeFields(def: ListTypeDef): string {
  return Object.entries(def.nodes)
    .map(
      ([kind, n]) =>
        `${kind} {${n.fields.map((f) => `${f.name}${f.required ? "*" : ""}`).join(", ")}}`,
    )
    .join("; ");
}
