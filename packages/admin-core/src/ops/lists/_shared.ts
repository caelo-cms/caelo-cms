// SPDX-License-Identifier: MPL-2.0

/**
 * Shared pieces of the list / list type / page type ops (epic #1107):
 * the bulk failure rule, AI-actionable error builders, link
 * canonicalisation of entries and the DB-backed checks on entry values
 * (embedded modules, terms) that `validateListItems` cannot do.
 */

import { OperationAbortError, type QueryError, type TransactionRunner } from "@caelo-cms/query-api";
import {
  canonicaliseHtmlLinks,
  canonicaliseUrl,
  diffListItems,
  type ExecutionContext,
  type FieldDef,
  type LinkCanonicaliseRun,
  type ListIssue,
  type ListItem,
  type ListTypeDef,
  TERM_REF_RE,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { emitDomainEvent } from "../../domain-events.js";
import { canonicaliseLinksForWrite } from "../../links/canonicalise.js";
import type { PendingLinkRecord } from "../../links/import-targets.js";
import { listFieldsOf, loadInstancesOfModules, loadModulesInView } from "../../lists/local.js";
import { loadListEntities, loadListEntityBySlug } from "../../lists/store.js";

/** The handler transaction type. */
export type Tx = TransactionRunner;

/** A HandlerError the ops return; `refusal` marks a guard working as designed (#1091). */
export function handlerError(operation: string, message: string, refusal = false): QueryError {
  return {
    kind: "HandlerError",
    operation,
    message,
    ...(refusal ? { refusal: true as const } : {}),
  };
}

/**
 * Bulk failure rule (CLAUDE.md §11, same as content_instances.create_many):
 * the whole batch is one transaction. Once something was written, a
 * failure must throw so the writes roll back — a returned error would
 * commit them.
 */
export function failBatch(wrote: boolean, error: QueryError): { ok: false; error: QueryError } {
  if (wrote) throw new OperationAbortError(error);
  return { ok: false, error };
}

/** "path: message; path: message" — at most `max` issues, then a count. */
export function describeIssues(issues: readonly ListIssue[], max = 8): string {
  const shown = issues.slice(0, max).map((i) => `${i.path}: ${i.message}`);
  const more = issues.length > max ? `; and ${issues.length - max} more` : "";
  return `${shown.join("; ")}${more}`;
}

/** The caller's branch (null outside a chat). */
export function branchOf(ctx: ExecutionContext): string | null {
  return ctx.chatBranchId ?? null;
}

/**
 * Store every link of an entry tree as a reference (epic #724): the href
 * of `link` fields, `media` values, links inside `richtext`. A link to a
 * page that does not exist refuses the write; links already in `previous`
 * are grandfathered. Inside a chat that rebuilds a site import, a link to
 * a page the run planned but has not built yet is kept literal and
 * returned as `pending` — the caller records it against the list
 * (`recordPendingImportLinks`) so the run's finalisation converts it.
 */
export async function canonicaliseItemsForWrite(
  tx: Tx,
  ctx: ExecutionContext,
  def: ListTypeDef,
  items: readonly ListItem[],
  previous: readonly ListItem[] | undefined,
): Promise<
  | { ok: true; items: ListItem[]; pending: PendingLinkRecord | null }
  | { ok: false; message: string }
> {
  const outcome = await canonicaliseLinksForWrite(
    tx,
    ctx,
    (run) => canonicaliseEntries(def, items, run, "items"),
    { previous, pendingEntity: "list" },
  );
  if (!outcome.ok) return { ok: false, message: outcome.message };
  return { ok: true, items: outcome.value, pending: outcome.pending };
}

/**
 * Turn humanised links in entries (`/about`, `/_caelo/media/<slug>`, a
 * query's parent path) back into references, field type by field type.
 * Pure over the run; local list values use it too (lists/field-values.ts).
 */
export function canonicaliseEntryLinks(
  def: ListTypeDef,
  items: readonly ListItem[],
  run: LinkCanonicaliseRun,
  at: string,
): ListItem[] {
  return canonicaliseEntries(def, items, run, at);
}

function canonicaliseEntries(
  def: ListTypeDef,
  items: readonly ListItem[],
  run: LinkCanonicaliseRun,
  at: string,
): ListItem[] {
  return items.map((it, i) => {
    const where = `${at}[${i}]`;
    const node = def.nodes[it.node];
    const values: Record<string, unknown> = { ...it.values };
    for (const f of node?.fields ?? []) {
      // An absent value stays absent: validation fills the field's default
      // only for a key the entry does not have.
      if (!Object.hasOwn(values, f.name)) continue;
      values[f.name] = canonicaliseFieldValue(f, values[f.name], run, `${where}.values.${f.name}`);
    }
    const out: { -readonly [K in keyof ListItem]: ListItem[K] } = { ...it, values };
    // A query's `parent` is a page reference; reads show it as the page's path.
    const parent = it.query?.parent;
    if (typeof parent === "string") {
      out.query = { ...it.query, parent: canonicaliseUrl(parent, run, `${where}.query.parent`) };
    }
    if (it.children) out.children = canonicaliseEntries(def, it.children, run, `${where}.children`);
    return out;
  });
}

function canonicaliseFieldValue(
  f: FieldDef,
  v: unknown,
  run: LinkCanonicaliseRun,
  where: string,
): unknown {
  if (v === undefined || v === null) return v;
  if (
    f.type === "link" &&
    typeof v === "object" &&
    typeof (v as { href?: unknown }).href === "string"
  ) {
    const link = v as { href: string };
    return { ...link, href: canonicaliseUrl(link.href, run, `${where}.href`) };
  }
  if (f.type === "media" && typeof v === "string") return canonicaliseUrl(v, run, where, "media");
  if (f.type === "richtext" && typeof v === "string") return canonicaliseHtmlLinks(v, run, where);
  return v;
}

/**
 * Checks on entry values that need the database: a `module` field must
 * name a module and one of its content instances the caller sees (of an
 * accepted type), and may not embed a module that renders this very list;
 * a `term` field's terms must be entries of its vocabulary list.
 *
 * @param selfListId the list being written (null for a local list).
 */
export async function checkEntryRefs(
  tx: Tx,
  branchId: string | null,
  def: ListTypeDef,
  items: readonly ListItem[],
  selfListId: string | null,
): Promise<ListIssue[]> {
  const issues: ListIssue[] = [];
  const moduleRefs: { path: string; field: FieldDef; moduleId: string; instanceId: string }[] = [];
  const termRefs: { path: string; listSlug: string; ref: string }[] = [];
  const walk = (level: readonly ListItem[], at: string): void => {
    level.forEach((it, i) => {
      const where = `${at}[${i}]`;
      for (const f of def.nodes[it.node]?.fields ?? []) {
        const v = it.values[f.name];
        if (v === undefined || v === null) continue;
        if (f.type === "module") {
          const ref = v as { moduleId: string; contentInstanceId: string };
          moduleRefs.push({
            path: `${where}.values.${f.name}`,
            field: f,
            moduleId: ref.moduleId,
            instanceId: ref.contentInstanceId,
          });
        } else if (f.type === "term" && Array.isArray(v)) {
          for (const ref of v) {
            if (typeof ref === "string") {
              termRefs.push({ path: `${where}.values.${f.name}`, listSlug: f.list, ref });
            }
          }
        }
      }
      if (it.children) walk(it.children, `${where}.children`);
    });
  };
  walk(items, "items");

  if (moduleRefs.length > 0) {
    const modules = new Map((await loadModulesInView(tx, branchId)).map((m) => [m.id, m]));
    const moduleTypes = await moduleTypesById(tx, [...new Set(moduleRefs.map((r) => r.moduleId))]);
    const instances = new Map(
      (
        await loadInstancesOfModules(tx, branchId, [...new Set(moduleRefs.map((r) => r.moduleId))])
      ).map((ci) => [ci.id, ci]),
    );
    for (const r of moduleRefs) {
      const m = modules.get(r.moduleId);
      if (!m) {
        issues.push({
          path: r.path,
          message: `module ${r.moduleId} does not exist (or was deleted) — pick one from list_modules.`,
        });
        continue;
      }
      const ci = instances.get(r.instanceId);
      if (!ci || ci.moduleId !== r.moduleId) {
        issues.push({
          path: r.path,
          message: `content instance ${r.instanceId} is not a content instance of module "${m.slug}" — create one with create_content_instance for that module and pass its id.`,
        });
      }
      const accepts = r.field.type === "module" ? r.field.accepts : undefined;
      const type = moduleTypes.get(r.moduleId);
      if (accepts && accepts.length > 0 && type !== undefined && !accepts.includes(type)) {
        issues.push({
          path: r.path,
          message: `module "${m.slug}" is of type "${type}", but this field accepts only ${accepts.join(", ")}.`,
        });
      }
      if (selfListId !== null) {
        const self = `caelo:list/${selfListId}`;
        const bindsSelf = listFieldsOf(m.fields).some((f) => f.list === self || f.default === self);
        if (bindsSelf) {
          issues.push({
            path: r.path,
            message: `module "${m.slug}" renders this list itself — embedding it in one of the list's entries would recurse forever. Embed a different module.`,
          });
        }
      }
    }
  }

  if (termRefs.length > 0) {
    const vocabularies = new Map<string, { id: string; itemIds: Set<string> } | null>();
    for (const slug of new Set(termRefs.map((t) => t.listSlug))) {
      const list = await loadListEntityBySlug(tx, "list", branchId, slug);
      vocabularies.set(
        slug,
        list ? { id: list.id, itemIds: collectItemIds(list.state.items) } : null,
      );
    }
    for (const t of termRefs) {
      const vocab = vocabularies.get(t.listSlug);
      const m = TERM_REF_RE.exec(t.ref);
      if (!vocab) {
        issues.push({
          path: t.path,
          message: `vocabulary list "${t.listSlug}" does not exist — create it (lists.upsert_many) or fix the field's list.`,
        });
      } else if (!m || m[1] !== vocab.id || !vocab.itemIds.has(m[2] ?? "")) {
        issues.push({
          path: t.path,
          message: `"${t.ref}" is not an entry of vocabulary "${t.listSlug}" — read it with lists.get and use caelo:term/${vocab.id}/<entry id>.`,
        });
      }
    }
  }
  return issues;
}

/** Every entry id of a tree. */
export function collectItemIds(items: readonly ListItem[]): Set<string> {
  const out = new Set<string>();
  const go = (level: readonly ListItem[]): void => {
    for (const it of level) {
      out.add(it.id);
      if (it.children) go(it.children);
    }
  };
  go(items);
  return out;
}

async function moduleTypesById(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, type FROM modules WHERE id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `)) as unknown as { id: string; type: string }[];
  return new Map(rows.map((r) => [r.id, r.type]));
}

/**
 * The entries of a list whose node kind is filled from a source (a mega
 * menu's "latest news" column): the ids preview_list_source takes as
 * `itemId`. Named in write results and in the preview's refusal, so the
 * AI never has to guess one (PR #1121 e2e: it passed the list's own id).
 */
export function sourceEntriesOf(
  def: ListTypeDef,
  items: readonly ListItem[],
): { id: string; node: string }[] {
  const out: { id: string; node: string }[] = [];
  const walk = (level: readonly ListItem[]): void => {
    for (const it of level) {
      if (def.nodes[it.node]?.source !== undefined) out.push({ id: it.id, node: it.node });
      if (it.children) walk(it.children);
    }
  };
  walk(items);
  return out;
}

/** The list types the caller sees, keyed by slug. */
export async function listTypesBySlug(
  tx: Tx,
  branchId: string | null,
): Promise<Map<string, { id: string; def: ListTypeDef }>> {
  const types = await loadListEntities(tx, "listType", branchId);
  return new Map(types.map((t) => [t.state.slug, { id: t.id, def: t.state.definition }]));
}

/**
 * `list.items_changed` with the per-entry diff (docs/lists.md §9) — only
 * when something changed. Payload stays small: ids, changed field names
 * and the values an update replaced (what a translation needs to flag
 * `needs_update`).
 */
export async function emitListItemsChanged(
  tx: Tx,
  listId: string,
  slug: string,
  before: readonly ListItem[],
  after: readonly ListItem[],
  branchId: string | null,
): Promise<void> {
  const changes = diffListItems(before, after);
  if (changes.length === 0) return;
  await emitDomainEvent(tx, {
    kind: "list.items_changed",
    entityId: listId,
    payload: { slug, changes, ...(branchId ? { chatBranchId: branchId } : {}) },
  });
}
