// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1329 (epic #763 E10, fixes N6) — the two-target projection,
 * frozen per Stage, against both real public databases:
 *
 *   - a staged plugin change never reaches the live database before the
 *     live pointer moves (Publish live); staging serves the state its Stage
 *     froze; a rollback restores the state of the build it puts back;
 *   - narrowing (a deactivated plugin, a revoked grant) reaches both at once;
 *   - each environment gets its own cookie secret — the two databases share
 *     none;
 *   - redirects reach the staging database through the projection only;
 *   - a team post is published to both, never through the inbox;
 *   - the staging inbox is cleared, the live one and visitor state are not.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  freezeRelease,
  pointLiveRelease,
  pointStagingRelease,
  ReleaseFreezeError,
} from "@caelo-cms/migrations/public-projection";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { commentArchivePostTeamOp } from "../ops/plugins/comment_archive.js";
import {
  drainProjectionOnce,
  publishProjectionOnce,
  stagingPublicAdapter,
} from "../public-projection.js";
import { clearStagingInbox } from "../stage/staging-inbox.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const STAGING_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL || !STAGING_URL) throw new Error("DB URLs required");

const SLUG = "t1329-rel";
const SCHEMA = "plugin_t1329_rel";
const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const DIGEST = "d".repeat(64);
const DECLARATIONS = new Map([[SLUG, { cfg: ["label"] }]]);

let adapter: DatabaseAdapter;
let staging: DatabaseAdapter;
let pluginId = "";
let pageId = "";

