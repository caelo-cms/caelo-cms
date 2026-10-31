// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 — the projection the admin publishes into cms_public for the
 * gateway (which has no cms_admin login).
 *
 *   - every source write marks its section stale in the outbox, in the
 *     writer's own transaction (cms_admin migration 0281's triggers);
 *   - a drain republishes exactly those sections from the source of truth
 *     and consumes the outbox;
 *   - only the declared columns cross (site_settings: four, comments:
 *     approved only), and a plugin that stops being active loses its
 *     projected rows;
 *   - a publish never reads the published tables back: rows the public
 *     side forged there are simply replaced.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drainPublicProjection } from "@caelo-cms/migrations/public-projection";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { rotateStagingCredentialsOp } from "../ops/staging_access.js";
import {
  drainProjectionOnce,
  projectionDatabases,
  publishProjectionOnce,
  startPublicProjectionPublisher,
} from "../public-projection.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const P = "t635proj";
let adapter: DatabaseAdapter;

async function onDb<T>(url: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
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
const admin = <T>(fn: (tx: SQL) => Promise<T>) => onDb(ADMIN_URL as string, fn);
const pub = <T>(fn: (tx: SQL) => Promise<T>) => onDb(PUBLIC_URL as string, fn);

async function outboxSections(): Promise<string[]> {
  const rows = (await admin(
    async (tx) => await tx`SELECT DISTINCT section FROM public_projection_outbox ORDER BY section`,
  )) as { section: string }[];
  return rows.map((r) => r.section);
}

let pageId = "";

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  pageId = await admin(async (tx) => {
    const [tpl] = (await tx`SELECT id::text AS id FROM templates LIMIT 1`) as { id: string }[];
    const [page] = (await tx`
      INSERT INTO pages (slug, title, template_id, current_path, page_type_confirmed)
      VALUES (${`${P}-page`}, 'P', ${tpl?.id}::uuid, ${`/${P}-page`}, true) RETURNING id::text AS id`) as {
      id: string;
    }[];
    return page?.id ?? "";
  });
  await publishProjectionOnce(adapter, { declarations: new Map() });
});

afterAll(async () => {
  await admin(async (tx) => {
    await tx`DELETE FROM comment_archive WHERE page_id = ${pageId}::uuid`;
    await tx`DELETE FROM pages WHERE id = ${pageId}::uuid`;
    await tx`DELETE FROM plugin_rate_limit_overrides WHERE plugin_slug = ${P}`;
  });
  await adapter.close();
});

describe("the outbox (cms_admin migration 0281)", () => {
  it("a source write marks its section stale in the same transaction", async () => {
    await drainProjectionOnce(adapter, new Map());
    expect(await outboxSections()).toEqual([]);
    await admin(async (tx) => {
      await tx`INSERT INTO plugin_rate_limit_overrides (plugin_slug, operation, per_visitor_max, window_seconds)
               VALUES (${P}, 'submit', 7, 30)`;
      await tx`UPDATE site_settings SET gateway_max_body_bytes = gateway_max_body_bytes WHERE id = 1`;
    });
    expect(await outboxSections()).toEqual(["rate_limits", "settings"]);
  });

  it("a rolled-back write leaves nothing behind", async () => {
    await drainProjectionOnce(adapter, new Map());
    await admin(async (tx) => {
      await tx`UPDATE staging_access SET cookie_enabled = cookie_enabled WHERE id = 1`;
      throw new Error("rollback");
    }).catch(() => undefined);
    expect(await outboxSections()).toEqual([]);
  });
});

