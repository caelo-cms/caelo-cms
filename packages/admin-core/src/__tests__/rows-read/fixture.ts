// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — the rows-read test's fixture: one shape, grown in place
 * from the small size to the large one (10x along every history
 * dimension, not only pages):
 *
 * | dimension                          | small | large |
 * |------------------------------------|-------|-------|
 * | pages (each with a placement)      | 1k    | 10k   |
 * | pending snapshots on the draft     | 2k    | 20k   |
 * | open chats on the draft            | 20    | 200   |
 * | lists, media, plugin row snapshots | n     | 10n   |
 * | staged snapshots                   | 20k   | 200k  |
 *
 * Volume is bulk SQL (creating 10,000 pages through `pages.create` would
 * measure `pages.create`); structure — the module, the chats — goes
 * through the real operations.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";

/** One fixture size. */
export interface FixtureSize {
  readonly pages: number;
  readonly pending: number;
  readonly chats: number;
  readonly lists: number;
  readonly media: number;
  readonly pluginRows: number;
  readonly staged: number;
}

export const SMALL: FixtureSize = {
  pages: 1_000,
  pending: 2_000,
  chats: 20,
  lists: 20,
  media: 100,
  pluginRows: 200,
  staged: 20_000,
};

/** {@link SMALL} times ten, every dimension. */
export const LARGE: FixtureSize = Object.fromEntries(
  Object.entries(SMALL).map(([k, v]) => [k, v * 10]),
) as unknown as FixtureSize;

export const RR_PREFIX = "rr1267-";

/**
 * What the inputs registry needs to name real rows. The read targets carry
 * no history of their own, at either size, so a read of them measures what
 * the SITE adds; the write targets are fresh per size, so both sizes write
 * an entity in the same state.
 */
export interface FixtureRefs {
  readonly moduleId: string;
  readonly pageId: string;
  readonly instanceId: string;
  readonly write: {
    readonly moduleId: string;
    readonly pageId: string;
    readonly instanceId: string;
  };
  readonly listId: string;
  readonly mediaId: string;
  readonly chatSessionId: string;
  readonly chatBranchId: string;
  readonly chat: ExecutionContext;
}

const ACTOR = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: ACTOR, actorKind: "system", requestId: "rows-read" };