async function onDb<T>(url: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const client = new SQL(url);
  try {
    return (await client.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx.unsafe(`SELECT set_config('caelo.actor_id', '${SYSTEM_ID}', true)`);
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await client.end();
  }
}
const admin = <T>(fn: (tx: SQL) => Promise<T>) => onDb(ADMIN_URL as string, fn);
const live = <T>(fn: (tx: SQL) => Promise<T>) => onDb(PUBLIC_URL as string, fn);
const stagingDb = <T>(fn: (tx: SQL) => Promise<T>) => onDb(STAGING_URL as string, fn);

const SYSTEM = { actorId: SYSTEM_ID, actorKind: "system" as const, requestId: "t1329" };

/** Freeze the main line under a new run id and return it (what deploy.start_trigger does). */
async function freeze(): Promise<string> {
  const runId = crypto.randomUUID();
  await adapter.withAdminTransaction(SYSTEM, (tx) =>
    freezeRelease(tx, {
      runId,
      reason: "stage",
      declarations: DECLARATIONS,
      completeness: "required",
    }),
  );
  return runId;
}

async function point(env: "live" | "staging", runId: string): Promise<void> {
  await adapter.withAdminTransaction(SYSTEM, (tx) =>
    env === "live" ? pointLiveRelease(tx, runId) : pointStagingRelease(tx, runId),
  );
  await drainProjectionOnce(adapter, staging);
}

/** The plugin's published `label` in one public database. */
async function label(db: typeof live): Promise<string | null> {
  const rows = (await db(
    async (tx) =>
      await tx`SELECT row->>'label' AS label FROM published_plugin_rows
               WHERE plugin_id = ${pluginId}::uuid`,
  )) as { label: string }[];
  return rows[0]?.label ?? null;
}

async function setLabel(value: string): Promise<void> {
  await admin(async (tx) => {
    await tx.unsafe(`UPDATE "${SCHEMA}".cfg SET label = '${value}'`);
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  staging = stagingPublicAdapter(STAGING_URL);
  pluginId = await admin(async (tx) => {
    const [plugin] = (await tx`
      INSERT INTO plugins (slug, version, tier, status, manifest_json, source_code, submitted_by)
      VALUES (${SLUG}, '1.0.0', 2, 'active', '{}'::jsonb, '', ${SYSTEM_ID}::uuid)
      RETURNING id::text AS id`) as { id: string }[];
    const id = plugin?.id ?? "";
    await tx`
      INSERT INTO plugin_installation_versions
        (plugin_id, artifact_digest, manifest_json, source_code, origin, submitted_by)
      VALUES (${id}::uuid, ${DIGEST}, '{}'::jsonb, '', 'runtime-authored', ${SYSTEM_ID}::uuid)`;
    await tx`UPDATE plugin_installation_versions SET status = 'active' WHERE plugin_id = ${id}::uuid`;
    await tx`
      INSERT INTO plugin_capability_grants (plugin_id, artifact_digest, capability, approved_by)
      VALUES (${id}::uuid, ${DIGEST}, 'chat_runner_tools', ${SYSTEM_ID}::uuid)`;
    await tx.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await tx.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await tx.unsafe(`CREATE TABLE "${SCHEMA}".cfg (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), label text,
      caelo_deleted_at timestamptz, caelo_chat_branch_id uuid)`);
    await tx.unsafe(`INSERT INTO "${SCHEMA}".cfg (label) VALUES ('v1')`);
    const [tpl] = (await tx`
      SELECT t.id::text AS id FROM templates t
       WHERE t.deleted_at IS NULL
         AND (SELECT count(*) FROM page_types pt
               WHERE pt.deleted_at IS NULL AND pt.chat_branch_id IS NULL
                 AND pt.definition->'templates' ? t.id::text) = 1
       ORDER BY t.slug LIMIT 1`) as { id: string }[];
    const [page] = (await tx`
      INSERT INTO pages (slug, title, template_id, current_path, page_type_confirmed)
      VALUES ('t1329-page', 'P', ${tpl?.id}::uuid, '/t1329-page', true)
      RETURNING id::text AS id`) as { id: string }[];
    pageId = page?.id ?? "";
    return id;
  });
  await publishProjectionOnce(adapter, staging, { declarations: DECLARATIONS });
});

afterAll(async () => {
  await admin(async (tx) => {
    await tx`DELETE FROM projection_release_pointers`;
    await tx`DELETE FROM comment_archive WHERE page_id = ${pageId}::uuid`;
    await tx`DELETE FROM pages WHERE id = ${pageId}::uuid`;
    await tx`DELETE FROM redirects WHERE from_path = '/t1329-old'`;
    await tx`DELETE FROM plugins WHERE id = ${pluginId}::uuid`;
    await tx.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  });
  await adapter.close();
  await staging.close();
});

describe("the release sections follow the release (#1329, N6)", () => {
  it("the bootstrap froze what was there and released it to both", async () => {
    expect(await label(live)).toBe("v1");
    expect(await label(stagingDb)).toBe("v1");
  });

  it("a plugin change reaches neither database before a release; a Stage shows it on staging only", async () => {
    await setLabel("v2");
    await drainProjectionOnce(adapter, staging);
    expect(await label(live)).toBe("v1");
    expect(await label(stagingDb)).toBe("v1");

    const staged = await freeze();
    await point("staging", staged);
    expect(await label(stagingDb)).toBe("v2");
    // The live gateway still serves what was published (the N6 bug served v2).
    expect(await label(live)).toBe("v1");
    // A later change does not leak into the staged state either.
    await setLabel("v3");
    await drainProjectionOnce(adapter, staging);
    expect(await label(stagingDb)).toBe("v2");

    // Publish live promotes exactly the frozen state, not the main line (v3).
    const before = (await admin(
      async (tx) =>
        await tx`SELECT run_id::text AS id FROM projection_release_pointers WHERE environment = 'live'`,
    )) as { id: string }[];
    await point("live", staged);
    expect(await label(live)).toBe("v2");

    // A rollback restores the state of the build it puts back.
    await point("live", before[0]?.id ?? "");
    expect(await label(live)).toBe("v1");
    await point("live", staged);
  });

  it("narrowing reaches both at once: a revoked grant, then a deactivated plugin", async () => {
    await admin(async (tx) => {
      await tx`UPDATE plugin_capability_grants SET revoked_at = now(), revoked_by = ${SYSTEM_ID}::uuid
               WHERE plugin_id = ${pluginId}::uuid`;
    });
    await drainProjectionOnce(adapter, staging);
    for (const db of [live, stagingDb]) {
      const grants = (await db(
        async (tx) =>
          await tx`SELECT 1 FROM published_plugin_grants WHERE plugin_id = ${pluginId}::uuid`,
      )) as unknown[];
      expect(grants).toEqual([]);
    }
    await admin(async (tx) => {
      await tx`UPDATE plugins SET status = 'disabled' WHERE id = ${pluginId}::uuid`;
    });
    await drainProjectionOnce(adapter, staging);
    for (const db of [live, stagingDb]) {
      const plugins = (await db(
        async (tx) => await tx`SELECT 1 FROM published_plugins WHERE id = ${pluginId}::uuid`,
      )) as unknown[];
      expect(plugins).toEqual([]);
      expect(await label(db)).toBeNull();
    }
    // Re-enabling is an activation: it follows the next release.
    await admin(async (tx) => {
      await tx`UPDATE plugins SET status = 'active' WHERE id = ${pluginId}::uuid`;
    });
    await drainProjectionOnce(adapter, staging);
    expect(await label(live)).toBe("v2");
  });

  it("a complete freeze refuses an active plugin this instance has not loaded; a Stage's leaves it out", async () => {
    await expect(
      adapter.withAdminTransaction(SYSTEM, (tx) =>
        freezeRelease(tx, {
          runId: crypto.randomUUID(),
          reason: "bootstrap",
          declarations: new Map(),
          completeness: "required",
        }),
      ),
    ).rejects.toBeInstanceOf(ReleaseFreezeError);
    const runId = crypto.randomUUID();
    await adapter.withAdminTransaction(SYSTEM, (tx) =>
      freezeRelease(tx, {
        runId,
        reason: "stage",
        declarations: new Map(),
        completeness: "as-loaded",
      }),
    );
    const [frozen] = (await admin(
      async (tx) =>
        await tx`SELECT jsonb_array_length(state->'pluginRows') AS rows FROM projection_releases
                 WHERE run_id = ${runId}::uuid`,
    )) as { rows: number }[];
    expect(frozen?.rows).toBe(0);
  });
});

describe("the immediate sections (#1329)", () => {
  it("each environment has its own cookie secret: the two databases share none", async () => {
    await publishProjectionOnce(adapter, staging, { declarations: DECLARATIONS, comments: false });
    const secret = async (db: typeof live) =>
      (
        (await db(
          async (tx) => await tx`SELECT cookie_secret FROM published_gateway_settings WHERE id = 1`,
        )) as { cookie_secret: string }[]
      )[0]?.cookie_secret;
    const [l, s] = [await secret(live), await secret(stagingDb)];
    expect(l).toBeTruthy();
    expect(s).toBeTruthy();
    expect(l).not.toBe(s);
  });

  it("a cleared cookie secret unpublishes that environment's settings, never keeps the old one", async () => {
    const before = await admin(
      async (tx) =>
        (
          (await tx`SELECT gateway_staging_cookie_secret AS s FROM site_settings WHERE id = 1`) as {
            s: string | null;
          }[]
        )[0]?.s ?? null,
    );
    const settingsOf = async (db: typeof live) =>
      await db(async (tx) => ({
        rows: ((await tx`SELECT 1 FROM published_gateway_settings`) as unknown[]).length,
        marked: (
          (await tx`SELECT 1 FROM published_projection_sections WHERE section = 'settings'`) as unknown[]
        ).length,
      }));
    try {
      await admin(async (tx) => {
        await tx`UPDATE site_settings SET gateway_staging_cookie_secret = NULL WHERE id = 1`;
      });
      await publishProjectionOnce(adapter, staging, { declarations: DECLARATIONS, comments: false });
      expect(await settingsOf(stagingDb)).toEqual({ rows: 0, marked: 0 });
      expect(await settingsOf(live)).toEqual({ rows: 1, marked: 1 });
    } finally {
      await admin(async (tx) => {
        await tx`UPDATE site_settings SET gateway_staging_cookie_secret = ${before} WHERE id = 1`;
      });
      await publishProjectionOnce(adapter, staging, { declarations: DECLARATIONS, comments: false });
    }
    expect(await settingsOf(stagingDb)).toEqual({ rows: 1, marked: 1 });
  });

  it("redirects reach the staging database through the projection, the live one not", async () => {
    await admin(async (tx) => {
      await tx`INSERT INTO redirects (from_path, to_path, status_code, created_by)
               VALUES ('/t1329-old', '/t1329-new', 301, ${SYSTEM_ID}::uuid)`;
    });
    await drainProjectionOnce(adapter, staging);
    const found = async (db: typeof live) =>
      (await db(
        async (tx) =>
          await tx`SELECT to_path FROM published_redirects WHERE from_path = '/t1329-old'`,
      )) as { to_path: string }[];
    expect(await found(stagingDb)).toEqual([{ to_path: "/t1329-new" }]);
    expect(await found(live)).toEqual([]);
  });

  it("a team post is written as approved under the user's name and published to both", async () => {
    const human = await admin(async (tx) => {
      const [a] = (await tx`
        INSERT INTO actors (kind, display_name) VALUES ('human', 'Team Member')
        RETURNING id::text AS id`) as { id: string }[];
      return a?.id ?? "";
    });
    try {
      const r = await adapter.runOperation(
        commentArchivePostTeamOp,
        { actorId: human, actorKind: "human", requestId: "t1329-post" },
        { pageId, parentId: null, content: "Thanks for asking!" },
      );
      expect(r.ok).toBe(true);
      await drainProjectionOnce(adapter, staging);
      for (const db of [live, stagingDb]) {
        const rows = (await db(
          async (tx) =>
            await tx`SELECT author_name FROM published_comments WHERE page_id = ${pageId}::uuid`,
        )) as { author_name: string }[];
        expect(rows).toEqual([{ author_name: "Team Member" }]);
      }
      // Only a human team member's actor can post as the team.
      const notHuman = await adapter.runOperation(
        commentArchivePostTeamOp,
        { actorId: SYSTEM_ID, actorKind: "human", requestId: "t1329-system" },
        { pageId, parentId: null, content: "forged" },
      );
      expect(notHuman.ok).toBe(false);
    } finally {
      await admin(async (tx) => {
        await tx`DELETE FROM comment_archive WHERE page_id = ${pageId}::uuid`;
        await tx`DELETE FROM audit_events WHERE actor_id = ${human}::uuid`;
        await tx`DELETE FROM actors WHERE id = ${human}::uuid`;
      });
    }
  });
});

describe("the staging inbox (#1329)", () => {
  const INBOX_SCHEMA = "plugin_t1329_inbox";
  it("is cleared at a Stage; the live inbox is not touched", async () => {
    for (const db of [live, stagingDb]) {
      await db(async (tx) => {
        await tx.unsafe(`DROP SCHEMA IF EXISTS "${INBOX_SCHEMA}" CASCADE`);
        await tx.unsafe(`CREATE SCHEMA "${INBOX_SCHEMA}"`);
        await tx.unsafe(
          `CREATE TABLE "${INBOX_SCHEMA}".entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text)`,
        );
        await tx.unsafe(`INSERT INTO "${INBOX_SCHEMA}".entries (note) VALUES ('test')`);
      });
    }
    try {
      const cleared = await clearStagingInbox(staging, [
        { pluginId, schema: INBOX_SCHEMA, table: "entries" },
        // Not provisioned (yet): skipped, not an error.
        { pluginId, schema: INBOX_SCHEMA, table: "missing" },
      ]);
      expect(cleared).toEqual([`${INBOX_SCHEMA}.entries`]);
      const count = async (db: typeof live) =>
        (
          (await db(
            async (tx) =>
              await tx.unsafe(`SELECT count(*)::int AS n FROM "${INBOX_SCHEMA}".entries`),
          )) as { n: number }[]
        )[0]?.n;
      expect(await count(stagingDb)).toBe(0);
      expect(await count(live)).toBe(1);
    } finally {
      for (const db of [live, stagingDb]) {
        await db(async (tx) => {
          await tx.unsafe(`DROP SCHEMA IF EXISTS "${INBOX_SCHEMA}" CASCADE`);
        });
      }
    }
  });
});
