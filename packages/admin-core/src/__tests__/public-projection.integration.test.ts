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
import {
  drainPublicProjection,
  ProjectionBusyError,
} from "@caelo-cms/migrations/public-projection";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { rotateStagingCredentialsOp } from "../ops/staging_access.js";
import {
  createPublicProjectionPublisher,
  drainProjectionOnce,
  projectionDatabases,
  publishProjectionOnce,
  releaseProjectionForTests,
  stagingPublicAdapter,
} from "../public-projection.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const STAGING_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL || !STAGING_URL) throw new Error("DB URLs required");

const P = "t635proj";
let adapter: DatabaseAdapter;
let staging: DatabaseAdapter;

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
  staging = stagingPublicAdapter(STAGING_URL);
  pageId = await admin(async (tx) => {
    // A seeded template exactly one page type lists, so the page-type
    // trigger can default it. "LIMIT 1" alone picked whatever template the
    // plan reached first, and under the query index gate (#1293) that was
    // sometimes one of two page types' templates.
    const [tpl] = (await tx`
      SELECT t.id::text AS id FROM templates t
       WHERE t.deleted_at IS NULL
         AND (SELECT count(*) FROM page_types pt
               WHERE pt.deleted_at IS NULL AND pt.chat_branch_id IS NULL
                 AND pt.definition->'templates' ? t.id::text) = 1
       ORDER BY t.slug LIMIT 1`) as { id: string }[];
    const [page] = (await tx`
      INSERT INTO pages (slug, title, template_id, current_path, page_type_confirmed)
      VALUES (${`${P}-page`}, 'P', ${tpl?.id}::uuid, ${`/${P}-page`}, true) RETURNING id::text AS id`) as {
      id: string;
    }[];
    return page?.id ?? "";
  });
  await publishProjectionOnce(adapter, staging, { declarations: new Map() });
});

afterAll(async () => {
  await admin(async (tx) => {
    await tx`DELETE FROM comment_archive WHERE page_id = ${pageId}::uuid`;
    await tx`DELETE FROM pages WHERE id = ${pageId}::uuid`;
    await tx`DELETE FROM plugin_rate_limit_overrides WHERE plugin_slug = ${P}`;
  });
  await adapter.close();
  await staging.close();
});

describe("the outbox (cms_admin migration 0281)", () => {
  it("a source write marks its section stale in the same transaction", async () => {
    await drainProjectionOnce(adapter, staging);
    expect(await outboxSections()).toEqual([]);
    await admin(async (tx) => {
      await tx`INSERT INTO plugin_rate_limit_overrides (plugin_slug, operation, per_visitor_max, window_seconds)
               VALUES (${P}, 'submit', 7, 30)`;
      await tx`UPDATE site_settings SET gateway_max_body_bytes = gateway_max_body_bytes WHERE id = 1`;
    });
    expect(await outboxSections()).toEqual(["rate_limits", "settings"]);
  });

  it("a rolled-back write leaves nothing behind", async () => {
    await drainProjectionOnce(adapter, staging);
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
    const report = await drainProjectionOnce(adapter, staging);
    expect(report.sections).toEqual({ live: ["rate_limits"], staging: ["rate_limits"] });
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
    const report = await drainProjectionOnce(adapter, staging);
    expect(report.comments).toBe(2);
    const published = (await pub(
      async (tx) =>
        await tx`SELECT author_name FROM published_comments WHERE page_id = ${pageId}::uuid`,
    )) as { author_name: string }[];
    expect(published).toEqual([{ author_name: "Ada" }]);

    await admin(async (tx) => {
      await tx`UPDATE comment_archive SET status = 'rejected' WHERE page_id = ${pageId}::uuid AND author_name = 'Ada'`;
    });
    await drainProjectionOnce(adapter, staging);
    const after = (await pub(
      async (tx) => await tx`SELECT 1 FROM published_comments WHERE page_id = ${pageId}::uuid`,
    )) as unknown[];
    expect(after).toEqual([]);
  });

  it("publishes only the gateway columns of site_settings, plus the live origins (#1326)", async () => {
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
      // Derived from the base URL and the public domains, never the staging host.
      "live_origins",
      // #1432 — held in cms_admin; a one-way copy for checking mail links.
      "mail_link_key",
    ]);
  });
});

