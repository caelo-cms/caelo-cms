// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/redeploy-orchestrator — debounced auto-redeploy.
 *
 * Polls the `audit_events` tail every `pollIntervalMs` (default 1500ms)
 * and watches for "publishable" op kinds (configurable via
 * `site_settings.auto_redeploy_op_kinds`). When an event arrives, a
 * timer is armed for `auto_redeploy_debounce_ms` (default 12000ms).
 * Subsequent events within the window reset the timer. When the timer
 * fires, it rebuilds production — through the #553 quality gate:
 *   - when main still renders what the last Stage's quality check saw
 *     (the plan op compares render fingerprints), only content changed:
 *     production is rebuilt directly, as before; deploy.trigger still
 *     refuses (and records a failed run) while the staged build's gate is
 *     closed;
 *   - otherwise the changes are Staged, queued for a quality audit of the
 *     pages they render on (`autoPublish`), and the audit worker publishes
 *     them only when the gate is open (otherwise it stops and records why).
 *
 * Polling (vs LISTEN/NOTIFY) keeps the implementation portable across
 * pgbouncer modes + cloud-managed Postgres without needing to wire a
 * dedicated long-lived connection per replica. The poll cost is
 * trivial — one indexed timestamp range query per tick.
 *
 * Visitor plugin ops (#635): the public gateway has no cms_admin login, so
 * the op record of a visitor call lands in cms_public
 * (`gateway_plugin_op_events`). The tick reads those too — as UNTRUSTED
 * hints: each row is schema-checked, only allowlisted op kinds count, a
 * page id is accepted only when it names an existing page, and a hint
 * only ever schedules a rebuild from the authoritative state (it never
 * changes cms_admin). See docs/dev/public-admin-boundary.md.
 *
 * Also runs the admin's own GC sweep every hour (its login rate-limit
 * buckets); the gateway sweeps its own state in cms_public.
 */

import { createHash } from "node:crypto";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import {
  aggregateSiteDesignTokens,
  type CrawlCheckpoint,
  type CrawledPage,
  crawlSite,
  createPlaywrightScreenshotter,
  deriveDesignTokens,
  type PageDesignTokens,
  type Screenshot,
  type Screenshotter,
} from "@caelo-cms/site-importer";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { parseCrawlScope } from "./crawl-scope.js";
import { parseExplicitUrls } from "./explicit-urls.js";

/** issue #423 — deterministic per-URL storage suffix so re-captures and
 *  resume replays overwrite the same object instead of accumulating. */
