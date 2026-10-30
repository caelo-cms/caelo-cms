// SPDX-License-Identifier: MPL-2.0

/**
 * The published projection: what the admin publishes from cms_admin into
 * cms_public so the public API gateway never reads authoring state
 * (issue #635, CLAUDE.md §2 "the public side has no path to cms_admin").
 *
 * ## Direction and trust
 *
 * One way only: admin → public. The projection is a pure function of
 * cms_admin; every publish recomputes a section from the source of truth
 * and REPLACES it in cms_public. Nothing here reads the published tables
 * back, so a compromised public side that rewrites them can mislead only
 * the public side itself, never the admin.
 *
 * What crosses is declared here, column by column (the `SECTION_*` SQL
 * below) and, for plugin private storage, by the plugin's
 * `visitorProjection` in its signed definition. Adding a column to the
 * projection is a reviewed change to this file or to a plugin manifest.
 *
 * ## Freshness
 *
 * cms_admin migration 0281 puts triggers on every source table: each
 * committed write leaves a row in `public_projection_outbox` (same
 * transaction as the write). {@link drainPublicProjection} republishes the
 * sections named there and deletes the rows; the admin runs it on a short
 * poll (admin-core `startPublicProjectionPublisher`). The migration job and
 * the admin's boot publish everything ({@link publishPublicProjection}),
 * so an install converges even when the outbox was written before the
 * triggers that a newer release adds.
 *
 * Publishers serialise on a cms_admin advisory lock held across the read
 * and the cms_public write, so an older read can never overwrite a newer
 * publish.
 *
 * ## Why this is not a set of Query API ops
 *
 * CLAUDE.md §2 routes every *actor's* database access through Query API
 * ops, so it is validated, RLS-scoped and audited. The publisher is not an
 * actor's action: it copies state that ops already wrote (and audited) into
 * a derived, read-only replica, with no input from anyone. It runs as the
 * `system` actor inside the adapter's own transactions
 * (`DatabaseAdapter.withAdminTransaction` / `withPublicTransaction`, the
 * established path for system workers such as the site-import crawl
 * worker and the plugin host loader), so RLS still applies, and the only
 * identifiers it interpolates are the validated ones above. Auditing each
 * publish would record the same change twice, once per database; the
 * write that caused it is the audit record. The SQL also has to run in
 * the migration job, which has no op registry.
 */

import { type SQL, sql } from "drizzle-orm";

/** The query surface a publisher needs on each side (a drizzle transaction fits). */
export interface ProjectionTx {
  execute(query: SQL): Promise<unknown>;
}

/**
 * How the publisher reaches the two databases. Both callbacks run their
 * function in ONE transaction as the `system` actor: `readAdmin` on
 * cms_admin as admin_role, `writePublic` on cms_public as admin_role.
 */
export interface ProjectionDatabases {
  readAdmin<T>(fn: (tx: ProjectionTx) => Promise<T>): Promise<T>;
  writePublic(fn: (tx: ProjectionTx) => Promise<void>): Promise<void>;
}

/**
 * A plugin's declared visitor-readable projection of its private storage:
 * table → the columns visitor operations may read (`id` always included).
 */
export type VisitorProjection = Readonly<Record<string, ReadonlyArray<string>>>;

/**
 * What this publisher knows of each plugin's projection, by slug:
 *
 *   - a projection: the plugin runs here (or ships in this image) and
 *     declares it;
 *   - `null`: the plugin runs here and declares none, so nothing of it may
 *     stay published (a version that dropped its declaration);
 *   - no entry: this publisher does not have the plugin — an instance that
 *     has not loaded it yet, whose load failed, or the migration job facing
 *     a runtime-installed plugin. Its section is left exactly as published
 *     and its outbox rows stay for a publisher that has it (#1077: treating
 *     "not loaded here" as "declares nothing" withdrew the section another
 *     publisher had just written, and the gateway answered 503).
 */
export type VisitorProjectionDeclarations = ReadonlyMap<string, VisitorProjection | null>;

/** A section of the projection, as the outbox and `published_projection_sections` name it. */
export type ProjectionSection =
  | "settings"
  | "staging"
  | "rate_limits"
  | "plugins"
  | "comments"
  | `plugin:${string}`;