describe("one way only (#635, adversarial)", () => {
  it("rows forged into a published table are replaced by the next publish, never read back", async () => {
    await pub(async (tx) => {
      await tx`INSERT INTO published_rate_limits VALUES ('forged', 'op', 100000, 1)`;
    });
    await publishProjectionOnce(adapter, staging, { declarations: new Map(), comments: false });
    const forged = (await pub(
      async (tx) => await tx`SELECT 1 FROM published_rate_limits WHERE plugin_slug = 'forged'`,
    )) as unknown[];
    expect(forged).toEqual([]);
  });
});

describe("consuming the outbox (#635 review)", () => {
  it("never deletes a row it did not read: a lower id committed mid-drain survives", async () => {
    await drainProjectionOnce(adapter, staging);
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
      const dbs = projectionDatabases(adapter, staging);
      const report = await drainPublicProjection({
        readAdmin: dbs.readAdmin,
        writePublic: async (target, fn) => {
          // The slow transaction commits while the drain is publishing.
          if (target === "live") await slow`COMMIT`;
          await dbs.writePublic(target, fn);
        },
      });
      expect(report.sections.live).toEqual(["rate_limits"]);
      // Its row is still there, so the staging section is republished next.
      expect(await outboxSections()).toEqual(["staging"]);
      expect((await drainProjectionOnce(adapter, staging)).sections.live).toEqual(["staging"]);
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
    const publisher = createPublicProjectionPublisher({
      adapter,
      stagingAdapter: staging,
      declarations: () => new Map(),
    });
    try {
      await drainProjectionOnce(adapter, staging);
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
      await drainProjectionOnce(adapter, staging);
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
      // #1329 — the registry follows the release: published once released.
      await releaseProjectionForTests(adapter, staging, new Map([[`${P}-grants`, null]]));
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
      await publishProjectionOnce(adapter, staging, { declarations: new Map(), comments: false });
    }
  });
});

