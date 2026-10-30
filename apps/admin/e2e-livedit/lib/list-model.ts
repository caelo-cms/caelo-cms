// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — the list model as the Real-AI scenarios read it: list
 * types, shared lists, page types, pages with their terms, modules and the
 * layout chrome placements, all in the DRAFT view (live rows plus the
 * newest pending snapshot of each entity). A chat's list writes are draft
 * state until a Stage (docs/lists.md §11), so a scenario that asserts
 * right after the turn must read the overlay, not the live rows.
 *
 * Split in two: {@link snapshotListModel} reads the database in a bun
 * subprocess (Playwright specs run under Node; bun:SQL is bun-only), and
 * the pure analysers below turn the snapshot into the facts the specs
 * assert — unit-tested in `list-model.test.ts` so a scenario failure
 * points at the AI's outcome, never at the assertion code.
 */

import { spawnSync } from "node:child_process";

/** One list entry as stored (docs/lists.md §4). */
export interface SnapItem {
  readonly id?: string;
  readonly node: string;
  readonly values?: Record<string, unknown>;
  readonly children?: readonly SnapItem[];
  readonly query?: Record<string, unknown>;
}

/** A list type's node definition, the parts the scenarios read. */
export interface SnapNodeDef {
  readonly label?: string;
  readonly fields?: readonly { name: string; type: string; list?: string }[];
  readonly children?: { name: string; allow: readonly string[] };
  readonly source?: { kind: string; name?: string; defaults?: Record<string, unknown> };
}

/** A list type definition (docs/lists.md §3). */
export interface SnapListTypeDef {
  readonly slug: string;
  readonly role: string;
  readonly root?: { allow: readonly string[] };
  readonly nodes: Readonly<Record<string, SnapNodeDef>>;
}

/** A module field, the parts the scenarios read (docs/lists.md §7). */
export interface SnapField {
  readonly name: string;
  readonly kind: string;
  readonly listType?: string;
  readonly bind?: string;
  readonly list?: string;
  readonly default?: unknown;
  readonly source?: { kind: string; name?: string; defaults?: Record<string, unknown> };
}

/** The draft-view snapshot a scenario asserts on. */
export interface ListModelSnapshot {
  readonly listTypes: readonly { id: string; slug: string; def: SnapListTypeDef }[];
  readonly lists: readonly { id: string; slug: string; listTypeId: string; items: SnapItem[] }[];
  readonly pageTypes: readonly {
    id: string;
    slug: string;
    def: { vocabularies?: readonly { list: string }[] };
  }[];
  readonly pages: readonly {
    id: string;
    slug: string;
    title: string;
    pageTypeId: string;
    terms: readonly string[];
  }[];
  readonly modules: readonly { id: string; html: string; fields: readonly SnapField[] }[];
  readonly chrome: readonly { blockName: string; moduleId: string }[];
  /** Content-instance values per module (a shared field's placement value lives here). */
  readonly instanceValues: readonly { moduleId: string; values: Record<string, unknown> }[];
  /** The migration-seeded `home` page type: its pages are no articles. */
  readonly homePageTypeId: string | null;
  /** Tool calls of the assistant messages (tool_calls + SDK response messages), see `toolsSince`. */
  readonly toolText: string;
  readonly lastAssistant: string;
}