/** What one publish did, for logs and tests. */
export interface PublishReport {
  readonly sections: readonly ProjectionSection[];
  /** Comments republished one by one (outbox entities), not counting a full resync. */
  readonly comments: number;
  /** Outbox rows consumed. */
  readonly drained: number;
  /** Plugins whose declared tables are not provisioned yet (published on the admin's next boot). */
  readonly pendingPlugins: readonly string[];
}

/** NOTIFY channel the gateway listens on (cms_public); the payload names the section. */
export const GATEWAY_PROJECTION_CHANNEL = "caelo_gateway_settings";

/**
 * A list bound as ONE parameter (a JSON array expanded server-side), never
 * one parameter per element: Postgres refuses a statement past 65,535
 * parameters (#1267, rule 7). The same as `textArray` / `uuidArray` in
 * @caelo-cms/query-api, which this package does not depend on.
 */
function textArray(values: readonly string[]): SQL {
  return sql`ARRAY(SELECT jsonb_array_elements_text((${JSON.stringify(values)}::text)::jsonb))`;
}

/** {@link textArray} for uuids. */
function uuidArray(values: readonly string[]): SQL {
  return sql`ARRAY(SELECT jsonb_array_elements_text((${JSON.stringify(values)}::text)::jsonb)::uuid)`;
}

