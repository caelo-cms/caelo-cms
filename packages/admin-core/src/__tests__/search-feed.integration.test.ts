// SPDX-License-Identifier: MPL-2.0

/**
 * The live record per page and the search engine notifications
 * (docs/dev/search-engine-feed.md), on real Postgres:
 *
 *   - a Stage's changes become the live record with its Publish live;
 *   - when the record moved between the Stage and its Publish live, the
 *     state the build ships is rebuilt and compared with what is live now;
 *   - a rollback restores the state the restored run made live;
 *   - a production run queues a WebSub ping when the feed changed and an
 *     IndexNow submission of every changed URL, skipped with the reason for
 *     a site search engines cannot reach;
 *   - the sender records each engine's answer: sent, retried with backoff,
 *     failed, given up after the last attempt.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  DatabaseAdapter,
  execute,
  OperationRegistry,
  SYSTEM_ACTOR_ID,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import type { BuildSearchFeed, PageChange } from "@caelo-cms/shared";
import { SQL } from "bun";
import {
  claimSearchNotificationsOp,
  recordSearchNotificationOp,
  SEARCH_NOTIFY_MAX_ATTEMPTS,
} from "../ops/search-notifications.js";
import {
  applyLiveChanges,
  applyPluginDataChanges,
  applyStagedRun,
  liveVersionsHead,
  recordStagedChanges,
  restoreLiveVersions,
} from "../search-feed/live-versions.js";
import { queueSearchNotifications } from "../search-feed/notifications.js";
import { type SearchNotifyFetch, sendSearchNotifications } from "../search-feed/notify.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system" as const,
  requestId: "search-feed-test",
};
const BASE = "https://feed.example.org";
const FEED = `${BASE}/feed.xml`;
const KEY = "0123456789abcdef0123456789abcdef";
const FP = (c: string) => c.repeat(64);
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const P3 = "33333333-3333-4333-8333-333333333333";
const url = (id: string) => `${BASE}/${id.slice(0, 4)}/`;

let adapter: DatabaseAdapter;
const registry = new OperationRegistry();
registry.register(claimSearchNotificationsOp);
registry.register(recordSearchNotificationOp);
let savedBaseUrl: string | null = null;
const runs: string[] = [];

async function admin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

const inTx = <T>(fn: (tx: TransactionRunner) => Promise<T>): Promise<T> =>
  adapter.withAdminTransaction(SYSTEM, fn);

/** A succeeded run on `target`, started at `startedAt`. */
async function run(target: "staging" | "production", startedAt: string): Promise<string> {
  const id = crypto.randomUUID();
  runs.push(id);
  await admin(
    (tx) => tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, started_at, finished_at)
               SELECT ${id}::uuid, id, ${SYSTEM_ACTOR_ID}::uuid, 'succeeded', ${startedAt}::timestamptz,
                      ${startedAt}::timestamptz
               FROM deploy_targets WHERE name = ${target}`,
  );
  return id;
}

function change(pageId: string, over: Partial<PageChange>): PageChange {
  return {
    pageId,
    kind: "changed",
    url: url(pageId),
    fingerprint: FP("a"),
    pluginFingerprint: null,
    title: `Page ${pageId.slice(0, 4)}`,
    summary: "",
    prevUrl: url(pageId),
    changedAt: "2026-11-20T10:00:00.000Z",
    ...over,
  };
}

function feed(base: number | null, changes: PageChange[]): BuildSearchFeed {
  return { base, changes, feedUrl: FEED, indexNowKey: KEY };
}

async function head(): Promise<number | null> {
  const [r] = (await admin((tx) => tx`SELECT max(id)::text AS h FROM live_page_versions`)) as {
    h: string | null;
  }[];
  return r?.h === null || r?.h === undefined ? null : Number(r.h);
}

/** The live state per page: its newest row. */
async function live(): Promise<Record<string, { url: string | null; fp: string | null }>> {
  const rows = (await admin(
    (tx) => tx`SELECT DISTINCT ON (page_id) page_id::text AS page_id, url, fingerprint
               FROM live_page_versions ORDER BY page_id, id DESC`,
  )) as { page_id: string; url: string | null; fingerprint: string | null }[];
  return Object.fromEntries(rows.map((r) => [r.page_id, { url: r.url, fp: r.fingerprint }]));
}

async function rowsOf(runId: string) {
  return (await admin(
    (tx) => tx`SELECT page_id::text AS page_id, kind, url, prev_url FROM live_page_versions
               WHERE run_id = ${runId}::uuid ORDER BY page_id`,
  )) as { page_id: string; kind: string; url: string | null; prev_url: string | null }[];
}

async function notifications(runId: string) {
  return (await admin(
    (tx) => tx`SELECT channel, status, url_count, attempts, detail, response_status,
                      next_attempt_at > clock_timestamp() AS later
               FROM search_engine_notifications WHERE run_id = ${runId}::uuid ORDER BY channel`,
  )) as {
    channel: string;
    status: string;
    url_count: number;
    attempts: number;
    detail: string | null;
    response_status: number | null;
    later: boolean | null;
  }[];
}

/** Publish `changes` live as a production run of their own; returns the run. */
async function publish(changes: PageChange[], startedAt: string): Promise<string> {
  const prod = await run("production", startedAt);
  await inTx(async (tx) => {
    const { announced } = await applyLiveChanges(tx, {
      runId: prod,
      feed: feed(await liveVersionsHead(tx), changes),
      shippedAt: startedAt,
    });
    await queueSearchNotifications(tx, { runId: prod, announced });
  });
  return prod;
}

/** Notifications are sent in this block (the preload switches them off for the suite). */
async function withNotificationsOn<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env.CAELO_SEARCH_NOTIFY;
  delete process.env.CAELO_SEARCH_NOTIFY;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.CAELO_SEARCH_NOTIFY;
    else process.env.CAELO_SEARCH_NOTIFY = before;
  }
}

/** A fetch that records each request and answers per host. */
function fakeEngines(answer: (host: string) => number | Error) {
  const sent: { url: string; body: string }[] = [];
  const fetchImpl: SearchNotifyFetch = async (u, init) => {
    sent.push({ url: u, body: init.body });
    const a = answer(new URL(u).host);
    if (a instanceof Error) throw a;
    return {
      status: a,
      headers: { get: () => null },
      text: async () => (a >= 400 ? "refused" : ""),
    };
  };
  return { sent, fetchImpl };
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  savedBaseUrl = await admin(async (tx) => {
    const [r] = (await tx`SELECT site_base_url FROM site_defaults WHERE id = 1`) as {
      site_base_url: string | null;
    }[];
    return r?.site_base_url ?? null;
  });
});

beforeEach(async () => {
  await admin(async (tx) => {
    await tx`DELETE FROM search_engine_notifications`;
    await tx`DELETE FROM staged_page_changes`;
    await tx`DELETE FROM live_page_versions`;
    await tx`UPDATE site_defaults SET site_base_url = ${BASE} WHERE id = 1`;
  });
});

afterAll(async () => {
  await admin(async (tx) => {
    await tx`DELETE FROM search_engine_notifications`;
    await tx`DELETE FROM staged_page_changes`;
    await tx`DELETE FROM live_page_versions`;
    await tx`DELETE FROM deploy_runs WHERE id = ANY(${runs}::uuid[])`;
    await tx`UPDATE site_defaults SET site_base_url = ${savedBaseUrl} WHERE id = 1`;
  });
  await adapter.close();
});

describe("the live record", () => {
  it("a Stage's changes go live with its Publish live, and only the baseline stays unannounced", async () => {
    const stage = await run("staging", "2026-11-20T09:00:00Z");
    const staged = feed(null, [
      change(P1, { kind: "baseline", prevUrl: null, changedAt: "2026-10-01T00:00:00.000Z" }),
      change(P2, { kind: "added", prevUrl: null }),
    ]);
    const target = (await admin(
      (tx) => tx`SELECT target_id::text AS t FROM deploy_runs WHERE id = ${stage}::uuid`,
    )) as { t: string }[];
    await inTx((tx) =>
      recordStagedChanges(tx, { runId: stage, targetId: target[0]?.t ?? "", feed: staged }),
    );
    const prod = await run("production", "2026-11-20T10:00:00Z");
    const { announced } = await inTx((tx) =>
      applyStagedRun(tx, { runId: prod, fromRunId: stage, shippedAt: "2026-11-20T09:00:00Z" }),
    );
    expect(announced).toBe(1);
    expect((await rowsOf(prod)).map((r) => [r.page_id, r.kind])).toEqual([
      [P1, "baseline"],
      [P2, "added"],
    ]);
    const [stamped] = (await admin(
      (tx) => tx`SELECT live_versions_head::text AS h, feed_url, indexnow_key
                 FROM deploy_runs WHERE id = ${prod}::uuid`,
    )) as { h: string; feed_url: string; indexnow_key: string }[];
    expect(Number(stamped?.h)).toBe(await head());
    expect(stamped?.feed_url).toBe(FEED);
    expect(stamped?.indexnow_key).toBe(KEY);
  });

  it("rebuilds the shipped state when the record moved since the Stage", async () => {
    await publish(
      [change(P1, { kind: "added", prevUrl: null }), change(P2, { kind: "added", prevUrl: null })],
      "2026-11-20T08:00:00Z",
    );
    const stagedBase = await head();
    // The Stage changed P1 only.
    const staged = feed(stagedBase, [change(P1, { fingerprint: FP("b") })]);
    // An Owner's production build changed P2 in between.
    await publish([change(P2, { fingerprint: FP("c") })], "2026-11-20T09:00:00Z");
    const prod = await run("production", "2026-11-20T10:00:00Z");
    await inTx((tx) =>
      applyLiveChanges(tx, { runId: prod, feed: staged, shippedAt: "2026-11-20T09:30:00Z" }),
    );
    // P1 takes the Stage's change; P2 goes back to what the Stage shipped.
    expect(await live()).toEqual({
      [P1]: { url: url(P1), fp: FP("b") },
      [P2]: { url: url(P2), fp: FP("a") },
    });
    expect((await rowsOf(prod)).map((r) => [r.page_id, r.kind])).toEqual([
      [P1, "changed"],
      [P2, "changed"],
    ]);
    // P1 carries the Stage's date for its change; P2, which the Stage left as
    // it was, the date the shipped feed and sitemap show for it.
    const dates = (await admin(
      (tx) => tx`SELECT page_id::text AS page_id, changed_at FROM live_page_versions
                 WHERE run_id = ${prod}::uuid ORDER BY page_id`,
    )) as { page_id: string; changed_at: Date }[];
    expect(dates.map((d) => [d.page_id, d.changed_at.toISOString()])).toEqual([
      [P1, "2026-11-20T10:00:00.000Z"],
      [P2, "2026-11-20T10:00:00.000Z"],
    ]);
  });

  it("a rollback restores the state the restored run made live, and announces it", async () => {
    const first = await publish(
      [change(P1, { kind: "added", prevUrl: null })],
      "2026-11-20T08:00:00Z",
    );
    await publish(
      [change(P1, { fingerprint: FP("b") }), change(P3, { kind: "added", prevUrl: null })],
      "2026-11-20T09:00:00Z",
    );
    const rollback = await run("production", "2026-11-20T10:00:00Z");
    const restored = await inTx(async (tx) => {
      const r = await restoreLiveVersions(tx, {
        runId: rollback,
        restoredRunId: first,
        at: "2026-11-20T10:00:00.000Z",
      });
      await queueSearchNotifications(tx, { runId: rollback, announced: r.announced });
      return r;
    });
    expect(restored).toEqual({ announced: 2, restorable: true });
    expect(await live()).toEqual({
      [P1]: { url: url(P1), fp: FP("a") },
      [P3]: { url: null, fp: null },
    });
    expect(await rowsOf(rollback)).toEqual([
      { page_id: P1, kind: "restored", url: url(P1), prev_url: url(P1) },
      { page_id: P3, kind: "removed", url: null, prev_url: url(P3) },
    ]);
    // The restored page carries the date the restored build's own feed and
    // sitemap show; the removal is dated with the rollback.
    const dates = (await admin(
      (tx) => tx`SELECT page_id::text AS page_id, changed_at FROM live_page_versions
                 WHERE run_id = ${rollback}::uuid ORDER BY page_id`,
    )) as { page_id: string; changed_at: Date }[];
    expect(dates.map((d) => [d.page_id, d.changed_at.toISOString()])).toEqual([
      [P1, "2026-11-20T10:00:00.000Z"],
      [P3, "2026-11-20T10:00:00.000Z"],
    ]);
  });

  it("a Publish live of a Stage from before the record removes nothing", async () => {
    await publish([change(P1, { kind: "added", prevUrl: null })], "2026-11-20T08:00:00Z");
    const before = await head();
    // Staged before the update: no rows, never marked recorded.
    const oldStage = await run("staging", "2026-11-19T08:00:00Z");
    const prod = await run("production", "2026-11-20T10:00:00Z");
    const r = await inTx((tx) =>
      applyStagedRun(tx, { runId: prod, fromRunId: oldStage, shippedAt: "2026-11-19T08:00:00Z" }),
    );
    expect(r).toEqual({ announced: 0 });
    expect(await head()).toBe(before);
    expect(await live()).toEqual({ [P1]: { url: url(P1), fp: FP("a") } });
  });

  it("a plugin-data release records the pages whose baked content changed, and only those", async () => {
    const first = await publish(
      [
        change(P1, { kind: "added", prevUrl: null, pluginFingerprint: FP("c") }),
        change(P2, { kind: "added", prevUrl: null, pluginFingerprint: FP("c") }),
      ],
      "2026-11-20T08:00:00Z",
    );
    const refresh = crypto.randomUUID();
    runs.push(refresh);
    await admin(
      (
        tx,
      ) => tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, started_at, build_kind, base_run_id)
                 SELECT ${refresh}::uuid, id, ${SYSTEM_ACTOR_ID}::uuid, 'succeeded',
                        '2026-11-20T08:30:00Z'::timestamptz, 'plugin_data', ${first}::uuid
                 FROM deploy_targets WHERE name = 'production'`,
    );
    // P1 got a new comment; P2 was re-baked with the same comments; P3 is
    // not live in the record.
    const { announced } = await inTx((tx) =>
      applyPluginDataChanges(tx, {
        runId: refresh,
        digests: [
          { pageId: P1, pluginFingerprint: FP("d") },
          { pageId: P2, pluginFingerprint: FP("c") },
          { pageId: P3, pluginFingerprint: FP("d") },
        ],
        changedAt: "2026-11-20T08:30:00.000Z",
      }),
    );
    expect(announced).toBe(1);
    expect(await rowsOf(refresh)).toEqual([
      { page_id: P1, kind: "changed", url: url(P1), prev_url: url(P1) },
    ]);
    const [stamped] = (await admin(
      (tx) => tx`SELECT live_versions_head::text AS h, feed_url, indexnow_key
                 FROM deploy_runs WHERE id = ${refresh}::uuid`,
    )) as { h: string; feed_url: string; indexnow_key: string }[];
    expect({ ...stamped, h: Number(stamped?.h) }).toEqual({
      h: (await head()) ?? -1,
      feed_url: FEED,
      indexnow_key: KEY,
    });
    // A rollback to the release before it restores the earlier comments.
    const rollback = await run("production", "2026-11-20T09:00:00Z");
    const r = await inTx((tx) =>
      restoreLiveVersions(tx, {
        runId: rollback,
        restoredRunId: first,
        at: "2026-11-20T09:00:00.000Z",
      }),
    );
    expect(r).toEqual({ announced: 1, restorable: true });
  });

  it("a rollback to a build from before the record appends nothing", async () => {
    const old = await run("production", "2026-11-19T08:00:00Z");
    await publish([change(P1, { kind: "added", prevUrl: null })], "2026-11-20T08:00:00Z");
    const before = await head();
    const rollback = await run("production", "2026-11-20T10:00:00Z");
    const r = await inTx((tx) =>
      restoreLiveVersions(tx, { runId: rollback, restoredRunId: old, at: "2026-11-20T10:00:00Z" }),
    );
    expect(r).toEqual({ announced: 0, restorable: false });
    expect(await head()).toBe(before);
  });

  it("a Stage keeps only its own rows and the newest Stage's before it", async () => {
    const target = (
      (await admin(
        (tx) => tx`SELECT id::text AS id FROM deploy_targets WHERE name = 'staging'`,
      )) as { id: string }[]
    )[0]?.id as string;
    // Later than every other run of this file: the newest Stages are these.
    const stages = [
      await run("staging", "2026-12-01T07:00:00Z"),
      await run("staging", "2026-12-01T08:00:00Z"),
      await run("staging", "2026-12-01T09:00:00Z"),
    ];
    for (const s of stages) {
      await inTx((tx) =>
        recordStagedChanges(tx, {
          runId: s,
          targetId: target,
          feed: feed(null, [change(P1, { kind: "added", prevUrl: null })]),
        }),
      );
    }
    const kept = (await admin(
      (tx) => tx`SELECT DISTINCT run_id::text AS r FROM staged_page_changes ORDER BY 1`,
    )) as { r: string }[];
    expect(kept.map((k) => k.r).sort()).toEqual([stages[1], stages[2]].sort());
  });
});