const SNAPSHOT_SCRIPT = `
import { SQL } from "bun";
const sql = new SQL(process.env.ADMIN_DATABASE_URL);
// bun:SQL may hand jsonb back as a (double-encoded) string.
function parse(v) {
  let p = v;
  for (let i = 0; i < 3 && typeof p === "string"; i += 1) {
    try { p = JSON.parse(p); } catch { return null; }
  }
  return p;
}
// Newest PENDING snapshot state per entity (any branch: one chat per scenario).
async function overlay(tx, snapTable, idCol) {
  const rows = await tx.unsafe(\`
    SELECT DISTINCT ON (es.\${idCol}) es.\${idCol}::text AS id, es.state::text AS state
      FROM \${snapTable} es JOIN site_snapshots ss ON ss.id = es.site_snapshot_id
     WHERE ss.chat_branch_id IS NOT NULL AND ss.staged_at IS NULL AND ss.undone_at IS NULL
     ORDER BY es.\${idCol}, ss.created_at DESC, es.created_at DESC\`);
  return new Map(rows.map((r) => [r.id, parse(r.state)]));
}
let out;
await sql.begin(async (tx) => {
  await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
  const ltO = await overlay(tx, "list_type_snapshots", "list_type_id");
  const lO = await overlay(tx, "list_snapshots", "list_id");
  const ptO = await overlay(tx, "page_type_snapshots", "page_type_id");
  const pO = await overlay(tx, "page_snapshots", "page_id");
  const mO = await overlay(tx, "module_snapshots", "module_id");
  const alive = (s) => s && !s.deletedAt;
  const listTypes = (await tx.unsafe("SELECT id::text AS id, slug, definition::text AS d, deleted_at FROM list_types"))
    .map((r) => { const o = ltO.get(r.id); return o ? { id: r.id, slug: r.slug, def: o.definition, deletedAt: o.deletedAt } : { id: r.id, slug: r.slug, def: parse(r.d), deletedAt: r.deleted_at }; })
    .filter(alive).map(({ deletedAt, ...t }) => t);
  const lists = (await tx.unsafe("SELECT id::text AS id, slug, list_type_id::text AS t, items::text AS items, deleted_at FROM lists"))
    .map((r) => { const o = lO.get(r.id); return o ? { id: r.id, slug: r.slug, listTypeId: o.listTypeId, items: o.items, deletedAt: o.deletedAt } : { id: r.id, slug: r.slug, listTypeId: r.t, items: parse(r.items) ?? [], deletedAt: r.deleted_at }; })
    .filter(alive).map(({ deletedAt, ...l }) => l);
  const pageTypes = (await tx.unsafe("SELECT id::text AS id, slug, definition::text AS d, deleted_at FROM page_types"))
    .map((r) => { const o = ptO.get(r.id); return o ? { id: r.id, slug: r.slug, def: o.definition, deletedAt: o.deletedAt } : { id: r.id, slug: r.slug, def: parse(r.d), deletedAt: r.deleted_at }; })
    .filter(alive).map(({ deletedAt, ...t }) => t);
  const terms = new Map();
  for (const t of await tx.unsafe("SELECT page_id::text AS p, list_id::text AS l, item_id::text AS i FROM page_terms"))
    terms.set(t.p, [...(terms.get(t.p) ?? []), "caelo:term/" + t.l + "/" + t.i]);
  const pages = (await tx.unsafe("SELECT id::text AS id, slug, title, page_type_id::text AS pt, deleted_at FROM pages"))
    .map((r) => { const o = pO.get(r.id); return o
      ? { id: r.id, slug: o.slug, title: o.title, pageTypeId: o.pageTypeId, terms: o.terms ?? [], deletedAt: o.deletedAt }
      : { id: r.id, slug: r.slug, title: r.title, pageTypeId: r.pt, terms: terms.get(r.id) ?? [], deletedAt: r.deleted_at }; })
    .filter(alive).map(({ deletedAt, ...p }) => p);
  const modules = (await tx.unsafe("SELECT id::text AS id, html, fields::text AS f, deleted_at FROM modules"))
    .map((r) => { const o = mO.get(r.id); return o ? { id: r.id, html: o.html ?? "", fields: o.fields ?? [], deletedAt: o.deletedAt } : { id: r.id, html: r.html ?? "", fields: parse(r.f) ?? [], deletedAt: r.deleted_at }; })
    .filter(alive).map(({ deletedAt, ...m }) => m);
  // Layout chrome in the draft view (pending block state over live rows), as scenario-ai-layout-footer reads it.
  const chrome = await tx.unsafe(\`
    WITH ov AS (
      SELECT DISTINCT ON (lms.layout_id, lms.block_name) lms.layout_id, lms.block_name, lms.state
        FROM layout_module_snapshots lms JOIN site_snapshots ss ON ss.id = lms.site_snapshot_id
       WHERE ss.chat_branch_id IS NOT NULL AND ss.staged_at IS NULL AND ss.undone_at IS NULL
       ORDER BY lms.layout_id, lms.block_name, ss.created_at DESC, lms.created_at DESC
    )
    SELECT live.block_name AS "blockName", live.module_id::text AS "moduleId" FROM layout_modules live
     WHERE NOT EXISTS (SELECT 1 FROM ov WHERE ov.layout_id = live.layout_id AND ov.block_name = live.block_name)
    UNION ALL
    SELECT ov.block_name, e.mid FROM ov CROSS JOIN LATERAL jsonb_array_elements_text(ov.state->'moduleIds') AS e(mid)\`);
  const ciO = await overlay(tx, "content_instance_snapshots", "content_instance_id");
  const instanceValues = (await tx.unsafe('SELECT id::text AS id, module_id::text AS m, "values"::text AS v FROM content_instances'))
    .map((r) => ({ moduleId: r.m, values: (ciO.get(r.id)?.values) ?? parse(r.v) ?? {} }));
  const sd = await tx.unsafe("SELECT id::text AS id FROM page_types WHERE slug = 'home' AND chat_branch_id IS NULL AND deleted_at IS NULL");
  const tools = await tx.unsafe(\`
    SELECT string_agg(COALESCE(tool_calls::text, '') || ' ' || COALESCE(response_messages::text, ''), ' ') AS t
      FROM chat_messages WHERE role = 'assistant' AND created_at > $1::timestamptz\`, [process.env.TOOLS_SINCE]);
  const last = await tx.unsafe(\`
    SELECT content FROM chat_messages
     WHERE role = 'assistant' AND content IS NOT NULL AND content <> ''
     ORDER BY created_at DESC LIMIT 1\`);
  out = { listTypes, lists, pageTypes, pages, modules, chrome, instanceValues,
    homePageTypeId: sd[0]?.id ?? null, toolText: tools[0]?.t ?? "", lastAssistant: last[0]?.content ?? "" };
});
await sql.end();
console.log(JSON.stringify(out));
`;

