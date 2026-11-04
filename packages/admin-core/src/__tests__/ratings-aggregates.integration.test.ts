// SPDX-License-Identifier: MPL-2.0

/**
 * #1333 (epic #763 E10) — votes are an inbox, averages are published.
 *
 * - The visitor roles may only add votes: no read, change or delete of a
 *   vote, and no write at all on `rating_aggregates`.
 * - The recompute runs on the admin's scheduler (the plugin's worker,
 *   `publicDatabases: "each"`), once per public database: the live
 *   averages come from live votes only, the staging averages from staging
 *   votes only, so staging test votes never reach live.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import consentPlugin from "@caelo-cms/plugin-consent-manager";
import { bootstrap, pluginWorkerScheduler, resetPluginHost } from "@caelo-cms/plugin-host";
import ratingsPlugin from "@caelo-cms/plugin-ratings";
import {
  LIVE_PUBLIC_GRANT_TARGET,
  STAGING_PUBLIC_GRANT_TARGET,
  schemaFromSpec,
} from "@caelo-cms/plugin-sandbox";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { stagingPublicAdapter } from "../public-projection.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const PUBLIC_ROLE_URL = process.env.PUBLIC_DATABASE_URL;
const STAGING_ADMIN_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
const STAGING_ROLE_URL = process.env.PUBLIC_STAGING_DATABASE_URL;
if (
  !ADMIN_URL ||
  !PUBLIC_ADMIN_URL ||
  !PUBLIC_ROLE_URL ||
  !STAGING_ADMIN_URL ||
  !STAGING_ROLE_URL
) {
  throw new Error("DB URLs required");
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUGS = ["consent-manager", "ratings"];

setDefaultTimeout(60_000);

let adapter: DatabaseAdapter;
let staging: DatabaseAdapter;
let registry: OperationRegistry;
let ratingsId = "";

async function onDb<T>(url: string, fn: (tx: SQL) => Promise<T>, pluginId?: string): Promise<T> {
  const sql = new SQL(url);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      if (pluginId) await tx`SELECT set_config('caelo.plugin_id', ${pluginId}, true)`;
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  resetPluginHost();
  await onDb(ADMIN_URL as string, async (tx) => {
    for (const s of SLUGS) {
      await tx`DELETE FROM audit_events WHERE actor_id IN (SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${s}))`;
      await tx`DELETE FROM site_snapshots WHERE actor_id IN (SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${s}))`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${s})`;
      await tx`DELETE FROM plugin_schema_migrations WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${s})`;
      await tx`DELETE FROM plugins WHERE slug = ${s}`;
      await tx.unsafe(`DROP SCHEMA IF EXISTS "plugin_${s.replace(/-/g, "_")}" CASCADE`);
    }
  });
  for (const url of [PUBLIC_ADMIN_URL, STAGING_ADMIN_URL] as string[]) {
    const sql = new SQL(url);
    try {
      for (const s of SLUGS) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "plugin_${s.replace(/-/g, "_")}" CASCADE`);
      }
    } finally {
      await sql.end();
    }
  }
}

/** Add a vote the way a (possibly compromised) gateway can: as its visitor role. */
async function voteAsVisitor(url: string, pageId: string, visitorId: string | null, score: number) {
  const sql = new SQL(url);
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('caelo.plugin_id', ${ratingsId}, true)`;
      await tx`INSERT INTO plugin_ratings.ratings (id, page_id, visitor_id, score)
               VALUES (gen_random_uuid(), ${pageId}, ${visitorId}, ${score})`;
    });
  } finally {
    await sql.end();
  }
}

async function aggregates(
  url: string,
): Promise<Array<{ page_id: string; count: number; sum: number }>> {
  return onDb(
    url,
    async (tx) =>
      (await tx`SELECT page_id, count, sum FROM plugin_ratings.rating_aggregates ORDER BY page_id`) as Array<{
        page_id: string;
        count: number;
        sum: number;
      }>,
    ratingsId,
  );
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  staging = stagingPublicAdapter(STAGING_ADMIN_URL as string);
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const boot = await bootstrap({
    infra: { adapter, registry, stagingAdapter: staging },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: consentPlugin }, { definition: ratingsPlugin }],
  });
  expect(boot.failed.filter((f) => f.slug === "ratings")).toEqual([]);
  ratingsId = (
    await onDb(
      ADMIN_URL as string,
      async (tx) =>
        (await tx`SELECT id::text AS id FROM plugins WHERE slug = 'ratings'`) as { id: string }[],
    )
  )[0]?.id as string;
  for (const [db, target] of [
    [adapter, LIVE_PUBLIC_GRANT_TARGET],
    [staging, STAGING_PUBLIC_GRANT_TARGET],
  ] as const) {
    const emitted = schemaFromSpec({
      pluginId: ratingsId,
      slug: "ratings",
      schema: ratingsPlugin.schema,
      indexes: ratingsPlugin.indexes?.schema,
      tableKinds: ratingsPlugin.tableKinds,
      target,
    });
    await db.provisionPluginPublicSchema({ pluginId: ratingsId, sql: emitted.sql });
  }
});

afterAll(async () => {
  await wipe();
  await adapter.close();
  await staging.close();
});

describe("ratings: votes are an inbox, averages published (#1333)", () => {
  for (const [label, url] of [
    ["live", PUBLIC_ROLE_URL],
    ["staging", STAGING_ROLE_URL],
  ] as const) {
    it(`${label}: the visitor role can add a vote and nothing else`, async () => {
      await voteAsVisitor(url as string, "probe", null, 3);
      const sql = new SQL(url as string);
      try {
        for (const stmt of [
          "SELECT * FROM plugin_ratings.ratings",
          "UPDATE plugin_ratings.ratings SET score = 5",
          "DELETE FROM plugin_ratings.ratings",
          "INSERT INTO plugin_ratings.rating_aggregates (page_id, count, sum, average) VALUES ('x', 1000, 5000, 500)",
          "UPDATE plugin_ratings.rating_aggregates SET average = 500",
          "DELETE FROM plugin_ratings.rating_aggregates",
        ]) {
          await expect(
            sql.begin(async (tx) => {
              await tx`SELECT set_config('caelo.plugin_id', ${ratingsId}, true)`;
              await tx.unsafe(stmt);
            }),
          ).rejects.toThrow(/permission denied/);
        }
      } finally {
        await sql.end();
      }
    });
  }

  it("the scheduler's recompute publishes each environment's averages from its own votes", async () => {
    for (const url of [PUBLIC_ADMIN_URL, STAGING_ADMIN_URL] as string[]) {
      await onDb(url, (tx) => tx`DELETE FROM plugin_ratings.ratings`, ratingsId);
    }
    await voteAsVisitor(PUBLIC_ROLE_URL as string, "page-a", "visitor-1", 2);
    await voteAsVisitor(PUBLIC_ROLE_URL as string, "page-a", "visitor-1", 4); // replaces 2
    await voteAsVisitor(PUBLIC_ROLE_URL as string, "page-a", null, 5);
    // Staging test votes, on the same page id.
    await voteAsVisitor(STAGING_ROLE_URL as string, "page-a", null, 1);
    await voteAsVisitor(STAGING_ROLE_URL as string, "page-b", null, 1);

    const worker = pluginWorkerScheduler
      .list()
      .find((w) => w.pluginSlug === "ratings" && w.workerName === "refresh_aggregates");
    if (!worker) throw new Error("the ratings worker is not registered with the scheduler");
    await worker.run();

    expect(await aggregates(PUBLIC_ADMIN_URL as string)).toEqual([
      { page_id: "page-a", count: 2, sum: 9 },
    ]);
    expect(await aggregates(STAGING_ADMIN_URL as string)).toEqual([
      { page_id: "page-a", count: 1, sum: 1 },
      { page_id: "page-b", count: 1, sum: 1 },
    ]);
    // The superseded live vote was pruned; nothing moved between databases.
    const liveVotes = await onDb(
      PUBLIC_ADMIN_URL as string,
      async (tx) =>
        (await tx`SELECT score FROM plugin_ratings.ratings WHERE page_id = 'page-a' ORDER BY score`) as {
          score: number;
        }[],
      ratingsId,
    );
    expect(liveVotes.map((v) => v.score)).toEqual([4, 5]);
  });
});