describe("drain (#635)", () => {
  it("republishes the stale sections from the source of truth and consumes the outbox", async () => {
    await admin(async (tx) => {
      await tx`UPDATE plugin_rate_limit_overrides SET per_visitor_max = 9 WHERE plugin_slug = ${P}`;
    });
    const report = await drainProjectionOnce(adapter, new Map());
    expect(report.sections).toEqual(["rate_limits"]);
    expect(await outboxSections()).toEqual([]);
    const rows = (await pub(
      async (tx) =>
        await tx`SELECT per_visitor_max FROM published_rate_limits WHERE plugin_slug = ${P}`,
    )) as { per_visitor_max: number }[];
    expect(rows).toEqual([{ per_visitor_max: 9 }]);
  });

  it("publishes approved comments only, one by one as moderation changes them", async () => {
    await admin(async (tx) => {
      await tx`
        INSERT INTO comment_archive (public_row_id, page_id, author_name, content, status, submitted_at)
        VALUES (gen_random_uuid(), ${pageId}::uuid, 'Ada', 'yes', 'approved', now()),
               (gen_random_uuid(), ${pageId}::uuid, 'Spam', 'no', 'spam', now())`;
    });
    const report = await drainProjectionOnce(adapter, new Map());
    expect(report.comments).toBe(2);
    const published = (await pub(
      async (tx) =>
        await tx`SELECT author_name FROM published_comments WHERE page_id = ${pageId}::uuid`,
    )) as { author_name: string }[];
    expect(published).toEqual([{ author_name: "Ada" }]);

    await admin(async (tx) => {
      await tx`UPDATE comment_archive SET status = 'rejected' WHERE page_id = ${pageId}::uuid AND author_name = 'Ada'`;
    });
    await drainProjectionOnce(adapter, new Map());
    const after = (await pub(
      async (tx) => await tx`SELECT 1 FROM published_comments WHERE page_id = ${pageId}::uuid`,
    )) as unknown[];
    expect(after).toEqual([]);
  });

  it("publishes only the four gateway columns of site_settings", async () => {
    const cols = (await pub(
      async (tx) =>
        await tx`
        SELECT column_name::text AS c FROM information_schema.columns
        WHERE table_name = 'published_gateway_settings' ORDER BY ordinal_position`,
    )) as { c: string }[];
    expect(cols.map((c) => c.c)).toEqual([
      "id",
      "cookie_secret",
      "max_body_bytes",
      "captcha_provider",
      "captcha_pow_target_prefix",
    ]);
  });
});

describe("one way only (#635, adversarial)", () => {
  it("rows forged into a published table are replaced by the next publish, never read back", async () => {
    await pub(async (tx) => {
      await tx`INSERT INTO published_rate_limits VALUES ('forged', 'op', 100000, 1)`;
    });
    await publishProjectionOnce(adapter, { declarations: new Map(), comments: false });
    const forged = (await pub(
      async (tx) => await tx`SELECT 1 FROM published_rate_limits WHERE plugin_slug = 'forged'`,
    )) as unknown[];
    expect(forged).toEqual([]);
  });
});

describe("consuming the outbox (#635 review)", () => {
  it("never deletes a row it did not read: a lower id committed mid-drain survives", async () => {
    await drainProjectionOnce(adapter, new Map());
    // A long transaction takes an outbox id first and commits last.
    const raw = new SQL(ADMIN_URL as string);
    const slow = await raw.reserve();
    try {
      await slow`BEGIN`;
      await slow`SET LOCAL caelo.actor_kind = 'system'`;
      await slow`UPDATE staging_access SET cookie_enabled = cookie_enabled WHERE id = 1`;
      // A later write with a higher id commits now; the drain reads only it.
      await admin(async (tx) => {
        await tx`UPDATE plugin_rate_limit_overrides SET per_visitor_max = 8 WHERE plugin_slug = ${P}`;
      });
      const dbs = projectionDatabases(adapter);
      const report = await drainPublicProjection(
        {
          readAdmin: dbs.readAdmin,
          writePublic: async (fn) => {
            // The slow transaction commits while the drain is publishing.
            await slow`COMMIT`;
            await dbs.writePublic(fn);
          },
        },
        new Map(),
      );
      expect(report.sections).toEqual(["rate_limits"]);
      // Its row is still there, so the staging section is republished next.
      expect(await outboxSections()).toEqual(["staging"]);
      expect((await drainProjectionOnce(adapter, new Map())).sections).toEqual(["staging"]);
      expect(await outboxSections()).toEqual([]);
    } finally {
      slow.release();
      await raw.end();
    }
  });
});

