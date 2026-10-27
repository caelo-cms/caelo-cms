// SPDX-License-Identifier: MPL-2.0

/**
 * #1155 — visitor op events as hints for the plugin-data build.
 *
 * When a visitor calls a plugin operation the plugin declares as a
 * baked-data trigger (plugin SDK `bakedData`, the operation is in its
 * `publicOperations`), the gateway records the one page id with the op
 * event in cms_public `gateway_plugin_op_events`. Everything in cms_public
 * is attacker-writable (#635, docs/dev/public-admin-boundary.md), so each
 * row is only a HINT:
 *
 *   - it is schema-checked, and a malformed row is dropped and reported;
 *   - it counts only for a plugin the admin runs that declares exactly
 *     that operation as a visitor trigger (`bakedDataVisitorTrigger`) —
 *     the operation's slug must be the plugin's own;
 *   - its page must be a main-line page that exists (`plugin_data.mark_pages`).
 *
 * A hint that passes only marks the page stale: the build then re-renders
 * that plugin's own bake regions from authoritative state. A forged hint
 * can at most cause a re-render that changes nothing; it never changes
 * cms_admin and never widens what a build may touch. At most
 * {@link MAX_EVENTS_PER_TICK} rows are read per tick, so a flood delays
 * hints but cannot stall the tick.
 *
 * The watermark logic is the one the removed redeploy orchestrator used
 * (#844): ids are taken at INSERT but become visible at commit, so the
 * watermark moves only through contiguous ids, past a gap only once the
 * row after it is settled, and never past the sequence's last value (an id
 * above it was not issued by the sequence, so it is forged).
 */

import { bakedDataVisitorTrigger } from "@caelo-cms/plugin-host";
import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { SYSTEM_ACTOR_ID } from "../audit.js";

const SYSTEM_CTX = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system" as const,
  requestId: "plugin-data-visitor-hints",
};

/** At most this many op events are read per tick. */
export const MAX_EVENTS_PER_TICK = 500;

/** How long an id gap may stay open before it counts as settled. */
const GAP_GRACE_SECONDS = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const visitorOpEvent = z.object({
  id: z.string().regex(/^\d{1,20}$/),
  plugin_id: z.string().regex(UUID_RE),
  operation: z.string().regex(/^[a-z][a-z0-9-]{0,63}\.[a-z_][a-z0-9_]{0,119}$/),
  succeeded: z.boolean(),
  page_id: z.string().regex(UUID_RE).nullable(),
});

/** A visitor op event that was not used as a hint, and why. */
export interface DroppedVisitorHint {
  readonly id: string | null;
  readonly operation: string | null;
  readonly reason: string;
}

/**
 * How far the watermark may move after reading `raw` (rows with `id >
 * after`, each carrying `settled`). Returns the rows it covers and the new
 * watermark (null when it does not move). Malformed rows inside the run
 * are covered too, so garbage cannot pin the watermark; the caller still
 * validates every row.
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
 * Turn validated-shape rows into hints: per plugin, the page ids of
 * events that name a declared visitor trigger of a plugin this admin runs.
 * Everything else is dropped with its reason.
 */