const PROJECTION_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('caelo_public_projection'))`;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const SLUG_RE = /^[a-z][a-z0-9-]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Rows per INSERT into cms_public. */
const CHUNK = 500;

type Row = Record<string, unknown>;

async function rows(tx: ProjectionTx, query: SQL): Promise<Row[]> {
  return (await tx.execute(query)) as unknown as Row[];
}

/**
 * Validate a plugin's declaration before any identifier from it reaches
 * SQL. The manifest schema already checks it; this is the publisher's own
 * gate, because the migration job reads declarations straight from disk.
 */
export function assertVisitorProjection(slug: string, projection: VisitorProjection): void {
  if (!SLUG_RE.test(slug)) throw new Error(`visitorProjection: invalid plugin slug "${slug}"`);
  for (const [table, columns] of Object.entries(projection)) {
    if (!IDENT_RE.test(table)) {
      throw new Error(`visitorProjection of "${slug}": invalid table name "${table}"`);
    }
    for (const c of columns) {
      if (!IDENT_RE.test(c) || c.startsWith("caelo_")) {
        throw new Error(`visitorProjection of "${slug}".${table}: invalid column "${c}"`);
      }
    }
  }
}

/** `jsonb_build_object('id', t.id, 'col', t.col, …)` over validated identifiers. */
function projectedRowJson(columns: ReadonlyArray<string>): SQL {
  const names = [...new Set(["id", ...columns])];
  const chunks: SQL[] = [];
  // jsonb_build_object takes at most 100 arguments.
  for (let i = 0; i < names.length; i += 40) {
    const pairs = names.slice(i, i + 40).map((n) => sql`${n}::text, t.${sql.raw(`"${n}"`)}`);
    chunks.push(sql`jsonb_build_object(${sql.join(pairs, sql`, `)})`);
  }
  return sql.join(chunks, sql` || `);
}

/** Replace a whole table's contents in cms_public with `data`. */
async function replaceAll(
  tx: ProjectionTx,
  table: string,
  columns: string,
  recordset: string,
  data: readonly Row[],
): Promise<void> {
  await tx.execute(sql`DELETE FROM ${sql.raw(table)}`);
  await insertRows(tx, table, columns, recordset, data);
}

async function insertRows(
  tx: ProjectionTx,
  table: string,
  columns: string,
  recordset: string,
  data: readonly Row[],
): Promise<void> {
  for (let i = 0; i < data.length; i += CHUNK) {
    const chunk = JSON.stringify(data.slice(i, i + CHUNK));
    await tx.execute(sql`
      INSERT INTO ${sql.raw(table)} (${sql.raw(columns)})
      SELECT ${sql.raw(columns)} FROM jsonb_to_recordset((${chunk}::text)::jsonb) AS x(${sql.raw(recordset)})
    `);
  }
}

async function markPublished(tx: ProjectionTx, section: ProjectionSection): Promise<void> {
  await tx.execute(sql`
    INSERT INTO published_projection_sections (section, published_at) VALUES (${section}, now())
    ON CONFLICT (section) DO UPDATE SET published_at = now()
  `);
  await tx.execute(sql`SELECT pg_notify(${GATEWAY_PROJECTION_CHANNEL}, ${section})`);
}

// ---------------------------------------------------------------------------
// Reading each section from cms_admin (the declared projection).
// ---------------------------------------------------------------------------

interface ActivePlugin {
  readonly id: string;
  readonly slug: string;
}

interface Snapshot {
  settings?: Row[];
  staging?: Row[];
  rateLimits?: Row[];
  plugins?: { rows: Row[]; grants: Row[]; active: ActivePlugin[] };
  pluginRows: Map<string, { slug: string; rows: Row[] }>;
  /** Active plugins that declare no projection (any more): nothing of theirs may stay published. */
  withdrawnPlugins: string[];
  pendingPlugins: string[];
  /** Full comment resync. */
  allComments?: Row[];
  /** Per-entity comment changes: archive id → approved row, or null to remove. */
  commentChanges: Map<string, Row | null>;
}

const COMMENT_COLUMNS =
  "id, public_row_id, page_id, parent_id, author_name, content, submitted_at, archived_at";

function commentQuery(where: SQL): SQL {
  return sql`
    SELECT id::text AS id, public_row_id::text AS public_row_id, page_id::text AS page_id,
           parent_id::text AS parent_id, author_name, content, submitted_at, archived_at
    FROM comment_archive WHERE status = 'approved' AND ${where}
  `;
}

async function readActivePlugins(tx: ProjectionTx): Promise<ActivePlugin[]> {
  return (await rows(
    tx,
    sql`SELECT id::text AS id, slug FROM plugins WHERE status = 'active' ORDER BY slug`,
  )) as unknown as ActivePlugin[];
}

/** Whether every declared table and column exists (the admin's boot evolves them). */
async function provisioned(
  tx: ProjectionTx,
  schema: string,
  projection: VisitorProjection,
): Promise<boolean> {
  for (const [table, columns] of Object.entries(projection)) {
    const found = (await rows(
      tx,
      sql`SELECT column_name::text AS c FROM information_schema.columns
          WHERE table_schema = ${schema} AND table_name = ${table}`,
    )) as unknown as { c: string }[];
    const have = new Set(found.map((r) => r.c));
    if (!["id", ...columns].every((c) => have.has(c))) return false;
  }
  return true;
}

async function readPluginRows(
  tx: ProjectionTx,
  plugin: ActivePlugin,
  projection: VisitorProjection,
): Promise<Row[] | null> {
  assertVisitorProjection(plugin.slug, projection);
  const schema = `plugin_${plugin.slug.replace(/-/g, "_")}`;
  if (!(await provisioned(tx, schema, projection))) return null;
  // The plugin's private tables are RLS-scoped to its id.
  await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${plugin.id}, true)`);
  const out: Row[] = [];
  for (const [table, columns] of Object.entries(projection)) {
    const found = await rows(
      tx,
      sql`SELECT t.id::text AS row_id, ${projectedRowJson(columns)} AS row
          FROM ${sql.raw(`"${schema}"."${table}"`)} t
          WHERE t."caelo_deleted_at" IS NULL AND t."caelo_chat_branch_id" IS NULL`,
    );
    for (const r of found) out.push({ plugin_id: plugin.id, table_name: table, ...r });
  }
  await tx.execute(sql`SELECT set_config('caelo.plugin_id', '', true)`);
  return out;
}