describe("publishing before the admin call returns (#635 review)", () => {
  const SYSTEM = {
    actorId: "00000000-0000-0000-0000-00000000ffff",
    actorKind: "system" as const,
    requestId: "t635-sync",
  };

  it("an op that changes published state is live on the public side when it returns", async () => {
    // No poll in this test: the interval never fires.
    const publisher = startPublicProjectionPublisher({
      adapter,
      declarations: () => new Map(),
      intervalMs: 3_600_000,
    });
    try {
      await drainProjectionOnce(adapter, new Map());
      const result = await adapter.runOperation(rotateStagingCredentialsOp, SYSTEM, {
        which: "both",
      });
      expect(result.ok).toBe(true);
      const [source] = (await admin(
        async (tx) =>
          await tx`SELECT basic_auth_nonce, header_nonce FROM staging_access WHERE id = 1`,
      )) as { basic_auth_nonce: string; header_nonce: string }[];
      const [published] = (await pub(
        async (tx) =>
          await tx`SELECT basic_auth_nonce, header_nonce FROM published_staging_access WHERE id = 1`,
      )) as { basic_auth_nonce: string; header_nonce: string }[];
      expect(published).toEqual(source);
      expect(await outboxSections()).toEqual([]);

      // The same for a system worker's transaction.
      await adapter.withAdminTransaction(SYSTEM, async (tx) => {
        await tx.execute(
          sql`UPDATE plugin_rate_limit_overrides SET per_visitor_max = 13 WHERE plugin_slug = ${P}`,
        );
      });
      const rows = (await pub(
        async (tx) =>
          await tx`SELECT per_visitor_max FROM published_rate_limits WHERE plugin_slug = ${P}`,
      )) as { per_visitor_max: number }[];
      expect(rows).toEqual([{ per_visitor_max: 13 }]);
    } finally {
      publisher.stop();
    }
  });

  it("a write that changes no published state publishes nothing", async () => {
    let calls = 0;
    adapter.setProjectionPublisher(async () => {
      calls += 1;
    });
    try {
      await adapter.withAdminTransaction(SYSTEM, async (tx) => {
        await tx.execute(sql`SELECT 1`);
      });
      expect(calls).toBe(0);
    } finally {
      adapter.setProjectionPublisher(null);
    }
  });

  it("a publish that fails after the commit is reported, not swallowed", async () => {
    adapter.setProjectionPublisher(async () => {
      throw new Error("cms_public unreachable");
    });
    try {
      const result = await adapter.runOperation(rotateStagingCredentialsOp, SYSTEM, {
        which: "header",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("HandlerError");
        expect(JSON.stringify(result.error)).toContain("The change is saved");
      }
      // The outbox keeps it for the backstop drain.
      expect(await outboxSections()).toEqual(["staging"]);
    } finally {
      adapter.setProjectionPublisher(null);
      await drainProjectionOnce(adapter, new Map());
    }
  });
});

describe("the plugins section (#635 review)", () => {
  const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
  const DIGEST = "c".repeat(64);

  it("publishes capability receipts (bigint ids) of the active artifact", async () => {
    const pluginId = await admin(async (tx) => {
      await tx`SELECT set_config('caelo.actor_id', ${SYSTEM_ID}, true)`;
      const [plugin] = (await tx`
        INSERT INTO plugins (slug, version, tier, status, manifest_json, source_code, submitted_by)
        VALUES (${`${P}-grants`}, '1.0.0', 2, 'active', '{}'::jsonb, '', ${SYSTEM_ID}::uuid)
        RETURNING id::text AS id`) as { id: string }[];
      const id = plugin?.id ?? "";
      await tx`
        INSERT INTO plugin_installation_versions
          (plugin_id, artifact_digest, manifest_json, source_code, origin, submitted_by)
        VALUES (${id}::uuid, ${DIGEST}, '{}'::jsonb, '', 'runtime-authored', ${SYSTEM_ID}::uuid)`;
      await tx`UPDATE plugin_installation_versions SET status = 'active'
               WHERE plugin_id = ${id}::uuid`;
      await tx`
        INSERT INTO plugin_capability_grants (plugin_id, artifact_digest, capability, approved_by)
        VALUES (${id}::uuid, ${DIGEST}, 'chat_runner_tools', ${SYSTEM_ID}::uuid)`;
      return id;
    });
    try {
      await publishProjectionOnce(adapter, { declarations: new Map(), comments: false });
      const grants = (await pub(
        async (tx) =>
          await tx`SELECT capability FROM published_plugin_grants
                               WHERE plugin_id = ${pluginId}::uuid`,
      )) as { capability: string }[];
      expect(grants).toEqual([{ capability: "chat_runner_tools" }]);
    } finally {
      await admin(async (tx) => {
        await tx`DELETE FROM plugins WHERE id = ${pluginId}::uuid`;
      });
      await publishProjectionOnce(adapter, { declarations: new Map(), comments: false });
    }
  });
});
