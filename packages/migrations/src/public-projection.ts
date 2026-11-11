// SPDX-License-Identifier: MPL-2.0

/**
 * The published projection: what the admin publishes from cms_admin into
 * the public databases so a public API gateway never reads authoring state
 * (issue #635, CLAUDE.md §2 "the public side has no path to cms_admin").
 *
 * ## Two targets (#1329, epic #763 E10)
 *
 * The live gateway reads cms_public, the staging gateway its twin
 * cms_public_staging ({@link PublicTarget}). Every publish writes both, from
 * the same read of cms_admin, each with what belongs to its environment:
 *
 *   - **Immediate sections** — `settings` (each environment its own cookie
 *     secret, so staging never holds the live one), `staging` (the gate),
 *     `rate_limits`, `comments` (moderation and team posts) and, for the
 *     staging database only, `redirects`: the live rows and the shared
 *     draft's Staged changes (#1550), which the staging gateway serves
 *     itself against the staged build. Published from the current state.
 *   - **Release sections** — `plugins` (the registry with its grants) and
 *     each `plugin:<id>` (a plugin's visitorProjection rows). They follow
 *     the release: a Stage freezes them with its build ({@link freezeRelease},
 *     `projection_releases`, cms_admin 0531), each environment serves the
 *     frozen state its pointer names (`projection_release_pointers`), and
 *     only Publish live, an Owner's production build and a rollback move
 *     the live pointer ({@link pointRelease}; the writers are pinned in
 *     scripts/no-automatic-production-deploy.test.ts). The drain and the
 *     boot publish write the pointed state, never the current one, so a
 *     staged plugin change cannot reach live visitors before Publish live
 *     (#763 N6). What does reach both databases at once is narrowing
 *     ({@link narrowRelease}): a plugin deactivated or a grant revoked since
 *     the freeze leaves the published state on the next publish.
 *
 * The frozen state lives in cms_admin and is never read back from a public
 * database: the staging database is no more trusted than the live one.
 *
 * ## Direction and trust
 *
 * One way only: admin → public. Every publish recomputes a section from
 * cms_admin (or its frozen state there) and REPLACES it in the public
 * database. Nothing here reads the published tables back, so a compromised
 * public side that rewrites them can mislead only itself, never the admin.
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
 * sections named there and deletes the rows; the admin runs it right after
 * each of its own writes and as a backstop on every scheduler tick
 * (admin-core `createPublicProjectionPublisher`, #1140). A pointer move marks
 * `plugins` (0531). The migration job and the admin's boot publish
 * everything ({@link publishPublicProjection}), so an install converges even
 * when the outbox was written before the triggers that a newer release adds.
 * A `plugin:<id>` outbox row (the plugin's admin-side rows changed) is
 * consumed without a publish: its content reaches a public database with
 * the next frozen release.
 *
 * Publishers read one at a time under a cms_admin advisory lock, and the
 * lock ends with the read (#1594): each read takes a {@link Generation}
 * there, the public writes follow without any admin transaction open, and
 * every public database keeps the newest generation it got per write unit
 * (`published_projection_generations`, {@link claimUnit}), so an older read
 * can never overwrite a newer publish. Holding the lock across the public
 * writes used to keep an admin connection idle in its transaction for as
 * long as both public databases took; on 2026-11-11 Postgres ended it at
 * the 60 s idle-in-transaction timeout and a Stage failed with it. The
 * outbox rows a read covered are consumed after its writes, in a short
 * transaction of their own; a failed write consumes nothing.
 *
 * A publisher never WAITS on that lock while holding a connection: it asks
 * with `pg_try_advisory_xact_lock`, and when another publisher has it, it
 * ends its transaction and asks again after a short pause (see
 * {@link withProjectionLock}). Waiting inside the transaction used to hold
 * one admin connection per waiter for up to the 15 s `lock_timeout`
 * (migration 0392); every admin instance drains every 2 s and after every
 * write, so on 2026-11-02 the waiters took every pooled connection while
 * the holder itself waited for a cms_public connection, and the admin
 * stopped answering for ten minutes.
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
 * the migration job, which has no op registry. Freezing and pointing run
 * inside the deploy ops' own transactions, which are audited.
 */

import { type SQL, sql } from "drizzle-orm";

/** The query surface a publisher needs on each side (a drizzle transaction fits). */
export interface ProjectionTx {
  execute(query: SQL): Promise<unknown>;
}

/** A public database the projection is published to (#1329). */
export type PublicTarget = "live" | "staging";

/** Every public target, live first. */
export const PUBLIC_TARGETS: readonly PublicTarget[] = ["live", "staging"];

/**
 * How the publisher reaches the databases. Each callback runs its function
 * in ONE transaction as the `system` actor: `readAdmin` on cms_admin as
 * admin_role, `writePublic` on the target's public database (cms_public or
 * cms_public_staging) as admin_role.
 */
export interface ProjectionDatabases {
  readAdmin<T>(fn: (tx: ProjectionTx) => Promise<T>): Promise<T>;
  writePublic(target: PublicTarget, fn: (tx: ProjectionTx) => Promise<void>): Promise<void>;
  /**
   * #1330 / #1331 — the staging gate's key (`CAELO_STAGING_GATE_SECRET`, the
   * admin's), published into cms_public_staging only, for the staging
   * gateway. A process without it (the migration job) passes nothing: the
   * published key then stays as the last process that had it wrote it, and
   * is never cleared or read back.
   */
  readonly stagingGateSecret?: string | null;
}

/**
 * A plugin's declared visitor-readable projection of its private storage:
 * table → the columns visitor operations may read (`id` always included).
 */
export type VisitorProjection = Readonly<Record<string, ReadonlyArray<string>>>;

/**
 * What a freezing process knows of each plugin's projection, by slug:
 *
 *   - a projection: the plugin runs here (or ships in this image) and
 *     declares it;
 *   - `null`: the plugin runs here and declares none;
 *   - no entry: this process does not have the plugin. A release cannot be
 *     frozen here then ({@link freezeRelease} refuses): the frozen state
 *     would miss that plugin's rows.
 */
export type VisitorProjectionDeclarations = ReadonlyMap<string, VisitorProjection | null>;