async function readSnapshot(
  tx: ProjectionTx,
  want: ReadonlySet<ProjectionSection>,
  declarations: VisitorProjectionDeclarations,
  fullComments: boolean,
  commentIds: ReadonlySet<string>,
): Promise<Snapshot> {
  const snap: Snapshot = {
    pluginRows: new Map(),
    withdrawnPlugins: [],
    pendingPlugins: [],
    commentChanges: new Map(),
  };
  if (want.has("settings")) {
    snap.settings = await rows(
      tx,
      sql`SELECT gateway_cookie_secret AS cookie_secret, gateway_max_body_bytes AS max_body_bytes,
                 captcha_provider, captcha_pow_target_prefix
          FROM site_settings WHERE id = 1 AND gateway_cookie_secret IS NOT NULL
            AND gateway_cookie_secret <> ''`,
    );
  }
  if (want.has("staging")) {
    snap.staging = await rows(
      tx,
      sql`SELECT staging_host, cookie_enabled, basic_auth_enabled, basic_auth_user,
                 basic_auth_nonce, header_enabled, header_name, header_nonce,
                 to_jsonb(ip_allowlist) AS ip_allowlist, origin_url
          FROM staging_access WHERE id = 1`,
    );
  }
  if (want.has("rate_limits")) {
    snap.rateLimits = await rows(
      tx,
      sql`SELECT o.plugin_slug, o.operation,
                 CASE WHEN p.name IS NOT NULL THEN p.per_visitor_max ELSE o.per_visitor_max END
                   AS per_visitor_max,
                 CASE WHEN p.name IS NOT NULL THEN p.window_seconds ELSE o.window_seconds END
                   AS window_seconds
          FROM plugin_rate_limit_overrides o
          LEFT JOIN rate_limit_profiles p ON p.name = o.profile_name`,
    );
  }
  const active = await readActivePlugins(tx);
  if (want.has("plugins")) {
    snap.plugins = {
      active,
      rows: await rows(
        tx,
        sql`SELECT p.id::text AS id, p.slug, p.tier, p.version, a.id::text AS actor_id,
                   CASE WHEN p.tier = 2 THEN p.manifest_json END AS manifest_json,
                   CASE WHEN p.tier = 2 THEN p.source_code END AS source_code
            FROM plugins p LEFT JOIN actors a ON a.plugin_id = p.id
            WHERE p.status = 'active'`,
      ),
      grants: await rows(
        tx,
        sql`SELECT g.id::text AS id, g.plugin_id::text AS plugin_id, g.artifact_digest,
                   g.capability
            FROM plugin_capability_grants g
            JOIN plugin_installation_versions v
              ON v.plugin_id = g.plugin_id AND v.artifact_digest = g.artifact_digest
            JOIN plugins p ON p.id = g.plugin_id
            WHERE g.revoked_at IS NULL AND v.status = 'active' AND p.status = 'active'`,
      ),
    };
  }
  for (const plugin of active) {
    const section: ProjectionSection = `plugin:${plugin.id}`;
    if (!want.has(section) && !want.has("plugins")) continue;
    // Not ours to judge: another publisher has this plugin (see
    // VisitorProjectionDeclarations).
    if (!declarations.has(plugin.slug)) continue;
    const projection = declarations.get(plugin.slug);
    if (!projection || Object.keys(projection).length === 0) {
      // A version that dropped its declaration: withdraw what an earlier
      // one published, so the public side keeps nothing undeclared.
      snap.withdrawnPlugins.push(plugin.id);
      continue;
    }
    const found = await readPluginRows(tx, plugin, projection);
    if (found === null) snap.pendingPlugins.push(plugin.slug);
    else snap.pluginRows.set(plugin.id, { slug: plugin.slug, rows: found });
  }
  if (fullComments) {
    snap.allComments = await rows(tx, commentQuery(sql`true`));
  } else if (commentIds.size > 0) {
    const ids = [...commentIds];
    const found = await rows(tx, commentQuery(sql`id = ANY(${uuidArray(ids)})`));
    const byId = new Map(found.map((r) => [String(r.id), r]));
    for (const id of ids) snap.commentChanges.set(id, byId.get(id) ?? null);
  }
  return snap;
}

// ---------------------------------------------------------------------------
// Writing the snapshot into cms_public.
// ---------------------------------------------------------------------------