export function hintsFromEvents(
  raw: readonly unknown[],
  trigger: (pluginId: string, operation: string) => { slug: string } | null = (id, op) =>
    bakedDataVisitorTrigger(id, op),
): { byPlugin: Map<string, Set<string>>; dropped: DroppedVisitorHint[] } {
  const byPlugin = new Map<string, Set<string>>();
  const dropped: DroppedVisitorHint[] = [];
  for (const r of raw) {
    const parsed = visitorOpEvent.safeParse(r);
    const rec = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : null;
    const operation = typeof rec.operation === "string" ? rec.operation : null;
    if (!parsed.success) {
      dropped.push({
        id,
        operation,
        reason: parsed.error.issues
          .map((i) => `${i.path.join(".") || "row"}: ${i.message}`)
          .join("; "),
      });
      continue;
    }
    const e = parsed.data;
    // Most visitor events are not baked-data triggers at all (a submit to
    // a moderation inbox): no page id, nothing to drop or report.
    if (!e.succeeded || e.page_id === null) continue;
    const [slug, opName] = e.operation.split(".") as [string, string];
    const plugin = trigger(e.plugin_id, opName);
    if (!plugin || plugin.slug !== slug) {
      dropped.push({
        id,
        operation,
        reason: "not a baked-data trigger of a plugin this admin runs",
      });
      continue;
    }
    const pages = byPlugin.get(e.plugin_id) ?? new Set<string>();
    pages.add(e.page_id.toLowerCase());
    byPlugin.set(e.plugin_id, pages);
  }
  return { byPlugin, dropped };
}

/**
 * Read the visitor op events past the watermark, mark the pages their
 * valid hints name, then move the watermark. Returns how many pages were
 * marked and the dropped rows (each reported once: the watermark moves
 * past them).
 */
export async function ingestVisitorHints(
  adapter: DatabaseAdapter,
  registry: OperationRegistry,
): Promise<{ marked: number; dropped: DroppedVisitorHint[] }> {
  const stored = (await adapter.withAdminTransaction(
    SYSTEM_CTX,
    async (tx) =>
      await tx.execute(sql`
        SELECT visitor_event_watermark::text AS id FROM plugin_data_build_state WHERE id = 1`),
  )) as unknown as { id: string }[];
  const after = stored[0]?.id;
  if (after === undefined) {
    throw new Error(
      "plugin_data_build_state has no row — run the database migrations (0371 seeds it)",
    );
  }
  const { raw, sequenceLast } = await adapter.withPublicTransaction(SYSTEM_CTX, async (tx) => {
    const seq = (await tx.execute(
      sql`SELECT pg_sequence_last_value('gateway_plugin_op_events_id_seq'::regclass)::text AS last`,
    )) as unknown as { last: string | null }[];
    const found = (await tx.execute(sql`
      SELECT id::text AS id, plugin_id::text AS plugin_id, operation, succeeded,
             page_id::text AS page_id,
             created_at < now() - make_interval(secs => ${GAP_GRACE_SECONDS}) AS settled
      FROM gateway_plugin_op_events
      WHERE id > ${after}::bigint
      ORDER BY id ASC
      LIMIT ${MAX_EVENTS_PER_TICK}
    `)) as unknown as unknown[];
    return { raw: found, sequenceLast: seq[0]?.last ?? null };
  });
  const { covered, watermark } = advanceVisitorWatermark(raw, after, sequenceLast);
  if (watermark === null) return { marked: 0, dropped: [] };
  const { byPlugin, dropped } = hintsFromEvents(covered);
  let marked = 0;
  for (const [pluginId, pages] of byPlugin) {
    const ids = [...pages];
    for (let i = 0; i < ids.length; i += 1000) {
      const r = await execute(registry, adapter, SYSTEM_CTX, "plugin_data.mark_pages", {
        pluginId,
        pageIds: ids.slice(i, i + 1000),
        source: "visitor",
      });
      // A failed mark leaves the watermark where it was: the next tick
      // reads the same events again (marking is idempotent).
      if (!r.ok) throw new Error(`plugin_data.mark_pages failed: ${JSON.stringify(r.error)}`);
      marked += (r.value as { marked: number }).marked;
    }
  }
  await adapter.withAdminTransaction(SYSTEM_CTX, async (tx) => {
    await tx.execute(sql`
      UPDATE plugin_data_build_state SET visitor_event_watermark = ${watermark}::bigint WHERE id = 1
    `);
  });
  for (const d of dropped) {
    console.warn(
      `[plugin-data] ignored visitor op event id=${d.id ?? "?"} op=${d.operation ?? "?"}: ${d.reason}`,
    );
  }
  return { marked, dropped };
}