describe("the projection lock never holds a waiting connection (2026-11-02 incident)", () => {
  const LOCK = "SELECT pg_advisory_xact_lock(hashtext('caelo_public_projection'))";

  /** Backends that wait on an advisory lock right now (the old waiting publishers). */
  async function advisoryWaiters(): Promise<number> {
    const [row] = (await admin(
      async (tx) =>
        await tx`SELECT count(*)::int AS n FROM pg_stat_activity
                 WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'`,
    )) as { n: number }[];
    return row?.n ?? 0;
  }

  /** Another publisher (another admin instance) holding the lock until `release`. */
  async function holdLock(): Promise<{ release: () => Promise<void> }> {
    const raw = new SQL(ADMIN_URL as string);
    const conn = await raw.reserve();
    await conn`BEGIN`;
    await conn.unsafe(LOCK);
    return {
      release: async () => {
        await conn`COMMIT`;
        conn.release();
        await raw.end();
      },
    };
  }

  it("a drain waits for a busy lock without a connection, then publishes", async () => {
    await admin(async (tx) => {
      await tx`UPDATE plugin_rate_limit_overrides SET per_visitor_max = 21 WHERE plugin_slug = ${P}`;
    });
    const holder = await holdLock();
    let settled = false;
    const drain = drainPublicProjection(projectionDatabases(adapter, staging), {
      lockWait: { waitMs: 10_000, retryMs: 100 },
    }).finally(() => {
      settled = true;
    });
    try {
      await Bun.sleep(600);
      expect(settled).toBe(false);
      expect(await advisoryWaiters()).toBe(0);
    } finally {
      await holder.release();
    }
    const report = await drain;
    expect(report.sections.live).toContain("rate_limits");
    const rows = (await pub(
      async (tx) =>
        await tx`SELECT per_visitor_max FROM published_rate_limits WHERE plugin_slug = ${P}`,
    )) as { per_visitor_max: number }[];
    expect(rows).toEqual([{ per_visitor_max: 21 }]);
  });

  it("gives up with ProjectionBusyError when the lock stays busy, leaving the outbox", async () => {
    await admin(async (tx) => {
      await tx`UPDATE plugin_rate_limit_overrides SET per_visitor_max = 22 WHERE plugin_slug = ${P}`;
    });
    const holder = await holdLock();
    try {
      await expect(
        drainPublicProjection(projectionDatabases(adapter, staging), {
          lockWait: { waitMs: 700, retryMs: 100 },
        }),
      ).rejects.toBeInstanceOf(ProjectionBusyError);
      expect(await outboxSections()).toContain("rate_limits");
    } finally {
      await holder.release();
    }
    await drainProjectionOnce(adapter, staging);
    expect(await outboxSections()).toEqual([]);
  });

  it("drains asked for while one waits to start join it instead of queueing one each", async () => {
    const publisher = createPublicProjectionPublisher({
      adapter,
      stagingAdapter: staging,
      declarations: () => new Map(),
    });
    const holder = await holdLock();
    let released = false;
    try {
      const running = publisher.drain();
      // Let it start: it now waits for the lock, so it may have read the
      // outbox before a later commit and cannot be joined.
      await Bun.sleep(50);
      const second = publisher.drain();
      const third = publisher.drain();
      expect(second).toBe(third);
      expect(second).not.toBe(running);
      await holder.release();
      released = true;
      await Promise.all([running, second, third]);
    } finally {
      if (!released) await holder.release();
      publisher.stop();
    }
  });
  it("full publishes asked for while one waits to start join it (the backstop's retries stay bounded)", async () => {
    const publisher = createPublicProjectionPublisher({
      adapter,
      stagingAdapter: staging,
      declarations: () => new Map(),
    });
    const holder = await holdLock();
    let released = false;
    try {
      const running = publisher.publishAll();
      await Bun.sleep(50);
      const retries = [publisher.publishAll(), publisher.publishAll(), publisher.publishAll()];
      expect(new Set(retries).size).toBe(1);
      expect(retries[0]).not.toBe(running);
      await holder.release();
      released = true;
      await Promise.all([running, ...retries]);
    } finally {
      if (!released) await holder.release();
      publisher.stop();
    }
  });

  it("the scheduler tick's backstop drains what another process left in the outbox (#1140)", async () => {
    const publisher = createPublicProjectionPublisher({
      adapter,
      stagingAdapter: staging,
      declarations: () => new Map(),
    });
    try {
      await drainProjectionOnce(adapter, staging);
      // A write whose own drain never ran (another process, a migration):
      // the post-write drain is unregistered.
      publisher.stop();
      const result = await adapter.runOperation(
        rotateStagingCredentialsOp,
        {
          actorId: "00000000-0000-0000-0000-00000000ffff",
          actorKind: "system",
          requestId: "t1140",
        },
        { which: "both" },
      );
      expect(result.ok).toBe(true);
      expect((await outboxSections()).length).toBeGreaterThan(0);
      await publisher.backstop();
      expect(await outboxSections()).toEqual([]);
    } finally {
      publisher.stop();
    }
  });
});