async function writeSnapshot(
  tx: ProjectionTx,
  snap: Snapshot,
): Promise<{ sections: ProjectionSection[]; comments: number }> {
  const sections: ProjectionSection[] = [];
  if (snap.settings) {
    await replaceAll(
      tx,
      "published_gateway_settings",
      "cookie_secret, max_body_bytes, captcha_provider, captcha_pow_target_prefix",
      "cookie_secret text, max_body_bytes int, captcha_provider text, captcha_pow_target_prefix text",
      snap.settings,
    );
    sections.push("settings");
  }
  if (snap.staging) {
    await replaceAll(
      tx,
      "published_staging_access",
      "staging_host, cookie_enabled, basic_auth_enabled, basic_auth_user, basic_auth_nonce, header_enabled, header_name, header_nonce, ip_allowlist, origin_url",
      "staging_host text, cookie_enabled boolean, basic_auth_enabled boolean, basic_auth_user text, basic_auth_nonce text, header_enabled boolean, header_name text, header_nonce text, ip_allowlist jsonb, origin_url text",
      snap.staging,
    );
    sections.push("staging");
  }
  if (snap.rateLimits) {
    await replaceAll(
      tx,
      "published_rate_limits",
      "plugin_slug, operation, per_visitor_max, window_seconds",
      "plugin_slug text, operation text, per_visitor_max int, window_seconds int",
      snap.rateLimits,
    );
    sections.push("rate_limits");
  }
  if (snap.plugins) {
    await replaceAll(
      tx,
      "published_plugins",
      "id, slug, tier, version, actor_id, manifest_json, source_code",
      "id uuid, slug text, tier smallint, version text, actor_id uuid, manifest_json jsonb, source_code text",
      snap.plugins.rows,
    );
    await replaceAll(
      tx,
      "published_plugin_grants",
      "id, plugin_id, artifact_digest, capability",
      "id bigint, plugin_id uuid, artifact_digest text, capability text",
      snap.plugins.grants,
    );
    sections.push("plugins");
    // A plugin that is no longer active loses its projected rows and its
    // section, so the gateway cannot keep serving them.
    const activeIds = snap.plugins.active.map((p) => p.id);
    await tx.execute(
      activeIds.length === 0
        ? sql`DELETE FROM published_plugin_rows`
        : sql`DELETE FROM published_plugin_rows WHERE plugin_id <> ALL(${uuidArray(activeIds)})`,
    );
    await tx.execute(
      activeIds.length === 0
        ? sql`DELETE FROM published_projection_sections WHERE section LIKE 'plugin:%'`
        : sql`DELETE FROM published_projection_sections WHERE section LIKE 'plugin:%'
                AND section <> ALL(${textArray(activeIds.map((id) => `plugin:${id}`))})`,
    );
  }
  for (const pluginId of snap.withdrawnPlugins) {
    await tx.execute(sql`DELETE FROM published_plugin_rows WHERE plugin_id = ${pluginId}::uuid`);
    await tx.execute(
      sql`DELETE FROM published_projection_sections WHERE section = ${`plugin:${pluginId}`}`,
    );
  }
  for (const [pluginId, { rows: data }] of snap.pluginRows) {
    await tx.execute(sql`DELETE FROM published_plugin_rows WHERE plugin_id = ${pluginId}::uuid`);
    await insertRows(
      tx,
      "published_plugin_rows",
      "plugin_id, table_name, row_id, row",
      "plugin_id uuid, table_name text, row_id uuid, row jsonb",
      data,
    );
    sections.push(`plugin:${pluginId}`);
  }
  let comments = 0;
  if (snap.allComments) {
    await replaceAll(
      tx,
      "published_comments",
      COMMENT_COLUMNS,
      "id uuid, public_row_id uuid, page_id uuid, parent_id uuid, author_name text, content text, submitted_at timestamptz, archived_at timestamptz",
      snap.allComments,
    );
    sections.push("comments");
  } else if (snap.commentChanges.size > 0) {
    const ids = [...snap.commentChanges.keys()];
    await tx.execute(sql`DELETE FROM published_comments WHERE id = ANY(${uuidArray(ids)})`);
    const approved = [...snap.commentChanges.values()].filter((r): r is Row => r !== null);
    await insertRows(
      tx,
      "published_comments",
      COMMENT_COLUMNS,
      "id uuid, public_row_id uuid, page_id uuid, parent_id uuid, author_name text, content text, submitted_at timestamptz, archived_at timestamptz",
      approved,
    );
    comments = ids.length;
    sections.push("comments");
  }
  for (const s of sections) await markPublished(tx, s);
  return { sections, comments };
}

const SMALL_SECTIONS: readonly ProjectionSection[] = [
  "settings",
  "staging",
  "rate_limits",
  "plugins",
];

/**
 * Publish everything: the small sections, every declared plugin projection,
 * and — with `comments: true` — a full resync of the approved comments
 * (the migration job; the admin's boot drains comment changes instead).
 * Also consumes the outbox it covers.
 */
export async function publishPublicProjection(
  dbs: ProjectionDatabases,
  declarations: VisitorProjectionDeclarations,
  opts: { readonly comments: boolean },
): Promise<PublishReport> {
  return dbs.readAdmin(async (tx) => {
    await tx.execute(PROJECTION_LOCK);
    const outbox = await readOutbox(tx, await foreignPluginSections(tx, declarations));
    const commentIds = opts.comments ? new Set<string>() : outbox.commentIds;
    const snap = await readSnapshot(
      tx,
      new Set(SMALL_SECTIONS),
      declarations,
      opts.comments,
      commentIds,
    );
    let written = { sections: [] as ProjectionSection[], comments: 0 };
    await dbs.writePublic(async (ptx) => {
      written = await writeSnapshot(ptx, snap);
    });
    await consumeOutbox(tx, outbox.ids);
    return {
      sections: written.sections,
      comments: written.comments,
      drained: outbox.count,
      pendingPlugins: snap.pendingPlugins,
    };
  });
}