async function asSystem<T>(url: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(url);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function count(url: string, query: string): Promise<number> {
  const rows = await asSystem(url, (tx) => tx.unsafe(query) as Promise<{ n: number }[]>);
  return rows[0]?.n ?? 0;
}

/**
 * Grow the fixture to `size` (from empty or from a smaller size) and
 * return the rows the inputs name. Idempotent per size.
 */
export async function growFixture(
  deps: { adapter: DatabaseAdapter; registry: OperationRegistry; adminUrl: string },
  size: FixtureSize,
): Promise<FixtureRefs> {
  const url = deps.adminUrl;
  const op = async <T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> => {
    const r = await execute(deps.registry, deps.adapter, ctx, name, input);
    if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    return r.value as T;
  };

  const existing = await asSystem(
    url,
    (tx) =>
      tx`SELECT id::text AS id FROM modules WHERE slug = ${`${RR_PREFIX}article`}` as Promise<
        { id: string }[]
      >,
  );
  const moduleId =
    existing[0]?.id ??
    (
      await op<{ moduleId: string }>(SYS, "modules.create", {
        slug: `${RR_PREFIX}article`,
        displayName: "Article",
        html: "<article><h2>{{heading}}</h2>{{{body}}}</article>",
        fields: [
          { name: "heading", label: "Heading", kind: "text" },
          { name: "body", label: "Body", kind: "richtext" },
        ],
      })
    ).moduleId;

  const defaults = await asSystem(
    url,
    (tx) =>
      tx`SELECT default_template_id::text AS t, default_page_type_id::text AS pt FROM site_defaults WHERE id = 1` as Promise<
        { t: string; pt: string }[]
      >,
  );
  const templateId = defaults[0]?.t ?? "";
  const pageTypeId = defaults[0]?.pt ?? "";
  if (!templateId || !pageTypeId) throw new Error("site_defaults seed missing");

  // Chats: open, bound to the shared draft.
  const chatsNow = await count(
    url,
    `SELECT count(*)::int AS n FROM chat_sessions WHERE title LIKE '${RR_PREFIX}%' AND archived_at IS NULL`,
  );
  for (let i = chatsNow; i < size.chats; i++) {
    await op(SYS, "chat.create_session", { title: `${RR_PREFIX}chat-${i}` });
  }
  const chats = await asSystem(
    url,
    (tx) =>
      tx`SELECT id::text AS id, chat_branch_id::text AS branch FROM chat_sessions
          WHERE title LIKE ${`${RR_PREFIX}%`} AND archived_at IS NULL ORDER BY created_at` as Promise<
        { id: string; branch: string }[]
      >,
  );
  const first = chats[0];
  if (!first) throw new Error("no fixture chat");

  await asSystem(url, async (tx) => {
    const pagesNow =
      (
        (await tx`SELECT count(*)::int AS n FROM pages WHERE slug LIKE ${`${RR_PREFIX}p-%`}`) as {
          n: number;
        }[]
      )[0]?.n ?? 0;
    if (pagesNow < size.pages) {
      await tx.unsafe(`
        WITH p AS (
          INSERT INTO pages (slug, title, short_title, template_id, page_type_id, current_path, status)
          SELECT '${RR_PREFIX}p-' || i, 'Page ' || i, 'Page ' || i, '${templateId}', '${pageTypeId}',
                 '/${RR_PREFIX}p-' || i, 'published'
            FROM generate_series(${pagesNow + 1}, ${size.pages}) i
          RETURNING id, title),
        ci AS (
          INSERT INTO content_instances (module_id, "values")
          SELECT '${moduleId}', jsonb_build_object('heading', p.title, 'body', '<p>Body</p>') FROM p
          RETURNING id),
        pairs AS (
          SELECT p.id AS page_id, c.id AS ci_id
            FROM (SELECT id, row_number() OVER () AS n FROM p) p
            JOIN (SELECT id, row_number() OVER () AS n FROM ci) c USING (n))
        INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
        SELECT page_id, 'content', 0, '${moduleId}', ci_id, 'unsynced' FROM pairs`);
    }
    const listsNow =
      (
        (await tx`SELECT count(*)::int AS n FROM lists WHERE slug LIKE ${`${RR_PREFIX}%`}`) as {
          n: number;
        }[]
      )[0]?.n ?? 0;
    if (listsNow < size.lists) {
      await tx.unsafe(`
        INSERT INTO lists (slug, name, purpose, list_type_id, items)
        SELECT '${RR_PREFIX}l-' || i, 'List ' || i, 'Fixture list',
               (SELECT id FROM list_types WHERE slug = 'menu' AND deleted_at IS NULL),
               jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'node', 'entry',
                 'values', jsonb_build_object('label', 'Entry ' || i)))
          FROM generate_series(${listsNow + 1}, ${size.lists}) i`);
    }
    const mediaNow =
      (
        (await tx`SELECT count(*)::int AS n FROM media_assets WHERE slug LIKE ${`${RR_PREFIX}%`}`) as {
          n: number;
        }[]
      )[0]?.n ?? 0;
    if (mediaNow < size.media) {
      await tx.unsafe(`
        INSERT INTO media_assets (sha256, original_name, mime, size_bytes, storage_key, created_by, slug, alt)
        SELECT md5(i::text) || md5(i::text), 'm' || i || '.png', 'image/png', 1, 'rr/' || i,
               '${ACTOR}', '${RR_PREFIX}m-' || i, 'Image ' || i
          FROM generate_series(${mediaNow + 1}, ${size.media}) i`);
    }
    // History: staged headers (main line) and pending ones on the draft,
    // each with a page snapshot, spread over the pages and the chats.
    const chatArray = `ARRAY['${chats.map((c) => c.id).join("','")}']::uuid[]`;
    const snapshotsOf = async (what: "staged" | "pending", target: number) => {
      const now =
        (
          (await tx.unsafe(
            `SELECT count(*)::int AS n FROM site_snapshots WHERE description = '${RR_PREFIX}${what}'`,
          )) as { n: number }[]
        )[0]?.n ?? 0;
      if (now >= target) return;
      await tx.unsafe(`
        WITH pg AS (SELECT id, slug, title, row_number() OVER (ORDER BY id) AS rn FROM pages
                     WHERE slug LIKE '${RR_PREFIX}p-%' AND slug <> '${RR_PREFIX}p-1'),
             cnt AS (SELECT count(*) AS c FROM pg),
             h AS (
               INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id,
                                           created_at, staged_at)
               SELECT '${ACTOR}', 'pages.update', '${RR_PREFIX}${what}',
                      (${chatArray})[1 + i % ${chats.length}], '${first.branch}',
                      now() - ((${target} - i) || ' seconds')::interval - interval '2 days',
                      ${what === "staged" ? `now() - ((${target} - i) || ' seconds')::interval - interval '1 day'` : "NULL"}
                 FROM generate_series(${now + 1}, ${target}) i
               RETURNING id, created_at)
        INSERT INTO page_snapshots (site_snapshot_id, page_id, state)
        SELECT h.id, pg.id,
               jsonb_build_object('schemaVersion', 1, 'slug', pg.slug, 'title', pg.title || ' (h)',
                                  'shortTitle', pg.title, 'templateId', '${templateId}', 'status', 'published',
                                  'version', 1, 'deletedAt', null, 'parentPageId', null,
                                  'pageTypeId', '${pageTypeId}', 'properties', '{}'::jsonb, 'terms', '[]'::jsonb)
          FROM (SELECT id, row_number() OVER (ORDER BY created_at) AS n FROM h) h
         CROSS JOIN cnt
          JOIN pg ON pg.rn = 1 + (h.n % cnt.c)`);
    };
    // Bulk history is loaded without journal rows, inside this transaction
    // only: in production snapshots this old are past the journal's
    // retention, so their rows would be gone; and the per-row previous-
    // snapshot lookup of a 200k-row bulk insert is not what is measured.
    for (const t of ["site_snapshots", "page_snapshots", "plugin_row_snapshots"]) {
      await tx.unsafe(`ALTER TABLE ${t} DISABLE TRIGGER caelo_journal_insert`);
    }
    await snapshotsOf("staged", size.staged);
    await snapshotsOf("pending", size.pending);
    // Plugin row snapshots of a plugin that is not installed: history any
    // per-plugin read must not scan.
    const rowsNow =
      (
        (await tx.unsafe(
          `SELECT count(*)::int AS n FROM plugin_row_snapshots WHERE table_name = 'rr_rows'`,
        )) as { n: number }[]
      )[0]?.n ?? 0;
    if (rowsNow < size.pluginRows) {
      await tx.unsafe(`
        WITH pl AS (
          INSERT INTO plugins (id, slug, version, tier, status, manifest_json, manifest_signature, submitted_by)
          VALUES ('00000000-0000-4000-8000-000000001267', 'rr1267-history', '0.1.0', 1, 'disabled',
                  '{}'::jsonb, 'fixture', '${ACTOR}')
          ON CONFLICT (id) DO NOTHING RETURNING id),
        h AS (
          INSERT INTO site_snapshots (actor_id, op_kind, description, chat_branch_id)
          VALUES ('${ACTOR}', 'pages.update', '${RR_PREFIX}plugin-rows', '${first.branch}')
          RETURNING id)
        INSERT INTO plugin_row_snapshots (site_snapshot_id, plugin_id, schema_name, table_name, row_id, state)
        SELECT h.id, '00000000-0000-4000-8000-000000001267', 'plugin_rr', 'rr_rows', gen_random_uuid(), '{}'::jsonb
          FROM h, generate_series(${rowsNow + 1}, ${size.pluginRows})`);
    }
    for (const t of ["site_snapshots", "page_snapshots", "plugin_row_snapshots"]) {
      await tx.unsafe(`ALTER TABLE ${t} ENABLE TRIGGER caelo_journal_insert`);
    }
  });
  // Statistics like a site that grew to this size (autovacuum would do it).
  await asSystem(url, async (tx) => {
    for (const t of [
      "pages",
      "page_modules",
      "content_instances",
      "site_snapshots",
      "page_snapshots",
      "lists",
      "media_assets",
      "plugin_row_snapshots",
      "chat_sessions",
    ]) {
      await tx.unsafe(`ANALYZE ${t}`);
    }
  });

  // Write targets, fresh per size.
  const tag = `w-${size.pages}`;
  const writeModule = await op<{ moduleId: string }>(SYS, "modules.create", {
    slug: `${RR_PREFIX}${tag}`,
    displayName: "Write target",
    html: "<p>{{heading}}</p>",
    fields: [{ name: "heading", label: "Heading", kind: "text" }],
  });
  const written = await asSystem(
    url,
    (tx) =>
      tx.unsafe(`
        WITH p AS (
          INSERT INTO pages (slug, title, short_title, template_id, page_type_id, current_path, status)
          VALUES ('${RR_PREFIX}${tag}', 'Write target', 'Write target', '${templateId}', '${pageTypeId}',
                  '/${RR_PREFIX}${tag}', 'published')
          RETURNING id),
        ci AS (
          INSERT INTO content_instances (module_id, "values")
          VALUES ('${writeModule.moduleId}', '{"heading": "Write target"}'::jsonb) RETURNING id),
        pm AS (
          INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
          SELECT p.id, 'content', 0, '${writeModule.moduleId}', ci.id, 'unsynced' FROM p, ci
          RETURNING page_id, content_instance_id)
        SELECT page_id::text AS page_id, content_instance_id::text AS instance_id FROM pm`) as Promise<
        { page_id: string; instance_id: string }[]
      >,
  );
  const w = written[0];
  if (!w) throw new Error("rows-read fixture: write target missing");

  const refs = await asSystem(
    url,
    (tx) =>
      tx`SELECT
          (SELECT id::text FROM pages WHERE slug = ${`${RR_PREFIX}p-1`}) AS page_id,
          (SELECT pm.content_instance_id::text FROM page_modules pm JOIN pages p ON p.id = pm.page_id
            WHERE p.slug = ${`${RR_PREFIX}p-1`} LIMIT 1) AS instance_id,
          (SELECT id::text FROM lists WHERE slug = ${`${RR_PREFIX}l-1`}) AS list_id,
          (SELECT id::text FROM media_assets WHERE slug = ${`${RR_PREFIX}m-1`}) AS media_id` as Promise<
        { page_id: string; instance_id: string; list_id: string; media_id: string }[]
      >,
  );
  const r = refs[0];
  if (!r?.page_id || !r.instance_id || !r.list_id || !r.media_id) {
    throw new Error("rows-read fixture: reference rows missing");
  }
  return {
    moduleId,
    pageId: r.page_id,
    instanceId: r.instance_id,
    write: { moduleId: writeModule.moduleId, pageId: w.page_id, instanceId: w.instance_id },
    listId: r.list_id,
    mediaId: r.media_id,
    chatSessionId: first.id,
    chatBranchId: first.branch,
    chat: {
      actorId: ACTOR,
      actorKind: "ai",
      requestId: "rows-read-chat",
      chatBranchId: first.branch,
      chatTaskId: first.id,
    },
  };
}