describe("no admin transaction is open while the public databases are written (#1594)", () => {
  async function setRateLimit(n: number): Promise<void> {
    await admin(async (tx) => {
      await tx`UPDATE plugin_rate_limit_overrides SET per_visitor_max = ${n} WHERE plugin_slug = ${P}`;
    });
  }
  async function publishedRateLimit(url: string): Promise<number | undefined> {
    const rows = (await onDb(
      url,
      async (tx) =>
        await tx`SELECT per_visitor_max FROM published_rate_limits WHERE plugin_slug = ${P}`,
    )) as { per_visitor_max: number }[];
    return rows[0]?.per_visitor_max;
  }

  it("reads, commits, then writes: the admin side is closed during every public write", async () => {
    await setRateLimit(31);
    const real = projectionDatabases(adapter, staging);
    let openAdmin = 0;
    const openDuringWrites: number[] = [];
    const watched = {
      ...real,
      readAdmin: async <T>(fn: Parameters<typeof real.readAdmin<T>>[0]): Promise<T> => {
        openAdmin += 1;
        try {
          return await real.readAdmin(fn);
        } finally {
          openAdmin -= 1;
        }
      },
      writePublic: async (...args: Parameters<typeof real.writePublic>) => {
        openDuringWrites.push(openAdmin);
        await real.writePublic(...args);
      },
    };
    const report = await drainPublicProjection(watched);
    expect(report.sections.live).toContain("rate_limits");
    expect(openDuringWrites).toEqual([0, 0]);
    expect(await outboxSections()).toEqual([]);
    expect(await publishedRateLimit(PUBLIC_URL as string)).toBe(31);
  });

  it("an older read never overwrites a newer publish, in either public database", async () => {
    await setRateLimit(41);
    const real = projectionDatabases(adapter, staging);
    // Publisher A reads 41, then stalls before its public writes (a slow
    // public database, a saturated pool).
    let resume!: () => void;
    const resumed = new Promise<void>((r) => {
      resume = r;
    });
    let stalled!: () => void;
    const reachedWrite = new Promise<void>((r) => {
      stalled = r;
    });
    let first = true;
    const slow = {
      ...real,
      writePublic: async (...args: Parameters<typeof real.writePublic>) => {
        if (first) {
          first = false;
          stalled();
          await resumed;
        }
        await real.writePublic(...args);
      },
    };
    const older = drainPublicProjection(slow);
    await reachedWrite;
    // Meanwhile the source changes and publisher B (another instance)
    // publishes the newer state: the lock is free, A is not holding it.
    await setRateLimit(42);
    const newer = await drainPublicProjection(real, { lockWait: { waitMs: 5_000 } });
    expect(newer.sections.live).toContain("rate_limits");
    resume();
    const report = await older;
    expect(report.superseded).toEqual({ live: ["rate_limits"], staging: ["rate_limits"] });
    expect(report.sections).toEqual({ live: [], staging: [] });
    expect(await publishedRateLimit(PUBLIC_URL as string)).toBe(42);
    expect(await publishedRateLimit(STAGING_URL as string)).toBe(42);
    expect(await outboxSections()).toEqual([]);
  });

  it("a section a newer publish removed does not come back from an older read", async () => {
    await setRateLimit(51);
    const real = projectionDatabases(adapter, staging);
    let resume!: () => void;
    const resumed = new Promise<void>((r) => {
      resume = r;
    });
    let stalled!: () => void;
    const reachedWrite = new Promise<void>((r) => {
      stalled = r;
    });
    let first = true;
    const slow = {
      ...real,
      writePublic: async (...args: Parameters<typeof real.writePublic>) => {
        if (first) {
          first = false;
          stalled();
          await resumed;
        }
        await real.writePublic(...args);
      },
    };
    const older = drainPublicProjection(slow);
    await reachedWrite;
    await setRateLimit(52);
    await drainPublicProjection(real, { lockWait: { waitMs: 5_000 } });
    // The newer publish took the section away (as a cleared cookie secret
    // takes `settings` away): its published mark is gone.
    for (const url of [PUBLIC_URL as string, STAGING_URL as string]) {
      await onDb(url, async (tx) => {
        await tx`DELETE FROM published_projection_sections WHERE section = 'rate_limits'`;
        await tx`DELETE FROM published_rate_limits WHERE plugin_slug = ${P}`;
      });
    }
    resume();
    const report = await older;
    expect(report.superseded).toEqual({ live: ["rate_limits"], staging: ["rate_limits"] });
    expect(await publishedRateLimit(PUBLIC_URL as string)).toBeUndefined();
    expect(await publishedRateLimit(STAGING_URL as string)).toBeUndefined();
    // Put the section back for the files that run after this one.
    await setRateLimit(53);
    await drainPublicProjection(real);
    expect(await publishedRateLimit(PUBLIC_URL as string)).toBe(53);
  });

  /** Publisher A: reads now, stalls before its public writes until `resume()`. */
  function stalledPublisher() {
    const real = projectionDatabases(adapter, staging);
    let resume!: () => void;
    const resumed = new Promise<void>((r) => {
      resume = r;
    });
    let stalled!: () => void;
    const reachedWrite = new Promise<void>((r) => {
      stalled = r;
    });
    let first = true;
    const slow = {
      ...real,
      writePublic: async (...args: Parameters<typeof real.writePublic>) => {
        if (first) {
          first = false;
          stalled();
          await resumed;
        }
        await real.writePublic(...args);
      },
    };
    return { real, slow, reachedWrite, resume: () => resume() };
  }

  async function addComment(author: string, status: string): Promise<void> {
    await admin(async (tx) => {
      await tx`
        INSERT INTO comment_archive (public_row_id, page_id, author_name, content, status, submitted_at)
        VALUES (gen_random_uuid(), ${pageId}::uuid, ${author}, 'c', ${status}, now())`;
    });
  }
  async function setStatus(author: string, status: string): Promise<void> {
    await admin(async (tx) => {
      await tx`UPDATE comment_archive SET status = ${status} WHERE page_id = ${pageId}::uuid AND author_name = ${author}`;
    });
  }
  async function publishedAuthors(url: string): Promise<string[]> {
    const rows = (await onDb(
      url,
      async (tx) =>
        await tx`SELECT author_name FROM published_comments WHERE page_id = ${pageId}::uuid ORDER BY author_name`,
    )) as { author_name: string }[];
    return rows.map((r) => r.author_name);
  }

  it("comments are versioned one by one: a newer publish of other comments keeps an older one's", async () => {
    await addComment("Older", "approved");
    const a = stalledPublisher();
    const older = drainPublicProjection(a.slow);
    await a.reachedWrite;
    // A newer publish carries a different comment only: A's row is not in
    // its batch (as when A's batch ended at the 5,000-row limit and B's
    // started after it).
    await addComment("Newer", "approved");
    await admin(async (tx) => {
      await tx`DELETE FROM public_projection_outbox
               WHERE section = 'comments'
                 AND entity_id IN (SELECT id FROM comment_archive
                                   WHERE page_id = ${pageId}::uuid AND author_name = 'Older')`;
    });
    await drainPublicProjection(a.real, { lockWait: { waitMs: 5_000 } });
    a.resume();
    await older;
    for (const url of [PUBLIC_URL as string, STAGING_URL as string]) {
      expect(await publishedAuthors(url)).toEqual(["Newer", "Older"]);
    }
    expect(await outboxSections()).toEqual([]);
  });

  it("an older read does not bring back a comment a newer publish took down", async () => {
    await addComment("Moderated", "approved");
    await drainPublicProjection(projectionDatabases(adapter, staging));
    await setStatus("Moderated", "spam");
    const a = stalledPublisher();
    // A reads the spam verdict... then the comment is approved again and
    // rejected once more, each published by a newer read.
    await setStatus("Moderated", "approved");
    const older = drainPublicProjection(a.slow);
    await a.reachedWrite;
    await setStatus("Moderated", "rejected");
    await drainPublicProjection(a.real, { lockWait: { waitMs: 5_000 } });
    a.resume();
    await older;
    for (const url of [PUBLIC_URL as string, STAGING_URL as string]) {
      expect(await publishedAuthors(url)).not.toContain("Moderated");
    }
  });

  it("a unit a previous-release publisher wrote after this read is left alone, and stays queued", async () => {
    await setRateLimit(61);
    const a = stalledPublisher();
    const older = drainPublicProjection(a.slow);
    await a.reachedWrite;
    // A publisher of the previous release (no generations) writes the unit
    // in both public databases, as its markPublished does: now() at its write.
    for (const url of [PUBLIC_URL as string, STAGING_URL as string]) {
      await onDb(url, async (tx) => {
        await tx`UPDATE published_rate_limits SET per_visitor_max = 62 WHERE plugin_slug = ${P}`;
        await tx`INSERT INTO published_projection_sections (section, published_at) VALUES ('rate_limits', clock_timestamp())
                 ON CONFLICT (section) DO UPDATE SET published_at = clock_timestamp()`;
      });
    }
    a.resume();
    const report = await older;
    expect(report.superseded).toEqual({ live: ["rate_limits"], staging: ["rate_limits"] });
    expect(await publishedRateLimit(PUBLIC_URL as string)).toBe(62);
    // Its outbox row stays, so the next drain republishes from the source.
    expect(await outboxSections()).toEqual(["rate_limits"]);
    await drainPublicProjection(a.real);
    expect(await publishedRateLimit(PUBLIC_URL as string)).toBe(61);
    expect(await outboxSections()).toEqual([]);
  });
});