interface OutboxBatch {
  /** Exactly the outbox ids read (and only those are consumed). */
  readonly ids: readonly string[];
  readonly count: number;
  readonly sections: Set<ProjectionSection>;
  readonly commentIds: Set<string>;
}

const OUTBOX_BATCH = 5000;

/**
 * The sections of active plugins this publisher does not have (see
 * {@link VisitorProjectionDeclarations}). Their outbox rows are left for a
 * publisher that has the plugin: consuming one here would drop the change
 * it marks, since this publisher does not republish that section.
 */
async function foreignPluginSections(
  tx: ProjectionTx,
  declarations: VisitorProjectionDeclarations,
): Promise<ProjectionSection[]> {
  return (await readActivePlugins(tx))
    .filter((p) => !declarations.has(p.slug))
    .map((p) => `plugin:${p.id}` as const);
}

async function readOutbox(
  tx: ProjectionTx,
  foreign: readonly ProjectionSection[],
): Promise<OutboxBatch> {
  // Filtered in SQL, not after the LIMIT: rows left for another publisher
  // must never crowd this publisher's own rows out of the batch.
  const ours = foreign.length === 0 ? sql`true` : sql`section <> ALL(${textArray(foreign)})`;
  const found = (await rows(
    tx,
    sql`SELECT id::text AS id, section, entity_id::text AS entity_id
        FROM public_projection_outbox WHERE ${ours} ORDER BY id LIMIT ${OUTBOX_BATCH}`,
  )) as unknown as { id: string; section: string; entity_id: string | null }[];
  const sections = new Set<ProjectionSection>();
  const commentIds = new Set<string>();
  for (const r of found) {
    if (r.section === "comments") {
      if (r.entity_id && UUID_RE.test(r.entity_id)) commentIds.add(r.entity_id);
    } else {
      sections.add(r.section as ProjectionSection);
    }
  }
  return { ids: found.map((r) => r.id), count: found.length, sections, commentIds };
}

/**
 * Delete exactly the outbox rows this publish read — never a range. Ids
 * come from a sequence at INSERT time but become visible at COMMIT, so a
 * long transaction can commit a LOWER id while this publish runs; a range
 * delete (`id <= max`) would remove that row without its section ever
 * being republished. A row not read here stays for the next drain.
 *
 * Why reading then deleting by id is enough: an outbox row is written in
 * the same transaction as the source change, so once the row is visible
 * the change is committed, and the snapshot read that follows (later
 * statements, READ COMMITTED) sees it. A row that commits after the
 * outbox read is not deleted, so its section is published again later.
 */
async function consumeOutbox(tx: ProjectionTx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(
    sql`DELETE FROM public_projection_outbox
        WHERE id = ANY(string_to_array(${ids.join(",")}, ',')::bigint[])`,
  );
}

/**
 * Republish whatever the outbox says is stale, then consume those rows.
 * Cheap when the outbox is empty (one indexed read under the lock).
 */
export async function drainPublicProjection(
  dbs: ProjectionDatabases,
  declarations: VisitorProjectionDeclarations,
): Promise<PublishReport> {
  return dbs.readAdmin(async (tx) => {
    await tx.execute(PROJECTION_LOCK);
    const outbox = await readOutbox(tx, await foreignPluginSections(tx, declarations));
    if (outbox.count === 0) {
      return { sections: [], comments: 0, drained: 0, pendingPlugins: [] };
    }
    const snap = await readSnapshot(tx, outbox.sections, declarations, false, outbox.commentIds);
    let written = { sections: [] as ProjectionSection[], comments: 0 };
    await dbs.writePublic(async (ptx) => {
      written = await writeSnapshot(ptx, snap);
    });
    await consumeOutbox(tx, outbox.ids);
    return {
      sections: written.sections,
      comments: written.comments,
      drained: outbox.count,
      pendingPlugins: snap.pendingPlugins,
    };
  });
}