/** A section of the projection, as the outbox and `published_projection_sections` name it. */
export type ProjectionSection =
  | "settings"
  | "staging"
  | "staging_site"
  | "rate_limits"
  | "plugins"
  | "comments"
  | "redirects"
  | `plugin:${string}`;

/** What one publish did, for logs and tests. */
export interface PublishReport {
  /** Sections published, per target. */
  readonly sections: Readonly<Record<PublicTarget, readonly ProjectionSection[]>>;
  /** Comments republished one by one (outbox entities), not counting a full resync. */
  readonly comments: number;
  /** Outbox rows consumed. */
  readonly drained: number;
  /**
   * #1594 — units this publish carried but left alone, per target, because
   * a publish of a later read had already written them.
   */
  readonly superseded: Readonly<Record<PublicTarget, readonly string[]>>;
  /**
   * Targets with no frozen release state yet (an install before #1329 whose
   * bootstrap could not run here): their release sections stay as published.
   */
  readonly unreleased: readonly PublicTarget[];
}

/** NOTIFY channel the gateways listen on (each public database); the payload names the section. */
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

const PROJECTION_TRY_LOCK = sql`SELECT pg_try_advisory_xact_lock(hashtext('caelo_public_projection')) AS locked`;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const SLUG_RE = /^[a-z][a-z0-9-]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Rows per INSERT into a public database. */
const CHUNK = 500;

type Row = Record<string, unknown>;

/**
 * The origins the live site is served on, which alone may post to the
 * gateway's `/api/plugin/*` (#1326): the site's base URL and every public
 * domain of the domains registry, each as a browser sends it in `Origin`
 * (`https://example.com`, no path, default port dropped). The staging host
 * is never one of them, even when it is registered as a domain: it is
 * same-site with live, and unreviewed module JS on staging must not post
 * to the live data (#763 N4). An entry that is not a URL is left out; the
 * admin reports a malformed base URL on every build.
 *
 * @example
 *   liveSiteOrigins({ baseUrl: "https://Example.com/", publicHosts: ["www.example.com"],
 *                     stagingHost: "staging.example.com" })
 *   // → ["https://example.com", "https://www.example.com"]
 */
export function liveSiteOrigins(input: {
  readonly baseUrl: string | null | undefined;
  readonly publicHosts: readonly string[];
  readonly stagingHost: string | null | undefined;
}): string[] {
  const originOf = (url: string): string | null => {
    try {
      const u = new URL(url);
      return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
    } catch {
      return null;
    }
  };
  const staging = input.stagingHost ? originOf(`https://${input.stagingHost}`) : null;
  const found = [
    input.baseUrl ? originOf(input.baseUrl) : null,
    ...input.publicHosts.map((h) => originOf(`https://${h}`)),
  ].filter((o): o is string => o !== null && o !== staging);
  return [...new Set(found)].sort();
}

/**
 * #1330 — the origins the staging gateway takes plugin posts from: the
 * staging host only (the published `live_origins` of cms_public_staging).
 * Empty while no staging host is set, so every post is refused.
 */
export function stagingSiteOrigins(stagingHost: string | null | undefined): string[] {
  if (!stagingHost) return [];
  try {
    return [new URL(`https://${stagingHost}`).origin];
  } catch {
    return [];
  }
}

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

/** Replace a whole table's contents in a public database with `data`. */
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

/**
 * Mark `section` published. `published_at` is when the publisher READ the
 * state it wrote (its {@link Generation}), not when it wrote it: that is
 * what {@link claimUnit} compares, and what a publisher of the previous
 * release (which stamps `now()` at its write, after its read) still
 * compares correctly against during a roll. The gateway reads only that a
 * row exists and its `xmin`.
 */