/**
 * Read the draft-view list model (see the file header). `toolsSince`
 * (ISO) limits `toolText` to the assistant messages after it, so a
 * follow-up turn's tool use can be asserted on its own.
 */
export function snapshotListModel(opts: { toolsSince?: string } = {}): ListModelSnapshot {
  const r = spawnSync("bun", ["-e", SNAPSHOT_SCRIPT], {
    env: { ...process.env, TOOLS_SINCE: opts.toolsSince ?? "-infinity" },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`snapshotListModel failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout) as ListModelSnapshot;
}

// ─── Pure analysers ──────────────────────────────────────────────────

const LIST_REF_RE = /^caelo:list\/([0-9a-f-]{36})$/;

/** Every entry of a tree, depth first. */
export function flattenItems(items: readonly SnapItem[]): SnapItem[] {
  return items.flatMap((it) => [it, ...flattenItems(it.children ?? [])]);
}

/** All string values of an entry tree, lowercased — for label checks. */
export function entryText(items: readonly SnapItem[]): string {
  return flattenItems(items)
    .flatMap((it) => Object.values(it.values ?? {}))
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
}

/** The `list` fields of a module. */
export function listFields(fields: readonly SnapField[]): SnapField[] {
  return fields.filter((f) => f.kind === "list");
}

/**
 * The shared list a module's list field shows: the fixed `list`, a
 * shared default, or a placement value `caelo:list/<id>` of one of the
 * module's content instances. Null for a local or source field.
 */
export function boundListId(
  snap: ListModelSnapshot,
  moduleId: string,
  field: SnapField,
): string | null {
  if (field.bind !== "shared") return null;
  const candidates: unknown[] = [field.list, field.default];
  for (const ci of snap.instanceValues) {
    if (ci.moduleId === moduleId) candidates.push(ci.values[field.name]);
  }
  for (const c of candidates) {
    const m = typeof c === "string" ? LIST_REF_RE.exec(c) : null;
    if (m?.[1]) return m[1];
  }
  return null;
}

/** The modules placed in a layout block, with their list fields. */
export function chromeModules(
  snap: ListModelSnapshot,
  blockName: string,
): { id: string; html: string; fields: readonly SnapField[] }[] {
  const ids = new Set(snap.chrome.filter((c) => c.blockName === blockName).map((c) => c.moduleId));
  return snap.modules.filter((m) => ids.has(m.id));
}

/** Shared lists the modules of a layout block are bound to. */
export function chromeBoundLists(snap: ListModelSnapshot, blockName: string): string[] {
  const out = new Set<string>();
  for (const m of chromeModules(snap, blockName)) {
    for (const f of listFields(m.fields)) {
      const id = boundListId(snap, m.id, f);
      if (id) out.add(id);
    }
  }
  return [...out];
}

/** What a mega-menu run produced, for the assertion messages. */
export interface MegaMenuFacts {
  /** A shared list bound in BOTH header and footer (null when none). */
  readonly listId: string | null;
  /**
   * Entries at any depth that hold links: at least one child that is a leaf
   * and not a query node. Top-level columns and columns inside one "Menu"
   * trigger entry both count — the prompt asks for three columns, not for
   * where the menu's root sits (e2e-livedit run 40360756064 built the
   * three columns under one trigger entry and was counted as one).
   */
  readonly columnCount: number;
  /** The list's type has a node kind filled by a page query. */
  readonly typeHasQueryNode: boolean;
  /** The list has an entry of that query node kind. */
  readonly listHasQueryEntry: boolean;
  /** All entry text of the list, lowercased. */
  readonly text: string;
}

/** Facts of the mega menu: the shared list header and footer both show. */
export function megaMenuFacts(snap: ListModelSnapshot): MegaMenuFacts {
  const header = new Set(chromeBoundLists(snap, "header"));
  const shared = chromeBoundLists(snap, "footer").filter((id) => header.has(id));
  // Prefer the list that looks most like a mega menu when several qualify.
  const scored = shared
    .map((id) => {
      const list = snap.lists.find((l) => l.id === id);
      const type = snap.listTypes.find((t) => t.id === list?.listTypeId);
      if (!list || !type) return null;
      const queryNodes = new Set(
        Object.entries(type.def.nodes)
          .filter(([, n]) => n.source?.kind === "query")
          .map(([k]) => k),
      );
      const columnCount = flattenItems(list.items).filter((it) =>
        (it.children ?? []).some((c) => (c.children ?? []).length === 0 && !queryNodes.has(c.node)),
      ).length;
      return {
        listId: id,
        columnCount,
        typeHasQueryNode: queryNodes.size > 0,
        listHasQueryEntry: flattenItems(list.items).some((it) => queryNodes.has(it.node)),
        text: entryText(list.items),
      };
    })
    .filter((f): f is MegaMenuFacts & { listId: string } => f !== null)
    .sort((a, b) => b.columnCount - a.columnCount);
  return (
    scored[0] ?? {
      listId: null,
      columnCount: 0,
      typeHasQueryNode: false,
      listHasQueryEntry: false,
      text: "",
    }
  );
}

/** What a blog-categories run produced. */
export interface BlogCategoryFacts {
  /** The vocabulary list carrying the requested category names (null when none). */
  readonly vocabularyId: string | null;
  readonly categoryNames: readonly string[];
  /** Page types (not the site default) that take that vocabulary. */
  readonly articleTypeIds: readonly string[];
  /** Pages of those types carrying a term of the vocabulary. */
  readonly taggedArticles: number;
  /** Distinct categories the tagged articles cover. */
  readonly coveredCategories: number;
  /** Modules listing pages by term (`term_pages` system source or a query with terms). */
  readonly termListingModules: number;
}

/** Facts of the blog-categories outcome, `wanted` = category names (lowercase). */
export function blogCategoryFacts(
  snap: ListModelSnapshot,
  wanted: readonly string[],
): BlogCategoryFacts {
  const vocabTypeIds = new Set(
    snap.listTypes.filter((t) => t.def.role === "vocabulary").map((t) => t.id),
  );
  const vocab = snap.lists
    .filter((l) => vocabTypeIds.has(l.listTypeId))
    .map((l) => ({ l, hits: wanted.filter((w) => entryText(l.items).includes(w)).length }))
    .sort((a, b) => b.hits - a.hits)[0];
  const termListingModules = snap.modules.filter((m) =>
    listFields(m.fields).some(
      (f) =>
        (f.source?.kind === "system" && f.source.name === "term_pages") ||
        (f.source?.kind === "query" && f.source.defaults?.terms !== undefined) ||
        (f.source?.kind === "query" &&
          snap.instanceValues.some(
            (ci) =>
              ci.moduleId === m.id &&
              typeof ci.values[f.name] === "object" &&
              ci.values[f.name] !== null &&
              "terms" in (ci.values[f.name] as object),
          )),
    ),
  ).length;
  if (!vocab || vocab.hits === 0) {
    return {
      vocabularyId: null,
      categoryNames: [],
      articleTypeIds: [],
      taggedArticles: 0,
      coveredCategories: 0,
      termListingModules,
    };
  }
  const listId = vocab.l.id;
  const articleTypeIds = snap.pageTypes
    .filter(
      (t) =>
        t.id !== snap.homePageTypeId && (t.def.vocabularies ?? []).some((v) => v.list === listId),
    )
    .map((t) => t.id);
  const prefix = `caelo:term/${listId}/`;
  const tagged = snap.pages.filter(
    (p) => articleTypeIds.includes(p.pageTypeId) && p.terms.some((t) => t.startsWith(prefix)),
  );
  const covered = new Set(
    tagged.flatMap((p) =>
      p.terms.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length)),
    ),
  );
  return {
    vocabularyId: listId,
    categoryNames: flattenItems(vocab.l.items)
      .map((it) => it.values?.name)
      .filter((n): n is string => typeof n === "string"),
    articleTypeIds,
    taggedArticles: tagged.length,
    coveredCategories: covered.size,
    termListingModules,
  };
}

/** True when the chats called `tool` (tool_calls or SDK response messages). */
export function calledTool(snap: ListModelSnapshot, tool: string): boolean {
  return snap.toolText.includes(`"${tool}"`);
}
