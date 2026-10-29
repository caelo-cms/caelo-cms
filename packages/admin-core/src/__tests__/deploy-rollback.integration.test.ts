// SPDX-License-Identifier: MPL-2.0

/**
 * P6.2 #2 — content-addressed builds enable rollback. Two deploys, then
 * rollback to the first; the live `current/` directory should mirror
 * the first build's content (older page-body), and the deploy_runs
 * table records a new succeeded row pointing at the old build_id.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { LEGACY_LIVE_RELEASE_LOCK_KEY, LIVE_RELEASE_LEASE } from "../deploy/live-release-lock.js";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { openQualityGate } from "./fixtures/quality-gate.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "human",
  requestId: "p6-2-rollback",
};

const TPL_SLUG = "p6-2-rollback-tpl";
const MOD_SLUG = "p6-2-rollback-mod";
const PAGE_SLUG = "p6-2-rollback-page";
// issue #302 — production builds fail loudly unless a published page
// maps to index.html, so the fixture ships a root page too.
const HOME_SLUG = "home";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM deploy_runs`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug IN (${PAGE_SLUG}, ${HOME_SLUG}))`;
      await tx`DELETE FROM pages WHERE slug IN (${PAGE_SLUG}, ${HOME_SLUG})`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

let restoreSiteBaseUrl: (() => Promise<void>) | null = null;
let restoreSiteLanguage: (() => Promise<void>) | null = null;

beforeAll(async () => {
  await wipe();
  // #551 — canonicals need a configured base URL (no localhost default).
  restoreSiteBaseUrl = await pinSiteBaseUrl(ADMIN_URL!, "https://example.com");
  restoreSiteLanguage = await pinSiteLanguage(ADMIN_URL!, "en");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-p6-2-rb-"));
});

afterAll(async () => {
  await wipe();
  await restoreSiteBaseUrl?.();
  await restoreSiteLanguage?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("deploy.rollback", () => {
  it("re-targets current/ at a prior succeeded build", async () => {
    const t = await execute(registry, adapter, HUMAN, "templates.create", {
      slug: TPL_SLUG,
      displayName: "RB",
      html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
      css: "",
    });
    if (!t.ok) throw new Error("seed");
    const tplId = (t.value as { templateId: string }).templateId;
    await execute(registry, adapter, HUMAN, "template_blocks.set", {
      templateId: tplId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });

    const m = await execute(registry, adapter, HUMAN, "modules.create", {
      slug: MOD_SLUG,
      displayName: "M",
      html: "<p>VERSION_ONE</p>",
      // v0.12.2 — opt out of extractor to preserve literal HTML.
      fields: [{ name: "body", kind: "text", label: "Body" } as never],
    });
    if (!m.ok) throw new Error("seed");
    const modId = (m.value as { moduleId: string }).moduleId;

    const p = await execute(registry, adapter, HUMAN, "pages.create", {
      slug: PAGE_SLUG,
      title: "RB",
      templateId: tplId,
    });
    if (!p.ok) throw new Error("seed");
    const pageId = (p.value as { pageId: string }).pageId;
    await execute(registry, adapter, HUMAN, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [modId] }],
    });
    await execute(registry, adapter, HUMAN, "pages.update", { pageId, status: "published" });

    // issue #302 — a published root page so the full production builds
    // below pass the missing-root-page guard.
    const hp = await execute(registry, adapter, HUMAN, "pages.create", {
      slug: HOME_SLUG,
      title: "Home",
      templateId: tplId,
    });
    if (!hp.ok) throw new Error("home seed");
    const homePageId = (hp.value as { pageId: string }).pageId;
    await execute(registry, adapter, HUMAN, "pages.set_modules", {
      pageId: homePageId,
      blocks: [{ blockName: "content", moduleIds: [modId] }],
    });
    await execute(registry, adapter, HUMAN, "pages.update", {
      pageId: homePageId,
      status: "published",
    });
    // Builds refuse published pages without a meta description.
    const seo = await execute(registry, adapter, HUMAN, "pages_seo.autofill_many", {
      items: [
        { pageId, metaDescription: "The rollback page." },
        { pageId: homePageId, metaDescription: "Home of the rollback suite." },
      ],
    });
    if (!seo.ok) throw new Error("seo seed");

    // Build 1 — VERSION_ONE.
    await openQualityGate(adapter);
    const b1 = await execute(registry, adapter, HUMAN, "deploy.trigger", {
      targetName: "production",
      repoRoot: testRoot,
    });
    if (!b1.ok) throw new Error(`b1 ${JSON.stringify(b1.error)}`);
    const b1RunId = (b1.value as { runId: string }).runId;

    // Update module + build 2 — VERSION_TWO.
    await execute(registry, adapter, HUMAN, "modules.update", {
      moduleId: modId,
      html: "<p>VERSION_TWO</p>",
    });
    // The module change is new rendering: it needs a checked Stage first.
    await openQualityGate(adapter);
    const b2 = await execute(registry, adapter, HUMAN, "deploy.trigger", {
      targetName: "production",
      repoRoot: testRoot,
    });
    if (!b2.ok) throw new Error("b2");
    const b2RunId = (b2.value as { runId: string }).runId;

    // current/ now reflects VERSION_TWO.
    const currentDir = join(testRoot, "output", "production", "current");
    const pageFile = join(currentDir, PAGE_SLUG, "index.html");
    expect(existsSync(pageFile)).toBe(true);
    const v2 = await readFile(pageFile, "utf8");
    expect(v2).toContain("VERSION_TWO");

    // Rollback to build 1 — while a Firebase CDN purge holds the
    // live-release lock: the rollback must wait for it, never release in
    // between (the purge would re-release the version it read before).
    // #1225 — it waits outside any transaction and tries again: once for a
    // purge of this release (the lease row locked in its transaction), once
    // for a purge of the previous release (its advisory lock).
    const holds: ((tx: SQL) => Promise<unknown>)[] = [
      async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`INSERT INTO deploy_leases (name) VALUES (${LIVE_RELEASE_LEASE}) ON CONFLICT DO NOTHING`;
        await tx`UPDATE deploy_leases SET name = name WHERE name = ${LIVE_RELEASE_LEASE}`;
      },
      (tx) => tx`SELECT pg_advisory_xact_lock(hashtext(${LEGACY_LIVE_RELEASE_LOCK_KEY}))`,
    ];
    let rb: Awaited<ReturnType<typeof execute>> | null = null;
    for (const [i, hold] of holds.entries()) {
      const purge = new SQL(ADMIN_URL!);
      try {
        let endPurge!: () => void;
        const purgeDone = new Promise<void>((r) => {
          endPurge = r;
        });
        let purgeLocked!: () => void;
        const locked = new Promise<void>((r) => {
          purgeLocked = r;
        });
        const purgeTx = purge.begin(async (tx) => {
          await hold(tx as unknown as SQL);
          purgeLocked();
          await purgeDone;
        });
        await locked;
        let settled = false;
        const pending = execute(registry, adapter, HUMAN, "deploy.rollback", {
          targetName: "production",
          runId: i === 0 ? b1RunId : b2RunId,
          repoRoot: testRoot,
        }).finally(() => {
          settled = true;
        });
        await Bun.sleep(600);
        expect(settled).toBe(false);
        // Waiting holds no connection in a transaction.
        const open = (await purge`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = 'cms_admin' AND state LIKE 'idle in transaction%'
            AND pid <> pg_backend_pid()`) as { n: number }[];
        // The purge's own transaction is the only one open.
        expect(open[0]?.n).toBe(1);
        expect(await readFile(pageFile, "utf8")).toContain(i === 0 ? "VERSION_TWO" : "VERSION_ONE");
        endPurge();
        await purgeTx;
        rb = await pending;
        expect(rb.ok).toBe(true);
      } finally {
        await purge.end();
      }
      if (i === 0) {
        expect(await readFile(pageFile, "utf8")).toContain("VERSION_ONE");
      }
    }
    // A Publish live or plugin-data build of this release holds the lease
    // as its run, with no transaction to wait for: the rollback waits
    // outside any transaction until the run released it.
    const db0 = new SQL(ADMIN_URL!);
    const holder = crypto.randomUUID();
    try {
      await db0.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, lease_expires_at)
                 SELECT ${holder}::uuid, id, ${HUMAN.actorId}::uuid, 'running',
                        clock_timestamp() + interval '10 minutes'
                 FROM deploy_targets WHERE name = 'production'`;
        await tx`UPDATE deploy_leases SET holder_run_id = ${holder}::uuid,
                   acquired_at = clock_timestamp(), expires_at = clock_timestamp() + interval '10 minutes'
                 WHERE name = ${LIVE_RELEASE_LEASE}`;
      });
      let settled = false;
      const pending = execute(registry, adapter, HUMAN, "deploy.rollback", {
        targetName: "production",
        runId: b2RunId,
        repoRoot: testRoot,
      }).finally(() => {
        settled = true;
      });
      await Bun.sleep(600);
      expect(settled).toBe(false);
      const open = (await db0`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = 'cms_admin' AND state LIKE 'idle in transaction%'
          AND clock_timestamp() - state_change > interval '300 milliseconds'`) as { n: number }[];
      expect(open[0]?.n).toBe(0);
      await db0.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`UPDATE deploy_leases SET holder_run_id = NULL, acquired_at = NULL, expires_at = NULL
                 WHERE name = ${LIVE_RELEASE_LEASE}`;
        await tx`DELETE FROM deploy_runs WHERE id = ${holder}::uuid`;
      });
      expect((await pending).ok).toBe(true);
      expect(await readFile(pageFile, "utf8")).toContain("VERSION_TWO");
    } finally {
      await db0.end();
    }
    // Back on build 1 for the checks below.
    rb = await execute(registry, adapter, HUMAN, "deploy.rollback", {
      targetName: "production",
      runId: b1RunId,
      repoRoot: testRoot,
    });
    if (rb === null) throw new Error("no rollback ran");
    expect(rb.ok).toBe(true);
    if (!rb.ok) return;
    const v1 = await readFile(pageFile, "utf8");
    expect(v1).toContain("VERSION_ONE");
    expect(v1).not.toContain("VERSION_TWO");

    // Codex review on #652 — the rollback run records the publisher's
    // summary (Firebase: the Hosting version the rollback released), so it
    // can itself be the source of a later rollback.
    const newRunId = (rb.value as { newRunId: string }).newRunId;
    const db = new SQL(ADMIN_URL!);
    try {
      const rows = (await db.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return await tx`SELECT publish_summary->>'location' AS location
                        FROM deploy_runs WHERE id = ${newRunId}::uuid`;
      })) as { location: string | null }[];
      expect(rows[0]?.location).toMatch(/current\/$/);
    } finally {
      await db.end();
    }
    const again = await execute(registry, adapter, HUMAN, "deploy.rollback", {
      targetName: "production",
      runId: newRunId,
      repoRoot: testRoot,
    });
    expect(again.ok).toBe(true);
  });
});