async function markPublished(
  tx: ProjectionTx,
  section: ProjectionSection,
  gen: Generation,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO published_projection_sections (section, published_at)
    VALUES (${section}, ${gen.readAt}::timestamptz)
    ON CONFLICT (section) DO UPDATE SET published_at = EXCLUDED.published_at
  `);
  await tx.execute(sql`SELECT pg_notify(${GATEWAY_PROJECTION_CHANNEL}, ${section})`);
}

/**
 * #1594 — which read of cms_admin a publish writes. Taken under the
 * projection lock as the read transaction's first statement: the lock
 * makes reads one at a time, so a later read always has a larger
 * `generation` (its transaction id, assigned after the earlier read's
 * transaction ended) and a later `readAt`.
 */
export interface Generation {
  /** The read transaction's id (`pg_current_xact_id`), as decimal text. */
  readonly generation: string;
  /** The database clock at the read. */
  readonly readAt: string;
}

/** Take the {@link Generation} of the read `tx` runs (under the projection lock). */
async function readGeneration(tx: ProjectionTx): Promise<Generation> {
  const [row] = (await rows(
    tx,
    sql`SELECT pg_current_xact_id()::text AS generation, clock_timestamp()::text AS read_at`,
  )) as unknown as { generation: string; read_at: string }[];
  if (!row) throw new Error("pg_current_xact_id() returned no row");
  return { generation: row.generation, readAt: row.read_at };
}

/**
 * The units a public database is written in, one claim each (#1594). A
 * unit's tables are replaced together; `plugins` is the whole release
 * (registry, grants, rows and every `plugin:<id>` mark). Claimed in this
 * order, so two publishers writing the same database never wait on each
 * other in a cycle.
 */
type ProjectionUnit =
  | "settings"
  | "staging"
  | "staging_site"
  | "rate_limits"
  | "redirects"
  | "plugins"
  | "comments";

/**
 * #1594 — may this publish write `unit` in this public database? It may
 * when nothing newer was written there: no publisher with a later read
 * (`published_projection_generations`, raised only, never deleted — so a
 * section that was removed cannot come back from an older read), and no
 * publisher of the previous release that wrote after this read (its
 * `published_at` is its write time; during a roll it does not claim).
 *
 * The claim's row lock is held until this transaction commits, so a
 * concurrent publisher of the same unit waits for it and then sees the
 * newer generation. This replaces holding the cms_admin projection lock
 * across the public writes, which kept an admin connection idle in its
 * transaction for as long as both public databases took (#1594: ended by
 * Postgres' idle-in-transaction timeout during a stall).
 */
async function claimUnit(
  tx: ProjectionTx,
  unit: ProjectionUnit,
  gen: Generation,
): Promise<boolean> {
  const claimed = await rows(
    tx,
    sql`
      INSERT INTO published_projection_generations (unit, generation)
      VALUES (${unit}, ${gen.generation}::bigint)
      ON CONFLICT (unit) DO UPDATE SET generation = EXCLUDED.generation
        WHERE published_projection_generations.generation < EXCLUDED.generation
      RETURNING unit
    `,
  );
  if (claimed.length === 0) return false;
  const newer = await rows(
    tx,
    sql`
      SELECT 1 AS newer FROM published_projection_sections
      WHERE section = ${unit} AND published_at > ${gen.readAt}::timestamptz
    `,
  );
  return newer.length === 0;
}

// ---------------------------------------------------------------------------
// The release state: frozen per Stage, narrowed on every publish.
// ---------------------------------------------------------------------------

/**
 * The release sections as {@link freezeRelease} stores them: exactly the
 * rows the public tables get, so a publish is a copy, never a re-read of
 * the main line.
 */
export interface ReleaseState {
  readonly version: 1;
  /** `published_plugins` rows: the active plugins at the freeze. */
  readonly plugins: readonly Row[];
  /** `published_plugin_grants` rows of the active artifacts. */
  readonly grants: readonly Row[];
  /** `published_plugin_rows` rows of every plugin that declares a projection. */
  readonly pluginRows: readonly Row[];
  /** The plugins whose `plugin:<id>` section the state publishes. */
  readonly projected: readonly string[];
}

const releaseState = {
  parse(value: unknown): ReleaseState {
    const v = value as Partial<ReleaseState> | null;
    if (
      v === null ||
      typeof v !== "object" ||
      v.version !== 1 ||
      !Array.isArray(v.plugins) ||
      !Array.isArray(v.grants) ||
      !Array.isArray(v.pluginRows) ||
      !Array.isArray(v.projected)
    ) {
      throw new Error("projection_releases.state has an unknown shape (expected version 1)");
    }
    return v as ReleaseState;
  },
};

interface ActivePlugin {
  readonly id: string;
  readonly slug: string;
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

/** Why the current main line cannot be frozen in this process. */
export class ReleaseFreezeError extends Error {
  override readonly name = "ReleaseFreezeError";
}

/**
 * How {@link freezeRelease} treats an active plugin it cannot read the rows
 * of (not loaded in this process, or its declared tables not provisioned):
 *
 *   - `required` refuses (ReleaseFreezeError) — the bootstrap, whose state
 *     goes straight to live;
 *   - `as-loaded` leaves that plugin's rows out — a Stage or a production
 *     build, which record the plugin as not running (#1008) and which
 *     Publish live therefore refuses; staging shows the plugin as not
 *     published, which is what its build shows too.
 */
export type FreezeCompleteness = "required" | "as-loaded";

/** The release sections of the current main line, read in `tx`. */
async function readCurrentRelease(
  tx: ProjectionTx,
  declarations: VisitorProjectionDeclarations,
  completeness: FreezeCompleteness,
): Promise<ReleaseState> {
  const active = await readActivePlugins(tx);
  const plugins = await rows(
    tx,
    // #1267 — a release-signed plugin's approved capability set goes with
    // it: the gateway refuses to attach one that asks for more
    // (gateway-attach.ts), as the admin host does (loader.ts).
    sql`SELECT p.id::text AS id, p.slug, p.tier, p.version, a.id::text AS actor_id,
               CASE WHEN p.tier = 2 THEN p.manifest_json END AS manifest_json,
               CASE WHEN p.tier = 2 THEN p.source_code END AS source_code,
               CASE WHEN p.tier = 1 THEN to_jsonb(p.approved_capabilities) END
                 AS approved_capabilities,
               CASE WHEN p.tier = 1 THEN p.approved_manifest_digest END
                 AS approved_manifest_digest
        FROM plugins p LEFT JOIN actors a ON a.plugin_id = p.id
        WHERE p.status = 'active'
        ORDER BY p.slug`,
  );
  const grants = await rows(
    tx,
    sql`SELECT g.id::text AS id, g.plugin_id::text AS plugin_id, g.artifact_digest,
               g.capability
        FROM plugin_capability_grants g
        JOIN plugin_installation_versions v
          ON v.plugin_id = g.plugin_id AND v.artifact_digest = g.artifact_digest
        JOIN plugins p ON p.id = g.plugin_id
        WHERE g.revoked_at IS NULL AND v.status = 'active' AND p.status = 'active'
        ORDER BY g.id`,
  );
  const pluginRows: Row[] = [];
  const projected: string[] = [];
  for (const plugin of active) {
    if (!declarations.has(plugin.slug)) {
      if (completeness === "as-loaded") continue;
      throw new ReleaseFreezeError(
        `plugin "${plugin.slug}" is active but not loaded in this admin instance, so its published rows cannot be frozen; load it (Settings → Plugins shows why it is not running)`,
      );
    }
    const projection = declarations.get(plugin.slug);
    if (!projection || Object.keys(projection).length === 0) continue;
    const found = await readPluginRows(tx, plugin, projection);
    if (found === null) {
      if (completeness === "as-loaded") continue;
      throw new ReleaseFreezeError(
        `plugin "${plugin.slug}" declares tables that are not provisioned yet, so its published rows cannot be frozen; reload it`,
      );
    }
    pluginRows.push(...found);
    projected.push(plugin.id);
  }
  return { version: 1, plugins, grants, pluginRows, projected };
}

/** Why a frozen release state was taken. */
export type ReleaseReason = "stage" | "production-build" | "bootstrap";

/**
 * Freeze the release sections of the current main line under `runId`, in
 * the caller's cms_admin transaction (deploy.start_trigger for a Stage or
 * an Owner's production build; the bootstrap). Nothing is published: the
 * state reaches a public database when a pointer names it.
 *
 * @throws ReleaseFreezeError when `completeness` is `required` and an
 *   active plugin's rows cannot be read here.
 */
export async function freezeRelease(
  tx: ProjectionTx,
  input: {
    readonly runId: string;
    readonly reason: ReleaseReason;
    readonly declarations: VisitorProjectionDeclarations;
    readonly completeness: FreezeCompleteness;
  },
): Promise<void> {
  if (!UUID_RE.test(input.runId)) throw new Error(`freezeRelease: run id ${input.runId}`);
  const state = await readCurrentRelease(tx, input.declarations, input.completeness);
  await tx.execute(sql`
    INSERT INTO projection_releases (run_id, reason, state)
    VALUES (${input.runId}::uuid, ${input.reason}, (${JSON.stringify(state)}::text)::jsonb)
    ON CONFLICT (run_id) DO NOTHING
  `);
}

/**
 * Point the staging database at the state `runId` froze — a Stage's
 * finish. The pointer move marks the release sections stale (0531), so
 * the drain after the commit publishes them to cms_public_staging.
 *
 * @throws when `runId` froze nothing.
 */
export async function pointStagingRelease(tx: ProjectionTx, runId: string): Promise<void> {
  await pointRelease(tx, "staging", runId);
}

/**
 * Point the LIVE database at the state `runId` froze. Only a human's
 * release may call it — Publish live, an Owner's production build and a
 * rollback (scripts/no-automatic-production-deploy.test.ts pins the
 * callers); nothing else moves what live visitors are served.
 *
 * @throws when `runId` froze nothing.
 */
export async function pointLiveRelease(tx: ProjectionTx, runId: string): Promise<void> {
  await pointRelease(tx, "live", runId);
}

/** Whether `runId` froze a release state. */
export async function hasFrozenRelease(tx: ProjectionTx, runId: string): Promise<boolean> {
  const found = await rows(
    tx,
    sql`SELECT 1 AS ok FROM projection_releases WHERE run_id = ${runId}::uuid`,
  );
  return found.length > 0;
}

async function pointRelease(tx: ProjectionTx, env: PublicTarget, runId: string): Promise<void> {
  if (!(await hasFrozenRelease(tx, runId))) {
    throw new Error(`run ${runId} froze no projection release state`);
  }
  await tx.execute(sql`
    INSERT INTO projection_release_pointers (environment, run_id, pointed_at)
    VALUES (${env}, ${runId}::uuid, now())
    ON CONFLICT (environment) DO UPDATE SET run_id = EXCLUDED.run_id, pointed_at = now()
  `);
}

/** The state each environment's pointer names, or null for one without a pointer. */
async function readPointedReleases(
  tx: ProjectionTx,
): Promise<Record<PublicTarget, ReleaseState | null>> {
  const found = (await rows(
    tx,
    sql`SELECT p.environment, r.state FROM projection_release_pointers p
        JOIN projection_releases r ON r.run_id = p.run_id`,
  )) as unknown as { environment: PublicTarget; state: unknown }[];
  const out: Record<PublicTarget, ReleaseState | null> = { live: null, staging: null };
  for (const r of found) out[r.environment] = releaseState.parse(r.state);
  return out;
}

/** What the main line says now, for narrowing a frozen state. */
interface CurrentNarrowing {
  readonly activePluginIds: ReadonlySet<string>;
  readonly liveGrantIds: ReadonlySet<string>;
  /** A release-signed plugin's approved capability set now (null: not tier 1). */
  readonly approvedCapabilities: ReadonlyMap<string, readonly string[] | null>;
}

async function readNarrowing(tx: ProjectionTx): Promise<CurrentNarrowing> {
  const active = (await rows(
    tx,
    sql`SELECT id::text AS id,
               CASE WHEN tier = 1 THEN to_jsonb(approved_capabilities) END AS approved_capabilities
        FROM plugins WHERE status = 'active'`,
  )) as unknown as { id: string; approved_capabilities: string[] | null }[];
  const grants = (await rows(
    tx,
    sql`SELECT id::text AS id FROM plugin_capability_grants WHERE revoked_at IS NULL`,
  )) as unknown as { id: string }[];
  return {
    activePluginIds: new Set(active.map((p) => p.id)),
    liveGrantIds: new Set(grants.map((g) => g.id)),
    approvedCapabilities: new Map(active.map((p) => [p.id, p.approved_capabilities])),
  };
}

/** A frozen plugin row with its approved capabilities cut down to what is approved now. */
function narrowApproval(row: Row, now: CurrentNarrowing): Row {
  const frozen = row.approved_capabilities;
  if (!Array.isArray(frozen)) return row;
  const current = now.approvedCapabilities.get(String(row.id));
  const allowed = new Set(Array.isArray(current) ? current : []);
  return { ...row, approved_capabilities: frozen.filter((c) => allowed.has(String(c))) };
}

/**
 * A frozen release state as it may be published now: only what the main
 * line still allows. A plugin deactivated (or uninstalled) since the
 * freeze, with its grants and rows, every grant revoked since, and every
 * capability a release-signed plugin's approval no longer holds are left
 * out. Nothing is added: an activation, an upgrade, a widened approval or
 * new plugin content follows the next release.
 *
 * @example
 *   narrowRelease(frozen, {
 *     activePluginIds: new Set(), liveGrantIds: new Set(), approvedCapabilities: new Map(),
 *   })
 *   // → no plugin, grant or row published
 */
export function narrowRelease(state: ReleaseState, now: CurrentNarrowing): ReleaseState {
  const active = (pluginId: unknown) => now.activePluginIds.has(String(pluginId));
  return {
    version: 1,
    plugins: state.plugins.filter((p) => active(p.id)).map((p) => narrowApproval(p, now)),
    grants: state.grants.filter((g) => active(g.plugin_id) && now.liveGrantIds.has(String(g.id))),
    pluginRows: state.pluginRows.filter((r) => active(r.plugin_id)),
    projected: state.projected.filter((id) => active(id)),
  };
}

// ---------------------------------------------------------------------------
// Reading the immediate sections from cms_admin (the declared projection).
// ---------------------------------------------------------------------------

/** The settings row of each environment. */
type SettingsRows = Record<PublicTarget, Row[]>;

interface Snapshot {
  settings?: SettingsRows;
  staging?: Row[];
  /** #1330 — the staging gateway's row: the gate and the served build (staging database only). */
  stagingSite?: Row[];
  rateLimits?: Row[];
  redirects?: Row[];
  /** #1550 — the shared draft's Staged redirect changes (staging database only). */
  redirectChanges?: Row[];
  /** Each target's release state to publish, narrowed; absent: not wanted. */
  releases?: Record<PublicTarget, ReleaseState | null>;
  /** Full comment resync. */
  allComments?: Row[];
  /** Per-entity comment changes: archive id → approved row, or null to remove. */
  commentChanges: Map<string, Row | null>;
}

const COMMENT_COLUMNS =
  "id, public_row_id, page_id, parent_id, author_name, content, submitted_at, archived_at";

/**
 * The timestamps travel as text: the rows are written through JSON, a driver
 * `Date` would cut them to milliseconds, and the thread's cursor (#1169) has
 * to find the same microsecond on both sides.
 */
function commentQuery(where: SQL): SQL {
  return sql`
    SELECT id::text AS id, public_row_id::text AS public_row_id, page_id::text AS page_id,
           parent_id::text AS parent_id, author_name, content,
           submitted_at::text AS submitted_at, archived_at::text AS archived_at
    FROM comment_archive WHERE status = 'approved' AND ${where}
  `;
}

async function readSettings(tx: ProjectionTx): Promise<SettingsRows> {
  const found = (await rows(
    tx,
    sql`SELECT gateway_cookie_secret, gateway_staging_cookie_secret,
               gateway_max_body_bytes AS max_body_bytes, captcha_provider,
               captcha_pow_target_prefix, mail_link_key, mail_link_staging_key
        FROM site_settings WHERE id = 1`,
  )) as unknown as {
    gateway_cookie_secret: string | null;
    gateway_staging_cookie_secret: string | null;
    max_body_bytes: number;
    captcha_provider: string;
    captcha_pow_target_prefix: string;
    mail_link_key: string | null;
    mail_link_staging_key: string | null;
  }[];
  const stagingHost = (
    (await rows(tx, sql`SELECT staging_host FROM staging_access WHERE id = 1`))[0] as
      | { staging_host: string | null }
      | undefined
  )?.staging_host;
  const origins = liveSiteOrigins({
    baseUrl: (
      (await rows(tx, sql`SELECT site_base_url FROM site_defaults WHERE id = 1`))[0] as
        | { site_base_url: string | null }
        | undefined
    )?.site_base_url,
    publicHosts: (
      (await rows(tx, sql`SELECT hostname FROM domains WHERE kind = 'public'`)) as {
        hostname: string;
      }[]
    ).map((d) => d.hostname),
    stagingHost,
  });
  const row = found[0];
  // A secret not set up yet leaves the section unpublished (the gateway
  // answers ProjectionNotPublished), never a shared or empty one.
  const of = (
    secret: string | null | undefined,
    allowed: readonly string[],
    mailLinkKey: string | null | undefined,
  ): Row[] =>
    row && secret
      ? [
          {
            cookie_secret: secret,
            max_body_bytes: row.max_body_bytes,
            captcha_provider: row.captcha_provider,
            captcha_pow_target_prefix: row.captcha_pow_target_prefix,
            live_origins: allowed,
            mail_link_key: mailLinkKey ?? null,
          },
        ]
      : [];
  return {
    live: of(row?.gateway_cookie_secret, origins, row?.mail_link_key),
    // #1330 — the staging gateway takes plugin posts only from the staging
    // site's own pages; a live page must never write into staging data.
    staging: of(
      row?.gateway_staging_cookie_secret,
      stagingSiteOrigins(stagingHost),
      row?.mail_link_staging_key,
    ),
  };
}

async function readSnapshot(
  tx: ProjectionTx,
  want: ReadonlySet<ProjectionSection>,
  fullComments: boolean,
  commentIds: ReadonlySet<string>,
): Promise<Snapshot> {
  const snap: Snapshot = { commentChanges: new Map() };
  if (want.has("settings")) snap.settings = await readSettings(tx);
  if (want.has("staging")) {
    snap.staging = await rows(
      tx,
      sql`SELECT staging_host, cookie_enabled, basic_auth_enabled, basic_auth_user,
                 basic_auth_nonce, header_enabled, header_name, header_nonce,
                 to_jsonb(ip_allowlist) AS ip_allowlist, origin_url
          FROM staging_access WHERE id = 1`,
    );
    // #1330 — the served build is published only once its slot is complete
    // (`served_location` is set by the Stage that filled it), with the origin
    // its run rendered (the live site's), which the gateway rewrites.
    snap.stagingSite = await rows(
      tx,
      sql`SELECT s.staging_host, s.cookie_enabled, s.basic_auth_enabled, s.basic_auth_user,
                 s.basic_auth_nonce, s.header_enabled, s.header_name, s.header_nonce,
                 to_jsonb(s.ip_allowlist) AS ip_allowlist,
                 CASE WHEN s.served_location IS NULL THEN NULL ELSE s.origin_run_id::text END
                   AS served_run_id,
                 s.served_location,
                 CASE WHEN s.served_location IS NULL THEN NULL
                      ELSE substring(r.site_url FROM '^(https?://[^/[:space:]]+)') END AS build_origin
          FROM staging_access s LEFT JOIN deploy_runs r ON r.id = s.origin_run_id
          WHERE s.id = 1`,
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
  if (want.has("redirects")) {
    // #1550 — the staging view: the live rows with the Staged changes of the
    // shared draft (main and the site draft; an isolated branch's changes
    // join at its Stage merge; Draft changes are served nowhere). Read in ONE
    // statement: under READ COMMITTED a second read could already see a
    // release the first did not, and publish a pairing the admin never held
    // (a loop staging would answer with an error until the next projection).
    const both = await rows(
      tx,
      sql`SELECT 'live' AS kind, id::text AS id, NULL::text AS address, from_path, to_path,
                 status_code, NULL::boolean AS automatic, from_path AS sort_key
          FROM redirects
          UNION ALL
          SELECT 'staged', id::text, address, from_path, to_path, status_code,
                 origin <> 'manual', address
          FROM pending_redirects
          WHERE state = 'staged'
            AND (chat_branch_id IS NULL
                 OR chat_branch_id = (SELECT branch_id FROM site_draft WHERE id = 1))
          ORDER BY kind, sort_key`,
    );
    snap.redirects = both
      .filter((r) => r.kind === "live")
      .map(({ id, from_path, to_path, status_code }) => ({ id, from_path, to_path, status_code }));
    snap.redirectChanges = both
      .filter((r) => r.kind === "staged")
      .map(({ id, address, from_path, to_path, status_code, automatic }) => ({
        id,
        address,
        from_path,
        to_path,
        status_code,
        automatic,
      }));
  }
  if (want.has("plugins")) {
    const pointed = await readPointedReleases(tx);
    const now = await readNarrowing(tx);
    snap.releases = {
      live: pointed.live && narrowRelease(pointed.live, now),
      staging: pointed.staging && narrowRelease(pointed.staging, now),
    };
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
// Writing a snapshot into one public database.
// ---------------------------------------------------------------------------

const COMMENT_RECORDSET =
  "id uuid, public_row_id uuid, page_id uuid, parent_id uuid, author_name text, content text, submitted_at timestamptz, archived_at timestamptz";

async function writeRelease(tx: ProjectionTx, release: ReleaseState): Promise<ProjectionSection[]> {
  await replaceAll(
    tx,
    "published_plugins",
    "id, slug, tier, version, actor_id, manifest_json, source_code, approved_capabilities, approved_manifest_digest",
    "id uuid, slug text, tier smallint, version text, actor_id uuid, manifest_json jsonb, source_code text, approved_capabilities text[], approved_manifest_digest text",
    release.plugins,
  );
  await replaceAll(
    tx,
    "published_plugin_grants",
    "id, plugin_id, artifact_digest, capability",
    "id bigint, plugin_id uuid, artifact_digest text, capability text",
    release.grants,
  );
  await replaceAll(
    tx,
    "published_plugin_rows",
    "plugin_id, table_name, row_id, row",
    "plugin_id uuid, table_name text, row_id uuid, row jsonb",
    release.pluginRows,
  );
  // A plugin the release no longer publishes loses its section, so the
  // gateway cannot keep serving it.
  await tx.execute(
    release.projected.length === 0
      ? sql`DELETE FROM published_projection_sections WHERE section LIKE 'plugin:%'`
      : sql`DELETE FROM published_projection_sections WHERE section LIKE 'plugin:%'
              AND section <> ALL(${textArray(release.projected.map((id) => `plugin:${id}`))})`,
  );
  return ["plugins", ...release.projected.map((id) => `plugin:${id}` as const)];
}

const STAGING_SITE_COLUMNS =
  "staging_host, cookie_enabled, basic_auth_enabled, basic_auth_user, basic_auth_nonce, header_enabled, header_name, header_nonce, ip_allowlist, served_run_id, served_location, build_origin";
const STAGING_SITE_RECORDSET =
  "staging_host text, cookie_enabled boolean, basic_auth_enabled boolean, basic_auth_user text, basic_auth_nonce text, header_enabled boolean, header_name text, header_nonce text, ip_allowlist jsonb, served_run_id uuid, served_location text, build_origin text";

/**
 * #1330 — write the staging gateway's row. An upsert, not a replace: a
 * publisher that does not hold the gate key (the migration job) leaves the
 * published key as it is instead of clearing it, without reading it back.
 */
async function writeStagingSite(
  tx: ProjectionTx,
  data: readonly Row[],
  gateSecret: string | null,
): Promise<void> {
  const row = data[0];
  if (!row) {
    await tx.execute(sql`DELETE FROM published_staging_site`);
    return;
  }
  const updates = STAGING_SITE_COLUMNS.split(", ")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");
  const json = JSON.stringify([{ ...row, gate_secret: gateSecret }]);
  await tx.execute(sql`
    INSERT INTO published_staging_site (id, ${sql.raw(STAGING_SITE_COLUMNS)}, gate_secret)
    SELECT 1, ${sql.raw(STAGING_SITE_COLUMNS)}, gate_secret
    FROM jsonb_to_recordset((${json}::text)::jsonb) AS x(${sql.raw(STAGING_SITE_RECORDSET)}, gate_secret text)
    ON CONFLICT (id) DO UPDATE SET ${sql.raw(updates)},
      gate_secret = COALESCE(EXCLUDED.gate_secret, published_staging_site.gate_secret)
  `);
}

async function writeSnapshot(
  tx: ProjectionTx,
  target: PublicTarget,
  snap: Snapshot,
  gateSecret: string | null,
  gen: Generation,
): Promise<{ sections: ProjectionSection[]; comments: number; skipped: ProjectionUnit[] }> {
  const sections: ProjectionSection[] = [];
  const skipped: ProjectionUnit[] = [];
  /** Claim `unit` when the snapshot carries it (see {@link claimUnit}). */
  const may = async (unit: ProjectionUnit, carried: boolean): Promise<boolean> => {
    if (!carried) return false;
    if (await claimUnit(tx, unit, gen)) return true;
    skipped.push(unit);
    return false;
  };
  const settings = snap.settings?.[target];
  if (!(await may("settings", settings !== undefined))) {
    // Not carried, or a newer publish wrote it.
  } else if (settings && settings.length > 0) {
    await replaceAll(
      tx,
      "published_gateway_settings",
      "cookie_secret, max_body_bytes, captcha_provider, captcha_pow_target_prefix, live_origins, mail_link_key",
      "cookie_secret text, max_body_bytes int, captcha_provider text, captcha_pow_target_prefix text, live_origins text[], mail_link_key text",
      settings,
    );
    sections.push("settings");
  } else if (settings) {
    // The secret is gone: the old row must not keep the gateway accepting
    // cookies signed with it, so the section becomes unpublished again.
    await tx.execute(sql`DELETE FROM published_gateway_settings`);
    await tx.execute(sql`DELETE FROM published_projection_sections WHERE section = 'settings'`);
  }
  if (await may("staging", snap.staging !== undefined)) {
    await replaceAll(
      tx,
      "published_staging_access",
      "staging_host, cookie_enabled, basic_auth_enabled, basic_auth_user, basic_auth_nonce, header_enabled, header_name, header_nonce, ip_allowlist, origin_url",
      "staging_host text, cookie_enabled boolean, basic_auth_enabled boolean, basic_auth_user text, basic_auth_nonce text, header_enabled boolean, header_name text, header_nonce text, ip_allowlist jsonb, origin_url text",
      snap.staging ?? [],
    );
    sections.push("staging");
  }
  if (snap.stagingSite && (await may("staging_site", target === "staging"))) {
    await writeStagingSite(tx, snap.stagingSite, gateSecret);
    sections.push("staging_site");
  }
  if (snap.rateLimits && (await may("rate_limits", true))) {
    await replaceAll(
      tx,
      "published_rate_limits",
      "plugin_slug, operation, per_visitor_max, window_seconds",
      "plugin_slug text, operation text, per_visitor_max int, window_seconds int",
      snap.rateLimits,
    );
    sections.push("rate_limits");
  }
  // #1157 — the live site gets its redirects from the hosting provider;
  // the staging gateway serves them itself, from here: the live rows and
  // (#1550) the Staged changes it applies against the staged build.
  if (snap.redirects && (await may("redirects", target === "staging"))) {
    await replaceAll(
      tx,
      "published_redirects",
      "id, from_path, to_path, status_code",
      "id uuid, from_path text, to_path text, status_code int",
      snap.redirects,
    );
    await replaceAll(
      tx,
      "published_redirect_changes",
      "id, address, from_path, to_path, status_code, automatic",
      "id uuid, address text, from_path text, to_path text, status_code int, automatic boolean",
      snap.redirectChanges ?? [],
    );
    sections.push("redirects");
  }
  const release = snap.releases?.[target];
  if (release && (await may("plugins", true))) sections.push(...(await writeRelease(tx, release)));
  let comments = 0;
  const carriesComments = snap.allComments !== undefined || snap.commentChanges.size > 0;
  if (!(await may("comments", carriesComments))) {
    // Not carried, or a newer publish wrote it.
  } else if (snap.allComments) {
    await replaceAll(
      tx,
      "published_comments",
      COMMENT_COLUMNS,
      COMMENT_RECORDSET,
      snap.allComments,
    );
    sections.push("comments");
  } else if (snap.commentChanges.size > 0) {
    const ids = [...snap.commentChanges.keys()];
    await tx.execute(sql`DELETE FROM published_comments WHERE id = ANY(${uuidArray(ids)})`);
    const approved = [...snap.commentChanges.values()].filter((r): r is Row => r !== null);
    await insertRows(tx, "published_comments", COMMENT_COLUMNS, COMMENT_RECORDSET, approved);
    comments = ids.length;
    sections.push("comments");
  }
  for (const s of sections) await markPublished(tx, s, gen);
  return { sections, comments, skipped };
}

/** Write `snap` to every public database and collect what was published. */
async function writeAll(
  dbs: ProjectionDatabases,
  snap: Snapshot,
  gen: Generation,
): Promise<{
  sections: PublishReport["sections"];
  comments: number;
  superseded: PublishReport["superseded"];
}> {
  const sections: Record<PublicTarget, ProjectionSection[]> = { live: [], staging: [] };
  const superseded: Record<PublicTarget, string[]> = { live: [], staging: [] };
  let comments = 0;
  for (const target of PUBLIC_TARGETS) {
    await dbs.writePublic(target, async (ptx) => {
      const written = await writeSnapshot(ptx, target, snap, dbs.stagingGateSecret ?? null, gen);
      sections[target] = written.sections;
      superseded[target] = written.skipped;
      comments = Math.max(comments, written.comments);
    });
  }
  return { sections, comments, superseded };
}

function unreleasedOf(snap: Snapshot): PublicTarget[] {
  if (!snap.releases) return [];
  return PUBLIC_TARGETS.filter((t) => snap.releases?.[t] === null);
}

const ALL_SECTIONS: readonly ProjectionSection[] = [
  "settings",
  "staging",
  "rate_limits",
  "redirects",
  "plugins",
];

/**
 * An install from before #1329 has no frozen release state: freeze the
 * current main line once as the state both environments serve (the state
 * the live gateway was already serving), when this process can. A process
 * that cannot (an active plugin is not loaded here, or `declarations` is
 * null as in the migration job) leaves it to the admin's boot.
 */
async function bootstrapPointers(
  tx: ProjectionTx,
  declarations: VisitorProjectionDeclarations | null,
): Promise<void> {
  if (declarations === null) return;
  const pointed = (await rows(
    tx,
    sql`SELECT environment FROM projection_release_pointers`,
  )) as unknown as { environment: PublicTarget }[];
  const missing = PUBLIC_TARGETS.filter((t) => !pointed.some((p) => p.environment === t));
  if (missing.length === 0) return;
  const runId = crypto.randomUUID();
  try {
    await freezeRelease(tx, { runId, reason: "bootstrap", declarations, completeness: "required" });
  } catch (e) {
    if (e instanceof ReleaseFreezeError) return;
    throw e;
  }
  for (const env of missing) await pointRelease(tx, env, runId);
}

/**
 * Publish everything to both public databases: the immediate sections, the
 * release sections each environment's pointer names, and — with
 * `comments: true` — a full resync of the approved comments (the migration
 * job; the admin's boot drains comment changes instead). Also consumes the
 * outbox it covers.
 *
 * `declarations` (the loaded plugins' projections) lets an install from
 * before #1329 bootstrap its frozen state; the migration job passes null
 * and leaves that to the admin.
 */
export async function publishPublicProjection(
  dbs: ProjectionDatabases,
  declarations: VisitorProjectionDeclarations | null,
  opts: { readonly comments: boolean; readonly lockWait?: ProjectionLockWait },
): Promise<PublishReport> {
  const read = await withProjectionLock(dbs, opts.lockWait ?? {}, async (tx) => {
    const gen = await readGeneration(tx);
    await bootstrapPointers(tx, declarations);
    const outbox = await readOutbox(tx);
    const commentIds = opts.comments ? new Set<string>() : outbox.commentIds;
    const snap = await readSnapshot(tx, new Set(ALL_SECTIONS), opts.comments, commentIds);
    return { gen, outbox, snap };
  });
  return writeAndConsume(dbs, read);
}

/** What a publisher read under the projection lock (#1594). */
interface PublishRead {
  readonly gen: Generation;
  readonly outbox: OutboxBatch;
  readonly snap: Snapshot;
}

/**
 * #1594 — write what was read to both public databases, then consume the
 * outbox rows the read covered, in a short admin transaction of its own.
 * No admin transaction is open while the public databases are written:
 * the read committed (releasing the lock) before, and {@link claimUnit}
 * keeps an older read from overwriting a newer publish. A failed write
 * consumes nothing, so the next drain publishes the same changes again.
 */
async function writeAndConsume(
  dbs: ProjectionDatabases,
  read: PublishRead,
): Promise<PublishReport> {
  const written = await writeAll(dbs, read.snap, read.gen);
  await dbs.readAdmin((tx) => consumeOutbox(tx, read.outbox.ids));
  return {
    sections: written.sections,
    comments: written.comments,
    drained: read.outbox.count,
    unreleased: unreleasedOf(read.snap),
    superseded: written.superseded,
  };
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
 * How long a publisher keeps asking for the projection lock while another
 * publisher holds it. Every pause is spent without a connection.
 */
export interface ProjectionLockWait {
  /** Give up after this long (default 15 s, the 0392 `lock_timeout` it replaces). */
  readonly waitMs?: number;
  /** Pause between two attempts (default 200 ms, jittered ±50 %). */
  readonly retryMs?: number;
  /** Overrides for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_LOCK_WAIT_MS = 15_000;
const DEFAULT_LOCK_RETRY_MS = 200;

/**
 * Another publisher held the projection lock for the whole wait. Nothing
 * was published or consumed; the outbox keeps every change for the next
 * drain.
 */
export class ProjectionBusyError extends Error {
  override readonly name = "ProjectionBusyError";
  constructor(readonly waitedMs: number) {
    super(
      `another publisher held the gateway projection lock for ${waitedMs} ms; nothing was published and the outbox keeps the changes — the next drain publishes them`,
    );
  }
}

/**
 * Run `fn` in an admin transaction that holds the projection lock. When
 * another publisher holds it, the transaction ends at once (releasing its
 * connection) and a new one asks again after a pause, until
 * `wait.waitMs` has passed.
 *
 * @throws ProjectionBusyError when the lock never became free in time.
 */
export async function withProjectionLock<T>(
  dbs: ProjectionDatabases,
  wait: ProjectionLockWait,
  fn: (tx: ProjectionTx) => Promise<T>,
): Promise<T> {
  const now = wait.now ?? Date.now;
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = wait.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const retryMs = wait.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const started = now();
  for (;;) {
    const attempt = await dbs.readAdmin(async (tx) => {
      const [row] = await rows(tx, PROJECTION_TRY_LOCK);
      if (row?.locked !== true) return { locked: false as const };
      return { locked: true as const, value: await fn(tx) };
    });
    if (attempt.locked) return attempt.value;
    const waited = now() - started;
    if (waited >= waitMs) throw new ProjectionBusyError(waited);
    // Jitter so publishers of several instances do not retry in lockstep.
    await sleep(Math.min(retryMs * (0.5 + Math.random()), Math.max(0, waitMs - waited)));
  }
}

async function readOutbox(tx: ProjectionTx): Promise<OutboxBatch> {
  const found = (await rows(
    tx,
    sql`SELECT id::text AS id, section, entity_id::text AS entity_id
        FROM public_projection_outbox ORDER BY id LIMIT ${OUTBOX_BATCH}`,
  )) as unknown as { id: string; section: string; entity_id: string | null }[];
  const sections = new Set<ProjectionSection>();
  const commentIds = new Set<string>();
  for (const r of found) {
    if (r.section === "comments") {
      if (r.entity_id && UUID_RE.test(r.entity_id)) commentIds.add(r.entity_id);
    } else if (!r.section.startsWith("plugin:")) {
      // A plugin's own rows changed in the admin: its published rows
      // follow the next frozen release, so the row is only consumed.
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
 * Tests and test fixtures only — scripts/no-automatic-production-deploy.test.ts
 * fails on any other caller: freeze the current main line and point BOTH
 * environments at it, then publish everything, as a Stage followed by
 * Publish live would. Lets a test that changes plugin data see it on the
 * public side without running a build.
 *
 * `completeness` defaults to `required`; a fixture that shares its
 * database with suites activating other plugins passes `as-loaded`, which
 * is what a Stage freezes ({@link FreezeCompleteness}).
 */
export async function releaseMainLineForTests(
  dbs: ProjectionDatabases,
  declarations: VisitorProjectionDeclarations,
  completeness: FreezeCompleteness = "required",
): Promise<PublishReport> {
  const read = await withProjectionLock(dbs, {}, async (tx) => {
    const gen = await readGeneration(tx);
    const runId = crypto.randomUUID();
    await freezeRelease(tx, { runId, reason: "bootstrap", declarations, completeness });
    for (const env of PUBLIC_TARGETS) await pointRelease(tx, env, runId);
    const outbox = await readOutbox(tx);
    const snap = await readSnapshot(tx, new Set(ALL_SECTIONS), true, new Set());
    return { gen, outbox, snap };
  });
  return writeAndConsume(dbs, read);
}

/**
 * Republish to both public databases whatever the outbox says is stale,
 * then consume those rows. Cheap when the outbox is empty (one indexed
 * read under the lock). Release sections are published from each
 * environment's frozen state ({@link narrowRelease}), never the main line.
 */
export async function drainPublicProjection(
  dbs: ProjectionDatabases,
  opts: { readonly lockWait?: ProjectionLockWait } = {},
): Promise<PublishReport> {
  const empty = { live: [], staging: [] };
  const read = await withProjectionLock(
    dbs,
    opts.lockWait ?? {},
    async (tx): Promise<PublishRead | PublishReport> => {
      const gen = await readGeneration(tx);
      const outbox = await readOutbox(tx);
      if (outbox.count === 0) {
        return { sections: empty, comments: 0, drained: 0, unreleased: [], superseded: empty };
      }
      if (outbox.sections.size === 0 && outbox.commentIds.size === 0) {
        // Nothing to publish (a plugin's own rows follow the next release):
        // consumed here, nothing is written to a public database.
        await consumeOutbox(tx, outbox.ids);
        return {
          sections: empty,
          comments: 0,
          drained: outbox.count,
          unreleased: [],
          superseded: empty,
        };
      }
      const snap = await readSnapshot(tx, outbox.sections, false, outbox.commentIds);
      return { gen, outbox, snap };
    },
  );
  return "snap" in read ? writeAndConsume(dbs, read) : read;
}