function urlKeyFragment(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/**
 * issue #191 — hostnames the importer's SSRF guard exempts. Set
 * CAELO_IMPORTER_ALLOWED_HOSTS to a comma-list of exact hostnames.
 * Exists for e2e fixture servers and deliberate private-network
 * crawls; empty (fully guarded) everywhere else.
 */
function importerAllowedHosts(): readonly string[] {
  return (process.env.CAELO_IMPORTER_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

/**
 * issue #192 — revive a checkpointed frontier from the claimed row.
 * Shape-checked defensively: a malformed checkpoint (schema drift,
 * manual edit) restarts the crawl instead of crashing the tick — the
 * DB's UNIQUE(run_id, source_url) absorbs the replay.
 */
function parseCrawlCheckpoint(raw: unknown): CrawlCheckpoint | null {
  const v = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (typeof v !== "object" || v === null) return null;
  const cp = v as Partial<CrawlCheckpoint>;
  if (!Array.isArray(cp.queue) || !Array.isArray(cp.seen)) return null;
  if (typeof cp.pagesCrawled !== "number") return null;
  return {
    queue: cp.queue.filter(
      (q): q is { url: string; depth: number } =>
        typeof q === "object" && q !== null && typeof (q as { url?: unknown }).url === "string",
    ),
    seen: cp.seen.filter((x): x is string => typeof x === "string"),
    pagesCrawled: cp.pagesCrawled,
    errors: Array.isArray(cp.errors)
      ? cp.errors.filter(
          (e): e is { url: string; reason: string } =>
            typeof e === "object" && e !== null && typeof (e as { url?: unknown }).url === "string",
        )
      : [],
    // issue #425 — the skip ledger joined the checkpoint later; an old
    // in-flight checkpoint without it resumes with an empty ledger.
    // Both fields are checked (PR #435 review): an entry missing its
    // `reason` must not reach the report claiming to have one.
    skipped: Array.isArray(cp.skipped)
      ? cp.skipped.filter(
          (e): e is { url: string; reason: string } =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as { url?: unknown }).url === "string" &&
            typeof (e as { reason?: unknown }).reason === "string",
        )
      : [],
    skippedOutOfScope: typeof cp.skippedOutOfScope === "number" ? cp.skippedOutOfScope : 0,
  };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "redeploy-orchestrator",
};

export interface OrchestratorConfig {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /** Defaults to 1500ms. */
  readonly pollIntervalMs?: number;
  /** Defaults to one hour. */
  readonly gcIntervalMs?: number;
  /**
   * issue #198 — sink for import screenshots (the admin app wires its
   * media storage in). Absent = captures are diffed but not persisted
   * (pre-#198 behaviour), which the run records via the NULL keys.
   */
  readonly screenshotStorage?: {
    put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  };
}

export interface OrchestratorHandle {
  stop(): void;
  /** For tests + manual triggers. */
  flushPending(): Promise<void>;
}

interface Settings {
  enabled: boolean;
  debounceMs: number;
  opKinds: string[];
}

/**
 * Where a plugin op came from. `audit` = cms_admin `audit_events`, written
 * by the admin itself: trusted, so an inconsistency there throws.
 * `visitor` = cms_public `gateway_plugin_op_events`, writable by anyone
 * holding public_role: untrusted input, so a row that names no installed,
 * active plugin is dropped (boundary validation), never thrown on — a
 * throw would pin the visitor watermark at that row for good.
 */
type OpSource = "audit" | "visitor";

/** The page a plugin op touched (null = none), or why a visitor event was dropped. */
type PluginOpResolution = { pageId: string | null } | { dropped: string };

/**
 * v0.2.16 — resolve a plugin write op + its entity_id to the page_id
 * the operation logically affects, so auto-redeploy can rebuild only
 * that page. Each entry queries the plugin's own cms_public table.
 * Adding a new plugin op = adding a switch case below; no schema
 * change needed.
 */
async function resolvePluginOpPageId(
  adapter: DatabaseAdapter,
  operation: string,
  entityId: string,
  source: OpSource,
): Promise<PluginOpResolution> {
  const read = await readPluginRowPageId(adapter, operation, entityId, source);
  if ("dropped" in read) return read;
  // The plugin tables live in cms_public: what they say is UNTRUSTED (#635).
  // A page id counts only when it is a uuid naming a page that exists.
  const pageId = read.pageId;
  if (pageId === null || !UUID_RE.test(pageId)) return { pageId: null };
  const exists = (await adapter.withAdminTransaction(
    SYSTEM_CTX,
    async (tx) =>
      await tx.execute(sql`SELECT 1 AS ok FROM pages WHERE id = ${pageId}::uuid LIMIT 1`),
  )) as unknown as unknown[];
  return { pageId: exists.length > 0 ? pageId : null };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The plugin row a plugin op's entity names, when that row is bound to a
 * page: the owning plugin's slug + the lookup. Forms / newsletter ops have
 * no per-page binding (a submission or signup changes no page's bake), so
 * they intentionally don't appear here. A future plugin op that should
 * trigger a per-page rebuild adds a case.
 */
function pluginPageLookup(
  operation: string,
  entityId: string,
): { slug: string; query: SQL } | null {
  // Comments — `comments.moderate` + bulk variant; entity_id is the comment id.
  if (operation === "comments.moderate" || operation === "comments.bulk_moderate") {
    return {
      slug: "comments",
      query: sql`SELECT page_id::text AS page_id FROM plugin_comments.comments
                 WHERE id = ${entityId}::uuid LIMIT 1`,
    };
  }
  // Ratings — `ratings.submit` writes a row + updates aggregates; entity_id
  // is the rating id.
  if (operation === "ratings.submit") {
    return {
      slug: "ratings",
      query: sql`SELECT page_id::text AS page_id FROM plugin_ratings.ratings
                 WHERE id = ${entityId}::uuid LIMIT 1`,
    };
  }
  return null;
}

async function readPluginRowPageId(
  adapter: DatabaseAdapter,
  operation: string,
  entityId: string,
  source: OpSource,
): Promise<PluginOpResolution> {
  // Checked before the id reaches any `::uuid` cast: a malformed id must
  // never make Postgres throw (and, on the visitor path, pin the watermark).
  if (!UUID_RE.test(entityId)) {
    if (source === "visitor") return { dropped: "entity_id is not a UUID" };
    throw new Error(`audit_events entity_id "${entityId}" of op "${operation}" is not a UUID`);
  }
  const lookup = pluginPageLookup(operation, entityId);
  if (!lookup) return { pageId: null };
  // No catch: a failed lookup (connection, RLS, missing table) throws out
  // of its pass, which leaves that pass's watermark for the next tick and
  // logs the failure. A swallowed error here once hid that this read saw
  // no rows at all.
  const plugins = (await adapter.withAdminTransaction(
    SYSTEM_CTX,
    async (tx) =>
      await tx.execute(
        sql`SELECT id::text AS id, status FROM plugins WHERE slug = ${lookup.slug} LIMIT 1`,
      ),
  )) as unknown as { id: string; status: string }[];
  const plugin = plugins[0];
  if (source === "visitor") {
    if (!plugin) return { dropped: `the "${lookup.slug}" plugin is not installed` };
    if (plugin.status !== "active") {
      return { dropped: `the "${lookup.slug}" plugin is ${plugin.status}, not active` };
    }
  }
  if (!plugin) throw new PluginNotInstalledError(lookup.slug, operation);
  // Plugin tables are RLS-scoped to their plugin (FORCEd, so the owner
  // too): the read runs as that plugin, or it sees no rows at all.
  const rows = (await adapter.withPublicTransaction(
    { ...SYSTEM_CTX, pluginId: plugin.id },
    async (tx) => await tx.execute(lookup.query),
  )) as unknown as { page_id: string | null }[];
  const v = rows[0]?.page_id;
  return { pageId: typeof v === "string" ? v : null };
}

/**
 * A plugin op in the trusted `audit_events` stream names a plugin with no
 * `plugins` row: the install is inconsistent (the plugin was removed while
 * its op is still allowlisted). Thrown rather than skipped (CLAUDE.md §2,
 * no fallbacks pre-1.0). Visitor events are untrusted and are dropped
 * instead (see {@link OpSource}).
 */
export class PluginNotInstalledError extends Error {
  readonly slug: string;
  readonly operation: string;
  constructor(slug: string, operation: string) {
    super(
      `PluginNotInstalled: op "${operation}" needs the "${slug}" plugin, but cms_admin has no plugins row for slug "${slug}". Install the plugin, or remove "${operation}" from site_settings.auto_redeploy_op_kinds.`,
    );
    this.name = "PluginNotInstalledError";
    this.slug = slug;
    this.operation = operation;
  }
}

const visitorOpEvent = z.object({
  id: z.string().regex(/^\d{1,20}$/),
  operation: z.string().regex(/^[a-z][a-z0-9-]{0,63}\.[a-z_][a-z0-9_]{0,119}$/),
  entity_id: z.string().regex(UUID_RE).nullable(),
  succeeded: z.boolean(),
});

/**
 * Validate `gateway_plugin_op_events` rows read from cms_public. Rows are
 * returned in id order; a malformed one is dropped (the watermark still
 * moves past it: see {@link advanceVisitorWatermark}) and reported with
 * its id, op and reason, as far as the row carries them.
 */
export function parseVisitorOpEvents(raw: readonly unknown[]): {
  rows: z.infer<typeof visitorOpEvent>[];
  dropped: DroppedVisitorEvent[];
} {
  const rows: z.infer<typeof visitorOpEvent>[] = [];
  const dropped: DroppedVisitorEvent[] = [];
  for (const r of raw) {
    const parsed = visitorOpEvent.safeParse(r);
    if (parsed.success) {
      rows.push(parsed.data);
      continue;
    }
    const rec = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
    dropped.push({
      id: typeof rec.id === "string" ? rec.id : null,
      operation: typeof rec.operation === "string" ? rec.operation : null,
      reason: parsed.error.issues
        .map((i) => `${i.path.join(".") || "row"}: ${i.message}`)
        .join("; "),
    });
  }
  return { rows, dropped };
}

/** A visitor op event the orchestrator skipped, and why. */
export interface DroppedVisitorEvent {
  readonly id: string | null;
  readonly operation: string | null;
  readonly reason: string;
}

/** Report a dropped visitor event (once: the watermark moves past it). */
function warnDroppedVisitorEvent(d: DroppedVisitorEvent): void {
  console.warn(
    `[redeploy-orchestrator] dropped visitor op event id=${d.id ?? "?"} op=${d.operation ?? "?"}: ${d.reason}`,
  );
}

/** How long an id gap in `gateway_plugin_op_events` may stay open before it counts as settled. */
const VISITOR_EVENT_GAP_GRACE_SECONDS = 30;

/**
 * How far the visitor-event watermark may move after reading `raw` (rows
 * with `id > after`, in id order, each carrying `settled`: whether the row
 * is older than {@link VISITOR_EVENT_GAP_GRACE_SECONDS}).
 *
 * Ids come from a sequence at INSERT time, so they commit out of order: a
 * row with a lower id can still appear after a higher one was read. The
 * watermark therefore moves only through the contiguous run of ids after
 * `after`. At a gap it stops, unless the row after the gap is settled: a
 * transaction that took the missing id took it before that row's id and
 * would have committed long ago (the gateway's inserts are single
 * statements), so the gap is a rollback or a burned id, not a pending row.
 *
 * It also never passes `sequenceLast` (the sequence's last value): an id
 * above it was not issued by the sequence, so it is forged (public_role may
 * not choose ids; this is the check behind that grant) and must not move
 * the watermark past every real event to come.
 *
 * Returns the rows the watermark covers and the new watermark (null when
 * it does not move). Malformed rows inside the run are covered too, so
 * garbage cannot pin the watermark; the caller still validates every row.
 */
export function advanceVisitorWatermark(
  raw: readonly unknown[],
  after: string,
  sequenceLast: string | null,
): { covered: unknown[]; watermark: string | null } {
  const ceiling =
    sequenceLast !== null && /^\d{1,20}$/.test(sequenceLast) ? BigInt(sequenceLast) : null;
  const withIds: { id: bigint; row: unknown; settled: boolean }[] = [];
  for (const r of raw) {
    const rec = r as { id?: unknown; settled?: unknown } | null;
    if (typeof rec?.id !== "string" || !/^\d{1,20}$/.test(rec.id)) continue;
    withIds.push({ id: BigInt(rec.id), row: r, settled: rec.settled === true });
  }
  withIds.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let mark = BigInt(after);
  const covered: unknown[] = [];
  for (const { id, row, settled } of withIds) {
    if (id <= mark) continue;
    if (ceiling === null || id > ceiling) break;
    if (id !== mark + 1n && !settled) break;
    covered.push(row);
    mark = id;
  }
  return { covered, watermark: covered.length === 0 ? null : mark.toString() };
}

/**
 * #635 — visitor plugin op events past the persisted watermark, read from
 * cms_public as UNTRUSTED rows: anything that is not a well-formed event
 * of an allowlisted op kind is skipped, and at most 500 are taken per
 * tick, so a flood of forged rows can delay rebuilds but never widen
 * what a rebuild may touch.
 */
export async function readVisitorOpEvents(
  adapter: DatabaseAdapter,
  opKinds: readonly string[],
): Promise<{
  events: { id: string; operation: string; entity_id: string | null }[];
  /** Malformed rows the watermark covers; reported once it moves past them. */
  dropped: DroppedVisitorEvent[];
  lastId: string | null;
}> {
  try {
    const stored = (await adapter.withAdminTransaction(
      SYSTEM_CTX,
      async (tx) =>
        await tx.execute(
          sql`SELECT auto_redeploy_last_public_event_id::text AS id FROM site_settings WHERE id = 1`,
        ),
    )) as unknown as { id: string }[];
    const after = stored[0]?.id ?? "0";
    const { raw, sequenceLast } = await adapter.withPublicTransaction(SYSTEM_CTX, async (tx) => {
      const seq = (await tx.execute(
        sql`SELECT pg_sequence_last_value('gateway_plugin_op_events_id_seq'::regclass)::text AS last`,
      )) as unknown as { last: string | null }[];
      const found = (await tx.execute(sql`
          SELECT id::text AS id, operation, entity_id::text AS entity_id, succeeded,
                 created_at < now() - make_interval(secs => ${VISITOR_EVENT_GAP_GRACE_SECONDS})
                   AS settled
          FROM gateway_plugin_op_events
          WHERE id > ${after}::bigint
          ORDER BY id ASC
          LIMIT 500
        `)) as unknown as unknown[];
      return { raw: found, sequenceLast: seq[0]?.last ?? null };
    });
    const { covered, watermark } = advanceVisitorWatermark(raw, after, sequenceLast);
    const { rows, dropped } = parseVisitorOpEvents(covered);
    return {
      events: rows.filter((r) => r.succeeded && opKinds.includes(r.operation)),
      dropped,
      lastId: watermark,
    };
  } catch (e) {
    console.error(
      `[redeploy-orchestrator] visitor op events unreadable: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { events: [], dropped: [], lastId: null };
  }
}

/** Persist the visitor-event watermark (see {@link advanceVisitorWatermark}). */
export async function commitVisitorWatermark(
  adapter: DatabaseAdapter,
  lastId: string,
): Promise<void> {
  await adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
    await tx.execute(
      sql`UPDATE site_settings SET auto_redeploy_last_public_event_id = ${lastId}::bigint WHERE id = 1`,
    );
  });
}

export function startRedeployOrchestrator(cfg: OrchestratorConfig): OrchestratorHandle {
  const pollMs = cfg.pollIntervalMs ?? 1500;
  const gcMs = cfg.gcIntervalMs ?? 60 * 60 * 1000;
  // P13 audit re-pass — load the persisted offset on boot so a restart
  // doesn't drop events that landed during downtime. Initialised to
  // `now()` only when the column is missing entirely (fresh DB without
  // the migration); the seed default in 0041 covers the live path.
  let lastSeenAt = new Date();
  let lastPersistedSeenAt = new Date(0);
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // P13 ideas-pass — accumulate touched page ids since the last fire.
  // Drained on `fireDeploy()`; passed into deploy.trigger so the static
  // generator only re-bakes the changed subset.
  const pendingPageIds = new Set<string>();

  async function loadSettings(): Promise<Settings & { lastSeenAt: Date }> {
    const rows = await cfg.adapter.withAdminTransaction(
      SYSTEM_CTX,
      async (tx) =>
        (await tx.execute(sql`
        SELECT auto_redeploy_enabled      AS enabled,
               auto_redeploy_debounce_ms  AS debounce_ms,
               auto_redeploy_op_kinds     AS op_kinds,
               auto_redeploy_last_seen_at AS last_seen_at
        FROM site_settings WHERE id = 1 LIMIT 1
      `)) as unknown as Array<{
          enabled: boolean;
          debounce_ms: number;
          op_kinds: string[];
          last_seen_at: string | Date;
        }>,
    );
    const r = rows[0];
    const persisted = r?.last_seen_at
      ? r.last_seen_at instanceof Date
        ? r.last_seen_at
        : new Date(String(r.last_seen_at))
      : new Date();
    return {
      enabled: r?.enabled ?? false,
      debounceMs: r?.debounce_ms ?? 12000,
      opKinds: r?.op_kinds ?? [],
      lastSeenAt: persisted,
    };
  }

  async function persistLastSeen(at: Date): Promise<void> {
    if (at.getTime() <= lastPersistedSeenAt.getTime()) return;
    try {
      await cfg.adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
        await tx.execute(
          sql`UPDATE site_settings SET auto_redeploy_last_seen_at = ${at.toISOString()} WHERE id = 1`,
        );
      });
      lastPersistedSeenAt = at;
    } catch {
      // best-effort
    }
  }

  // Hydrate the in-process watermark from the DB at boot.
  void loadSettings()
    .then((s) => {
      lastSeenAt = s.lastSeenAt;
      lastPersistedSeenAt = s.lastSeenAt;
    })
    .catch(() => undefined);

  async function fireDeploy(): Promise<void> {
    pendingTimer = null;
    const changed = [...pendingPageIds];
    pendingPageIds.clear();
    try {
      await redeployThroughQualityGate(cfg, changed);
    } catch (e) {
      // Never crash the orchestrator loop; the ops record their own
      // failures (failed deploy runs), this is the last-resort log.
      console.error("[redeploy-orchestrator] automatic redeploy threw", e);
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const settings = await loadSettings().catch(() => null);
    if (!settings?.enabled || settings.opKinds.length === 0) {
      return;
    }
    // P13 audit fix #6 — hard-exclude `deploy.trigger` regardless of
    // configured opKinds. The orchestrator fires deploy.trigger; if
    // that op kind ever lands in the allowlist we'd reentrantly arm
    // the timer on every fire, looping indefinitely.
    const safeOpKinds = settings.opKinds.filter((k) => k !== "deploy.trigger");
    if (safeOpKinds.length === 0) return;
    // Two independent passes, each with its own watermark: a pass that
    // fails leaves its own events for the next tick but never holds back
    // the other pass's rebuilds. Failures are rethrown after the timer is
    // armed so the poll loop logs them.
    const failures: unknown[] = [];
    let rebuild = false;
    try {
      rebuild = (await visitorPass(safeOpKinds)) || rebuild;
    } catch (e) {
      failures.push(e);
    }
    try {
      rebuild = (await auditPass(safeOpKinds)) || rebuild;
    } catch (e) {
      failures.push(e);
    }
    if (rebuild) {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        void fireDeploy();
      }, settings.debounceMs);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "the visitor and the audit pass both failed");
    }
  }

  /**
   * #635 — the untrusted visitor events in cms_public. An event that names
   * no page schedules nothing; one that cannot be valid (malformed, or its
   * plugin is not installed / not active) is dropped and reported once.
   * Returns whether a page was matched (a rebuild is due).
   */
  async function visitorPass(opKinds: readonly string[]): Promise<boolean> {
    const visitor = await readVisitorOpEvents(cfg.adapter, opKinds);
    const matched = new Set<string>();
    const dropped = [...visitor.dropped];
    for (const r of visitor.events) {
      if (!r.entity_id) continue;
      const res = await resolvePluginOpPageId(cfg.adapter, r.operation, r.entity_id, "visitor");
      if ("dropped" in res) dropped.push({ id: r.id, operation: r.operation, reason: res.dropped });
      else if (res.pageId) matched.add(res.pageId);
    }
    // Only now: a failure above leaves the events to the next tick.
    if (visitor.lastId) await commitVisitorWatermark(cfg.adapter, visitor.lastId);
    for (const d of dropped) warnDroppedVisitorEvent(d);
    for (const id of matched) pendingPageIds.add(id);
    return matched.size > 0;
  }

  /**
   * The trusted `audit_events` stream in cms_admin, past `lastSeenAt`.
   * Operations on `pages.*` carry the page id as `entity_id` directly.
   * Plugin write ops carry their own entity (e.g. `comments.moderate`'s is
   * the comment id), resolved to the page it attaches to so an approved
   * comment rebuilds only that page. Returns whether a rebuild is due
   * (any matching row, as before: a row naming no page still rebuilds).
   */
  async function auditPass(opKinds: readonly string[]): Promise<boolean> {
    // One bound param per kind: drizzle + bun-sql do not send a JS array
    // as a Postgres array, so `= ANY(${opKinds})` threw on every tick.
    const rows = await cfg.adapter.withAdminTransaction(
      SYSTEM_CTX,
      async (tx) =>
        (await tx.execute(sql`
        SELECT created_at, entity_id::text AS entity_id, operation
        FROM audit_events
        WHERE created_at > ${lastSeenAt.toISOString()}::timestamptz
          AND operation IN (${sql.join(
            opKinds.map((k) => sql`${k}`),
            sql`, `,
          )})
          AND succeeded = true
        ORDER BY created_at ASC
        LIMIT 500
      `)) as unknown as Array<{
          created_at: string | Date;
          entity_id: string | null;
          operation: string;
        }>,
    );
    if (rows.length === 0) return false;
    const matched = new Set<string>();
    for (const r of rows) {
      if (!r.entity_id) continue;
      if (r.operation.startsWith("pages.")) {
        matched.add(r.entity_id);
        continue;
      }
      const res = await resolvePluginOpPageId(cfg.adapter, r.operation, r.entity_id, "audit");
      if ("pageId" in res && res.pageId) matched.add(res.pageId);
    }
    const latest = rows[rows.length - 1]?.created_at;
    if (latest) {
      lastSeenAt = latest instanceof Date ? latest : new Date(String(latest));
      void persistLastSeen(lastSeenAt);
    }
    for (const id of matched) pendingPageIds.add(id);
    return true;
  }

  /**
   * P14 — Site Import Wizard worker. Picks up at most ONE
   * `import_runs` row at status='crawling' per tick, runs the
   * crawler, writes extracted pages, flips status to
   * 'ready_for_review' (or 'failed' on error). Owner kicks off the
   * crawl via /settings/import → imports.create_run; the AI path is
   * imports.propose_run + Owner approve.
   */
  async function importerTick(): Promise<void> {
    if (stopped) return;
    let runId: string | undefined;
    let sourceUrl: string | undefined;
    let depth = 2;
    let maxPages = 50;
    try {
      // Claim one crawling run atomically. FOR UPDATE SKIP LOCKED so a
      // multi-replica orchestrator can't double-claim a row even if both
      // poll on the same tick. The UPDATE that flips started_at runs
      // inside the same tx so the row is owned for the whole crawl
      // window.
      //
      // issue #192 — two claimable shapes:
      //   - fresh runs (started_at IS NULL), and
      //   - ZOMBIES: 'crawling' runs whose heartbeat went stale (worker
      //     crashed mid-crawl). Pre-#192 these sat in 'crawling'
      //     forever. The 15-minute staleness window comfortably exceeds
      //     the worst-case gap between batch flushes (25 pages × 20s
      //     fetch timeout ≈ 8 min).
      const rows = await cfg.adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
        const claim = (await tx.execute(sql`
            SELECT id::text AS id, source_url, depth, max_pages, explicit_urls, crawl_scope, crawl_state
            FROM import_runs
            WHERE status = 'crawling'
              AND (
                started_at IS NULL
                OR COALESCE(heartbeat_at, started_at) < now() - interval '15 minutes'
              )
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          `)) as unknown as Array<{
          id: string;
          source_url: string;
          depth: number;
          max_pages: number;
          explicit_urls: unknown;
          crawl_scope: unknown;
          crawl_state: unknown;
        }>;
        if (claim.length > 0) {
          await tx.execute(
            sql`UPDATE import_runs SET started_at = now(), heartbeat_at = now() WHERE id = ${claim[0]?.id}::uuid`,
          );
        }
        return claim;
      });
      const r = rows[0];
      if (!r) return;
      runId = r.id;
      sourceUrl = r.source_url;
      depth = r.depth;
      maxPages = r.max_pages;
      // issue #229 — LIST mode: the proposal pinned an exact URL set. The
      // crawler fetches only these (+ the source origin), no BFS. jsonb
      // may decode to an array or a JSON string depending on the client.
      // A present-but-malformed value THROWS (run goes 'failed' with the
      // structured message below) instead of silently degrading to BFS —
      // the Owner approved an exact set, not a depth crawl (§2
      // no-fallbacks). Only SQL NULL means depth mode.
      const explicitUrls = parseExplicitUrls(r.explicit_urls);
      // issue #425 — same loudness contract as explicit_urls: SQL NULL =
      // unscoped; a present-but-malformed scope THROWS (run goes 'failed')
      // instead of silently crawling outside the Owner-approved scope.
      const crawlScope = parseCrawlScope(r.crawl_scope);
      const resumeFrom = parseCrawlCheckpoint(r.crawl_state);
      const claimedRunId = runId;
      // issue #423 — crawl-time ground truth. The crawler streams each
      // page's screenshot out the moment the page is accepted (PNG bytes
      // never buffer across a batch); we upload immediately and remember
      // only url → object key. A throwing sink lands in the run's error
      // list via the crawler (loud), and the page stays keyless so the
      // post-crawl pass below re-attempts + notes it.
      const storage = cfg.screenshotStorage;
      const screenshotKeyByUrl = new Map<string, string>();
      const onPageCapture = storage
        ? async ({ url, screenshot }: { url: string; screenshot: Screenshot }): Promise<void> => {
            const key = `import-screenshots/${claimedRunId}/src-${urlKeyFragment(url)}.png`;
            await storage.put(key, screenshot.bytes, "image/png");
            screenshotKeyByUrl.set(url, key);
          }
        : undefined;
      const flushBatch = async (pages: CrawledPage[]): Promise<void> => {
        await execute(cfg.registry, cfg.adapter, SYSTEM_CTX, "imports.write_extracted_pages", {
          runId: claimedRunId,
          pages: pages.map((p) => ({
            // issue #425 — `p.url` is the FINAL post-redirect URL; the
            // requested URL rides along as provenance when they differ.
            sourceUrl: p.url,
            ...(p.requestedUrl !== undefined ? { requestedUrl: p.requestedUrl } : {}),
            proposedSlug: p.proposedSlug,
            proposedTitle: p.title,
            // Bounded like every stored crawl field; the AI shortens it to
            // the 160-character target when it carries it over anyway.
            sourceMetaDescription: p.metaDescription.slice(0, 2000),
            proposedModules: p.modules.map((m) => ({
              blockName: m.blockName,
              position: m.position,
              html: m.html,
              displayName: m.displayName,
            })),
            proposedThemeTokens: p.themeTokens,
            signature: p.signature,
            pageCss: p.pageCss,
            // run #10 D3 — loud counter from the extractor's
            // comment-thread stripper; persisted as a visible
            // `comments-stripped:<n>` note on the import page.
            commentsStripped: p.commentsStripped,
          })),
        });
        // issue #423 — land the batch's visual ground truth (screenshot
        // keys uploaded by onPageCapture + tokens derived from the SAME
        // render session's style samples) right after the rows exist.
        await persistBatchCapture({
          runId: claimedRunId,
          registry: cfg.registry,
          adapter: cfg.adapter,
          pages,
          screenshotKeyByUrl,
        });
      };
      const result = await crawlSite({
        sourceUrl,
        depth,
        maxPages,
        // issue #229 — present ⇒ LIST mode (crawler ignores depth/maxPages
        // BFS and fetches exactly these + the source origin). Non-null is
        // guaranteed non-empty by parseExplicitUrls.
        ...(explicitUrls ? { urls: explicitUrls } : {}),
        // issue #425 — the Owner-approved language/section scope.
        ...(crawlScope ? { scope: crawlScope } : {}),
        throttleMs: 100,
        // issue #191 — explicit, visible exemption list for the SSRF
        // guard (e2e fixture servers, deliberate private crawls).
        allowedHosts: importerAllowedHosts(),
        // issue #192 — stream batches to the DB (UNIQUE(run_id,
        // source_url) makes resume replays idempotent) + checkpoint the
        // frontier so a crash resumes instead of restarting.
        ...(resumeFrom ? { resumeFrom } : {}),
        onBatch: flushBatch,
        // issue #423 — pixels stream out per page; see onPageCapture above.
        ...(onPageCapture ? { onPageCapture } : {}),
        onCheckpoint: async (cp) => {
          await cfg.adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
            await tx.execute(sql`
              UPDATE import_runs
              SET crawl_state = (${JSON.stringify(cp)}::text)::jsonb, heartbeat_at = now()
              WHERE id = ${claimedRunId}::uuid
            `);
          });
        },
      });
      // issue #247 (WS1) — ground-truth pass, ALWAYS on. issue #423 —
      // now scoped to pages that STILL lack a stored screenshot after the
      // crawl-time capture above (fetch-only crawls, resumed runs, pages
      // whose capture failed mid-crawl): those get the retry-once →
      // loud-note treatment (epic #252 ruling); pages already captured
      // are skipped, so the happy path renders each page exactly once.
      // When capture cannot happen at all (no Playwright, dead page, no
      // storage) every affected page still gets a loud
      // `screenshot_missing` note instead of a silent NULL (F9).
      await captureImportGroundTruth({
        runId,
        adapter: cfg.adapter,
        registry: cfg.registry,
        onlyPagesMissingScreenshot: true,
        ...(cfg.screenshotStorage ? { screenshotStorage: cfg.screenshotStorage } : {}),
      });
      // issue #423 — run-level token aggregate from ALL pages' sampled
      // tokens (crawl-time + after-pass), read back from the rows so
      // neither pass clobbers the other's contribution.
      await writeRunDesignTokenAggregate({
        runId,
        adapter: cfg.adapter,
        registry: cfg.registry,
      });
      await execute(cfg.registry, cfg.adapter, SYSTEM_CTX, "imports.update_run_status", {
        runId,
        status: "ready_for_review",
        pagesSeen: result.seenCount,
        pagesExtracted: result.pagesCrawled,
      });
      // Frontier no longer needed once the run left 'crawling'; keep
      // the error list queryable for the migration report (#197) — and
      // the #425 skip ledger + scope, so the report states what the
      // scope declined, loudly.
      await cfg.adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
        await tx.execute(sql`
          UPDATE import_runs
          SET crawl_state = (${JSON.stringify({
            errors: result.errors,
            skipped: result.skipped,
            skippedOutOfScope: result.skippedOutOfScope,
          })}::text)::jsonb,
              heartbeat_at = NULL
          WHERE id = ${claimedRunId}::uuid
        `);
      });
    } catch (e) {
      if (runId) {
        await execute(cfg.registry, cfg.adapter, SYSTEM_CTX, "imports.update_run_status", {
          runId,
          status: "failed",
          errorMessage: (e as Error).message.slice(0, 1000),
        }).catch(() => undefined);
      }
    }
  }

  async function gcSweep(): Promise<void> {
    if (stopped) return;
    try {
      await cfg.adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
        await tx.execute(
          sql`DELETE FROM rate_limit_buckets WHERE expires_at < now() - interval '1 hour'`,
        );
      });
    } catch {
      // best-effort
    }
  }

  // One tick at a time. A tick slower than `pollMs` (a slow database, a
  // short test interval) must not overlap the next: both would read the
  // same visitor events before either commits the watermark, report a
  // dropped event twice and race `lastSeenAt`. The interval skips while
  // one runs; the next interval picks up whatever is left.
  let tickRunning = false;
  const pollHandle = setInterval(() => {
    if (tickRunning) return;
    tickRunning = true;
    // A failed tick leaves its events (and the watermark) for the next one.
    // The whole error, not only its message: drizzle's "Failed query"
    // message leaves out the Postgres cause.
    tick()
      .catch((e: unknown) => {
        console.error("[redeploy-orchestrator] tick failed", e);
      })
      .finally(() => {
        tickRunning = false;
      });
  }, pollMs);
  const gcHandle = setInterval(() => {
    void gcSweep();
  }, gcMs);
  // P14 — importer tick every 10s; one crawl per tick so a long crawl
  // doesn't starve the auto-redeploy poller.
  const importerHandle = setInterval(() => {
    void importerTick();
  }, 10_000);

  return {
    stop(): void {
      stopped = true;
      clearInterval(pollHandle);
      clearInterval(gcHandle);
      clearInterval(importerHandle);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    },
    async flushPending(): Promise<void> {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
        await fireDeploy();
      }
    },
  };
}

/**
 * #553 — one automatic redeploy through the quality gate. Exported for the
 * integration test. Every refusal is recorded by the op that refuses (a
 * failed deploy run Ops and the notification bell show); this only logs.
 */
export async function redeployThroughQualityGate(
  cfg: Pick<OrchestratorConfig, "adapter" | "registry">,
  changedPageIds: readonly string[],
): Promise<
  | { path: "production"; ok: boolean }
  | { path: "staged-for-audit"; ok: boolean; auditRunId?: string }
  | { path: "unplanned" }
> {
  const plan = await execute(
    cfg.registry,
    cfg.adapter,
    SYSTEM_CTX,
    "quality_audits.plan_auto_redeploy",
    {
      changedPageIds: changedPageIds.slice(0, 500),
    },
  );
  if (!plan.ok) {
    console.error("[redeploy-orchestrator] could not plan the automatic redeploy", plan.error);
    return { path: "unplanned" };
  }
  const { auditNeeded, reasons, pageIds } = plan.value as {
    auditNeeded: boolean;
    reasons: string[];
    pageIds: string[];
  };
  if (!auditNeeded) {
    // Content only: rebuild production as before (empty = full rebuild).
    const r = await execute(cfg.registry, cfg.adapter, SYSTEM_CTX, "deploy.trigger", {
      targetName: "production",
      ...(changedPageIds.length > 0 ? { changedPageIds: [...changedPageIds] } : {}),
    });
    if (!r.ok)
      console.error("[redeploy-orchestrator] production rebuild refused or failed", r.error);
    return { path: "production", ok: r.ok };
  }
  // Rendering may change: Stage, audit, publish only when the gate opens.
  const staged = await execute(cfg.registry, cfg.adapter, SYSTEM_CTX, "deploy.trigger", {
    targetName: "staging",
  });
  if (!staged.ok) {
    console.error("[redeploy-orchestrator] automatic Stage failed", staged.error);
    return { path: "staged-for-audit", ok: false };
  }
  const queued = await execute(cfg.registry, cfg.adapter, SYSTEM_CTX, "quality_audits.enqueue", {
    deployRunId: (staged.value as { runId: string }).runId,
    chatSessionId: null,
    branch: null,
    pageIds,
    autoPublish: true,
  });
  if (!queued.ok) {
    console.error("[redeploy-orchestrator] could not queue the quality check", queued.error);
    return { path: "staged-for-audit", ok: false };
  }
  console.log(
    `[redeploy-orchestrator] staged for a quality check before publishing (${reasons.join(", ")})`,
  );
  return {
    path: "staged-for-audit",
    ok: true,
    auditRunId: (queued.value as { auditRunId: string }).auditRunId,
  };
}

/**
 * issue #423 — persist one crawl batch's visual ground truth: screenshot
 * object keys (uploaded by the crawl's onPageCapture sink) + design
 * tokens derived from the same render session's style samples, in ONE
 * bulk op call. Pages with a stored screenshot but ZERO style samples get
 * the loud `design_tokens_missing` note here, because the post-crawl
 * ground-truth pass only touches keyless pages and would never see them.
 *
 * Exported for the integration tests to drive directly without standing
 * up the polling orchestrator.
 */
export async function persistBatchCapture(args: {
  readonly runId: string;
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly pages: readonly CrawledPage[];
  /** url → uploaded screenshot object key (absent = no stored pixels). */
  readonly screenshotKeyByUrl: ReadonlyMap<string, string>;
}): Promise<void> {
  const captures = args.pages.flatMap((p) => {
    const key = args.screenshotKeyByUrl.get(p.url);
    const tokens =
      p.styleSamples && p.styleSamples.length > 0 ? deriveDesignTokens(p.styleSamples) : null;
    if (!key && !tokens) return [];
    return [
      {
        sourceUrl: p.url,
        ...(key ? { screenshotObjectKey: key } : {}),
        ...(tokens ? { sampledDesignTokens: tokens } : {}),
      },
    ];
  });
  if (captures.length === 0) return;

  const wrote = await execute(
    args.registry,
    args.adapter,
    SYSTEM_CTX,
    "imports.set_page_captures_by_url",
    { runId: args.runId, captures },
  );
  if (!wrote.ok) {
    // System-scoped op fed by our own crawl output — a rejection is a real
    // bug (schema drift), not an environment quirk (no-fallbacks pre-1.0).
    throw new Error(`imports.set_page_captures_by_url rejected: ${JSON.stringify(wrote.error)}`);
  }
  const w = wrote.value as {
    updated: Array<{ importPageId: string; sourceUrl: string }>;
    unmatched: string[];
  };
  if (w.unmatched.length > 0) {
    // The batch's rows were written by write_extracted_pages moments ago
    // (ON CONFLICT keeps replayed rows), so an unmatched URL means the
    // linkage is broken — fail the run loudly rather than staging pages
    // whose ground truth silently went nowhere.
    throw new Error(
      `imports.set_page_captures_by_url matched no import_pages row for: ${w.unmatched.join(", ")}`,
    );
  }

  // Loud design_tokens_missing markers for captured-but-sampleless pages
  // (same wording as the ground-truth pass). Note-write failures log
  // instead of throwing — a lost note must not mask the batch's data.
  const idByUrl = new Map(w.updated.map((u) => [u.sourceUrl, u.importPageId]));
  for (const p of args.pages) {
    if (!args.screenshotKeyByUrl.has(p.url)) continue; // keyless → after-pass owns notes
    if (p.styleSamples && p.styleSamples.length > 0) continue;
    const importPageId = idByUrl.get(p.url);
    if (!importPageId) continue;
    const noted = await execute(args.registry, args.adapter, SYSTEM_CTX, "imports.add_page_notes", {
      importPageId,
      notes: [
        {
          category: "design_tokens_missing",
          note:
            "Rendered page returned zero computed-style samples — no design tokens for this page. " +
            "Theme decisions fall back to the run's other pages / extractor tokens.",
          applied: false,
        },
      ],
    }).catch((e) => ({ ok: false as const, error: e }));
    if (!noted.ok) {
      console.error(
        `[redeploy-orchestrator] failed to record design_tokens_missing note on import_page ${importPageId}:`,
        noted.error,
      );
    }
  }
}

/**
 * issue #423 — write the run-level design-token aggregate from EVERY
 * page's stored `sampled_design_tokens` (crawl-time captures + the
 * post-crawl pass), so neither pass clobbers the other's contribution.
 * No tokens anywhere = nothing written; the run report then says loudly
 * that theme values came from the extractor only.
 *
 * Exported for the integration tests to drive directly.
 */
export async function writeRunDesignTokenAggregate(args: {
  readonly runId: string;
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
}): Promise<void> {
  const g = await execute(args.registry, args.adapter, SYSTEM_CTX, "imports.get", {
    runId: args.runId,
  });
  if (!g.ok) {
    throw new Error(`imports.get rejected while aggregating tokens: ${JSON.stringify(g.error)}`);
  }
  const pages = (g.value as { pages: Array<{ sampledDesignTokens: unknown }> }).pages;
  // Rows were written through pageDesignTokensSchema-validated ops, so the
  // cast back is sound; junk would have been rejected at write time.
  const pageTokens = pages
    .map((p) => p.sampledDesignTokens)
    .filter((t): t is PageDesignTokens => t !== null && typeof t === "object");
  if (pageTokens.length === 0) return;
  const wrote = await execute(
    args.registry,
    args.adapter,
    SYSTEM_CTX,
    "imports.set_run_design_tokens",
    { runId: args.runId, siteDesignTokens: aggregateSiteDesignTokens(pageTokens) },
  );
  if (!wrote.ok) {
    throw new Error(`imports.set_run_design_tokens rejected: ${JSON.stringify(wrote.error)}`);
  }
}

/**
 * issue #247 (WS1) — design ground truth for every import_pages row in
 * `runId`: ONE Playwright render session per source page produces the
 * source screenshot AND the computed-style token samples. Per-page
 * tokens land on `import_pages.sampled_design_tokens`; the run-level
 * aggregate lands on `import_runs.site_design_tokens` (which
 * compose_from_run prefers over extractor tokens).
 *
 * Failure contract (CLAUDE.md §2 no-fallbacks): a page that ends up
 * WITHOUT a stored source screenshot always carries a
 * `screenshot_missing` note naming the cause — Playwright unavailable,
 * capture failed after a retry, storage missing, or upload failed —
 * so downstream verification treats it as UNVERIFIED. There is no code
 * path that skips capture wholesale without notes.
 *
 * issue #423 — the crawl itself now captures in the same session that
 * renders each page, so the orchestrator calls this with
 * `onlyPagesMissingScreenshot: true`: a second-chance + fallback pass
 * (fetch-only crawls, resumed runs, mid-crawl capture failures) instead
 * of a whole-run re-render. In that mode the run-level token aggregate is
 * NOT written here — the caller aggregates from row state afterwards
 * (`writeRunDesignTokenAggregate`), so the scoped pass cannot clobber the
 * crawl-time captures' contribution.
 *
 * Exported for the integration tests to drive directly without standing
 * up the polling orchestrator.
 */
export async function captureImportGroundTruth(args: {
  readonly runId: string;
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /** Optional override for tests; defaults to Playwright via dynamic import. */
  readonly screenshotter?: Screenshotter | null;
  /** issue #423 — capture only pages whose screenshot_object_key is still
   *  NULL (and skip the run-level aggregate write; see above). */
  readonly onlyPagesMissingScreenshot?: boolean;
  /** issue #198 — when present, the source screenshot is uploaded and its
   *  key lands on the import_pages row. */
  readonly screenshotStorage?: {
    put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  };
}): Promise<{ captured: number; failed: number }> {
  const noteMissing = async (
    importPageId: string,
    category: "screenshot_missing" | "design_tokens_missing",
    note: string,
  ): Promise<void> => {
    // The note IS the loud marker — losing it silently would recreate
    // F9. It must not mask the original capture failure either, so a
    // failed write logs instead of throwing.
    try {
      const r = await execute(args.registry, args.adapter, SYSTEM_CTX, "imports.add_page_notes", {
        importPageId,
        notes: [{ category, note: note.slice(0, 1000), applied: false }],
      });
      if (!r.ok) {
        console.error(
          `[redeploy-orchestrator] failed to record ${category} note on import_page ${importPageId}:`,
          r.error,
        );
      }
    } catch (e) {
      console.error(
        `[redeploy-orchestrator] failed to record ${category} note on import_page ${importPageId}:`,
        e,
      );
    }
  };

  const get = await execute(args.registry, args.adapter, SYSTEM_CTX, "imports.get", {
    runId: args.runId,
  });
  if (!get.ok) {
    // issue #423 — this used to return {0,0} silently, which is exactly
    // the "run looks done with zero ground truth" failure class this
    // whole pass exists to prevent. A system op rejecting its own run id
    // is schema drift — fail the run loudly (no-fallbacks pre-1.0).
    throw new Error(`imports.get rejected in ground-truth pass: ${JSON.stringify(get.error)}`);
  }
  const all = (
    get.value as {
      pages: Array<{
        id: string;
        sourceUrl: string;
        proposedSlug: string;
        screenshotObjectKey: string | null;
      }>;
    }
  ).pages;
  // issue #423 — scoped mode: pages captured during the crawl are done;
  // only the still-keyless ones get the retry + loud-note treatment.
  const targets = args.onlyPagesMissingScreenshot
    ? all.filter((p) => p.screenshotObjectKey === null)
    : all;
  const v = { pages: targets };
  // Nothing to do → do not launch a browser for it.
  if (v.pages.length === 0) return { captured: 0, failed: 0 };

  const screenshotter =
    args.screenshotter !== undefined
      ? args.screenshotter
      : await createPlaywrightScreenshotter({ allowedHosts: importerAllowedHosts() });
  if (!screenshotter) {
    // Pre-#247 this returned silently and the run looked "done" with
    // zero screenshots (F9). Every page now reads as UNVERIFIED.
    for (const p of v.pages) {
      await noteMissing(
        p.id,
        "screenshot_missing",
        "Source screenshot NOT captured: Playwright/chromium is unavailable in this runtime. " +
          "Install it (`bun node_modules/playwright/cli.js install chromium`) and re-run the import; " +
          "this page is UNVERIFIED until a source screenshot exists.",
      );
    }
    return { captured: 0, failed: v.pages.length };
  }

  // One transient hiccup (slow host, flaky network) must not cost the
  // ground truth — retry exactly once, then note and move on.
  const captureWithRetry = async (url: string): Promise<Screenshot> => {
    try {
      return await screenshotter.capture(url, { external: true, sampleStyles: true });
    } catch {
      return await screenshotter.capture(url, { external: true, sampleStyles: true });
    }
  };

  let captured = 0;
  let failed = 0;
  const pageTokens: PageDesignTokens[] = [];
  try {
    for (const p of v.pages) {
      // issue #191 — the source URL is third-party: guard it.
      let sourceShot: Screenshot;
      try {
        sourceShot = await captureWithRetry(p.sourceUrl);
      } catch (e) {
        failed += 1;
        await noteMissing(
          p.id,
          "screenshot_missing",
          `Source screenshot NOT captured after a retry (${(e as Error).message}). ` +
            "This page is UNVERIFIED — the AI has no visual ground truth for it.",
        );
        continue;
      }

      // Tokens travel with the capture write below; an empty sample set
      // from a rendered page is a loud anomaly, not a shrug.
      const tokens =
        sourceShot.styleSamples && sourceShot.styleSamples.length > 0
          ? deriveDesignTokens(sourceShot.styleSamples)
          : null;
      if (tokens) pageTokens.push(tokens);
      else {
        await noteMissing(
          p.id,
          "design_tokens_missing",
          "Rendered page returned zero computed-style samples — no design tokens for this page. " +
            "Theme decisions fall back to the run's other pages / extractor tokens.",
        );
      }

      // issue #198 — persist the pixels, not just the verdict. The key is
      // deterministic per page so re-captures overwrite instead of
      // accumulating. issue #247 — a capture that cannot be PERSISTED
      // is a missing screenshot: note it (the key stays NULL and the
      // page stays UNVERIFIED), but still write tokens.
      let sourceKey: string | undefined;
      if (args.screenshotStorage) {
        try {
          sourceKey = `import-screenshots/${args.runId}/${p.id}-source.png`;
          await args.screenshotStorage.put(sourceKey, sourceShot.bytes, "image/png");
        } catch (e) {
          sourceKey = undefined;
          await noteMissing(
            p.id,
            "screenshot_missing",
            `Source screenshot captured but the upload failed (${(e as Error).message}). ` +
              "This page is UNVERIFIED until a stored source screenshot exists.",
          );
        }
      } else {
        await noteMissing(
          p.id,
          "screenshot_missing",
          "Source screenshot captured but NO screenshot storage is configured on this install — " +
            "the pixels were dropped. Wire screenshotStorage (media storage) into the orchestrator; " +
            "this page is UNVERIFIED until a stored source screenshot exists.",
        );
      }

      await execute(args.registry, args.adapter, SYSTEM_CTX, "imports.update_page_capture", {
        importPageId: p.id,
        ...(sourceKey ? { screenshotObjectKey: sourceKey } : {}),
        ...(tokens ? { sampledDesignTokens: tokens } : {}),
      });
      captured += 1;
    }
  } finally {
    await screenshotter.dispose().catch(() => undefined);
  }

  // Run-level aggregate — what the theme proposal consumes. Written
  // even for partial captures: N sampled pages beat zero ground truth,
  // and pageCount tells the AI how much of the site it represents.
  // issue #423 — SKIPPED in scoped mode: this pass then saw only the
  // pages that were still keyless, and an aggregate over that subset
  // would clobber the crawl-time captures' contribution. The caller
  // aggregates from row state instead (writeRunDesignTokenAggregate).
  if (args.onlyPagesMissingScreenshot) return { captured, failed };
  if (pageTokens.length > 0) {
    const wrote = await execute(
      args.registry,
      args.adapter,
      SYSTEM_CTX,
      "imports.set_run_design_tokens",
      { runId: args.runId, siteDesignTokens: aggregateSiteDesignTokens(pageTokens) },
    );
    if (!wrote.ok) {
      // System-scoped op fed by our own aggregator — a rejection is a
      // real bug (schema drift), not an environment quirk. Fail the run
      // loudly (no-fallbacks pre-1.0) rather than composing a theme
      // from silently-dropped ground truth.
      throw new Error(`imports.set_run_design_tokens rejected: ${JSON.stringify(wrote.error)}`);
    }
  }

  return { captured, failed };
}