describe("the notifications", () => {
  it("are skipped with the reason while they are off on the install", async () => {
    process.env.CAELO_SEARCH_NOTIFY = "off";
    const prod = await publish(
      [change(P1, { kind: "added", prevUrl: null })],
      "2026-11-20T08:00:00Z",
    );
    const rows = await notifications(prod);
    expect(rows.map((r) => [r.channel, r.status])).toEqual([
      ["indexnow", "skipped"],
      ["websub", "skipped"],
    ]);
    expect(rows[0]?.detail).toContain("CAELO_SEARCH_NOTIFY=off");
  });

  it("are skipped for a site address search engines cannot reach", async () => {
    await admin(
      (tx) => tx`UPDATE site_defaults SET site_base_url = 'http://localhost:4321' WHERE id = 1`,
    );
    const prod = await withNotificationsOn(() =>
      publish([change(P1, { kind: "added", prevUrl: null })], "2026-11-20T08:00:00Z"),
    );
    const rows = await notifications(prod);
    expect(rows.every((r) => r.status === "skipped")).toBe(true);
    expect(rows[0]?.detail).toContain("cannot be reached from the internet");
  });

  it("queue a ping when the feed changed and every changed URL for IndexNow", async () => {
    const first = await withNotificationsOn(() =>
      publish(
        [
          change(P1, { kind: "added", prevUrl: null }),
          change(P2, { kind: "added", prevUrl: null }),
        ],
        "2026-11-20T08:00:00Z",
      ),
    );
    expect((await notifications(first)).map((r) => [r.channel, r.status, r.url_count])).toEqual([
      ["indexnow", "pending", 2],
      ["websub", "pending", 1],
    ]);
    // A move announces the new and the old URL; the newer ping replaces the
    // older one still waiting.
    const moved = await withNotificationsOn(() =>
      publish([change(P1, { kind: "moved", url: `${BASE}/moved/` })], "2026-11-20T09:00:00Z"),
    );
    expect((await notifications(moved)).map((r) => [r.channel, r.url_count])).toEqual([
      ["indexnow", 2],
      ["websub", 1],
    ]);
    expect((await notifications(first)).find((r) => r.channel === "websub")?.status).toBe(
      "skipped",
    );
    // Nothing announced and the same feed as before: nothing to send.
    const quiet = await withNotificationsOn(() => publish([], "2026-11-20T10:00:00Z"));
    expect(await notifications(quiet)).toEqual([]);
  });

  it("the sender records each answer: sent, retried later, failed", async () => {
    const prod = await withNotificationsOn(() =>
      publish(
        [
          change(P1, { kind: "added", prevUrl: null }),
          change(P2, {
            kind: "removed",
            url: null,
            fingerprint: null,
            title: null,
            summary: null,
            prevUrl: url(P2),
          }),
        ],
        "2026-11-20T08:00:00Z",
      ),
    );
    const engines = fakeEngines((host) => (host === "pubsubhubbub.appspot.com" ? 204 : 202));
    expect(
      await withNotificationsOn(() =>
        sendSearchNotifications({ adapter, registry, runId: prod, fetch: engines.fetchImpl }),
      ),
    ).toEqual({ sent: 2, retrying: 0, failed: 0 });
    const indexNow = engines.sent.find((s) => s.url.includes("indexnow"));
    expect(JSON.parse(indexNow?.body ?? "{}")).toEqual({
      host: "feed.example.org",
      key: KEY,
      keyLocation: `${BASE}/${KEY}.txt`,
      urlList: [url(P1), url(P2)].sort(),
    });
    expect(engines.sent.find((s) => s.url.includes("pubsubhubbub"))?.body).toBe(
      `hub.mode=publish&hub.url=${encodeURIComponent(FEED)}`,
    );
    expect(
      (await notifications(prod)).map((r) => [r.channel, r.status, r.response_status]),
    ).toEqual([
      ["indexnow", "sent", 202],
      ["websub", "sent", 204],
    ]);
  });

  it("retries a passing error later and fails a refusal at once", async () => {
    const prod = await withNotificationsOn(() =>
      publish([change(P1, { kind: "added", prevUrl: null })], "2026-11-20T08:00:00Z"),
    );
    const engines = fakeEngines((host) => (host === "pubsubhubbub.appspot.com" ? 503 : 403));
    expect(
      await withNotificationsOn(() =>
        sendSearchNotifications({ adapter, registry, runId: prod, fetch: engines.fetchImpl }),
      ),
    ).toEqual({ sent: 0, retrying: 1, failed: 1 });
    const rows = await notifications(prod);
    expect(rows.map((r) => [r.channel, r.status, r.attempts, r.later])).toEqual([
      ["indexnow", "failed", 1, null],
      ["websub", "pending", 1, true],
    ]);
    expect(rows[0]?.detail).toContain("answered 403: refused");
    // Not due yet: a second send right away claims nothing.
    expect(
      await withNotificationsOn(() =>
        sendSearchNotifications({ adapter, registry, runId: prod, fetch: engines.fetchImpl }),
      ),
    ).toEqual({ sent: 0, retrying: 0, failed: 0 });
  });

  it("gives up after the last attempt", async () => {
    const prod = await withNotificationsOn(() =>
      publish([change(P1, { kind: "added", prevUrl: null })], "2026-11-20T08:00:00Z"),
    );
    await admin(
      (tx) => tx`UPDATE search_engine_notifications SET attempts = ${SEARCH_NOTIFY_MAX_ATTEMPTS - 1}
                 WHERE run_id = ${prod}::uuid AND channel = 'websub'`,
    );
    await admin(
      (tx) => tx`UPDATE search_engine_notifications SET status = 'skipped', next_attempt_at = NULL,
                   finished_at = clock_timestamp()
                 WHERE run_id = ${prod}::uuid AND channel = 'indexnow'`,
    );
    const engines = fakeEngines(() => new Error("connect ETIMEDOUT"));
    expect(
      await withNotificationsOn(() =>
        sendSearchNotifications({ adapter, registry, runId: prod, fetch: engines.fetchImpl }),
      ),
    ).toEqual({ sent: 0, retrying: 0, failed: 1 });
    const websub = (await notifications(prod)).find((r) => r.channel === "websub");
    expect(websub?.status).toBe("failed");
    expect(websub?.detail).toContain(`given up after ${SEARCH_NOTIFY_MAX_ATTEMPTS} attempts`);
    expect(websub?.detail).toContain("did not answer: connect ETIMEDOUT");
  });

  it("while they are off on the install, the sender sends nothing and marks what is due skipped", async () => {
    const prod = await withNotificationsOn(() =>
      publish([change(P1, { kind: "added", prevUrl: null })], "2026-11-20T08:00:00Z"),
    );
    process.env.CAELO_SEARCH_NOTIFY = "off";
    const engines = fakeEngines(() => 202);
    expect(
      await sendSearchNotifications({ adapter, registry, runId: prod, fetch: engines.fetchImpl }),
    ).toEqual({ sent: 0, retrying: 0, failed: 0 });
    expect(engines.sent).toEqual([]);
    const rows = await notifications(prod);
    expect(rows.map((r) => r.status)).toEqual(["skipped", "skipped"]);
    expect(rows[0]?.detail).toContain("CAELO_SEARCH_NOTIFY=off");
  });

  it("a late answer for a ping a newer Publish live replaced leaves it skipped", async () => {
    const first = await withNotificationsOn(() =>
      publish([change(P1, { kind: "added", prevUrl: null })], "2026-11-20T08:00:00Z"),
    );
    // The first ping is in flight...
    const claimed = await execute(registry, adapter, SYSTEM, "search_notify.claim", {
      runId: first,
      limit: 20,
    });
    expect(claimed.ok).toBe(true);
    const websub = (
      claimed.ok ? (claimed.value as { claimed: { id: string; channel: string }[] }).claimed : []
    ).find((n) => n.channel === "websub");
    // ...when the next Publish live replaces it...
    await withNotificationsOn(() =>
      publish([change(P1, { fingerprint: FP("b") })], "2026-11-20T09:00:00Z"),
    );
    // ...and then the hub answers 503.
    const late = await execute(registry, adapter, SYSTEM, "search_notify.record", {
      id: websub?.id ?? "",
      outcome: "retry",
      responseStatus: 503,
      detail: "the WebSub hub answered 503",
      retryAfterSeconds: null,
    });
    expect(late.ok && (late.value as { status: string }).status).toBe("skipped");
    const row = (await notifications(first)).find((r) => r.channel === "websub");
    expect(row?.status).toBe("skipped");
    expect(row?.detail).toContain("a later Publish live");
  });
});
