// SPDX-License-Identifier: MPL-2.0

/**
 * #390 — the URL-diff engine end to end against real Postgres: a
 * URL-plugin activation reshapes composed paths, the diff proposes,
 * execute updates current_path + creates the redirect fan-out in one
 * tx, the zero-diff re-propose refuses, and deactivating the plugin
 * (registry reset) diffs BACK from the materialized paths — proving
 * decision 4's "works after the causing plugin is gone".
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { bootstrap, resetPluginHost, urlContributionsRegistry } from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { PENDING_TABLES } from "../ops/cancel_proposal.js";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoHomePageType } from "./_template-page-type.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t390",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

/** Mutable per-page locale map the test plugin's annotation op reads. */
const localeByPage = new Map<string, string>();

const intlPlugin = definePlugin({
  slug: "t390-intl",
  version: "0.1.0",
  tier: 1,
  schema: {},
  operations: {
    url_annotations: async (_ctx, args) => {
      const { pageIds } = args as { pageIds: string[] };
      const annotations: Record<string, Record<string, unknown>> = {};
      for (const id of pageIds) {
        annotations[id] = { locale: localeByPage.get(id) ?? "en" };
      }
      return { annotations };
    },
  },
  urlAnnotationsOperation: "url_annotations",
  urlContributions: [
    {
      slot: "path-prefix",
      encode: (page) => {
        const locale = page.annotations.locale;
        return typeof locale === "string" && locale !== "en" ? [locale] : [];
      },
      decode: (segments) => {
        const head = segments[0];
        return head === "de" ? { consumed: 1, annotations: { locale: "de" } } : null;
      },
    },
  ],
});

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  localeByPage.clear();
  await sqlSystem(async (tx) => {
    await tx.unsafe("DELETE FROM url_migration_pending_actions");
    await tx.unsafe(
      "DELETE FROM redirects WHERE from_path LIKE '/t390-%' OR to_path LIKE '/de/t390-%'",
    );
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't390-%')
    )`);
    await tx.unsafe(
      "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't390-%')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't390-%'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't390-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't390-%'");
    await tx.unsafe("DELETE FROM layouts WHERE slug LIKE 't390-%'");
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

async function seedPage(slug: string): Promise<string> {
  return sqlSystem(async (tx) => {
    const lay = (await tx.unsafe(
      `INSERT INTO layouts (slug, display_name, html, css)
       VALUES ('${slug}-lay', 'L', '<html><body><caelo-layout-content></caelo-layout-content></body></html>', '')
       RETURNING id::text AS id`,
    )) as { id: string }[];
    const tpl = (await tx.unsafe(
      `INSERT INTO templates (slug, display_name, html, css, layout_id)
       VALUES ('${slug}-tpl', 'T', '<main></main>', '', '${lay[0]?.id}')
       RETURNING id::text AS id`,
    )) as { id: string }[];
    await adoptTemplateIntoHomePageType(tx, tpl[0]?.id ?? "");
    const pg = (await tx.unsafe(
      `INSERT INTO pages (slug, short_title, title, template_id, status, page_type_confirmed)
       VALUES ('${slug}', 'P', 'P', '${tpl[0]?.id}', 'published', true)
       RETURNING id::text AS id, current_path`,
    )) as { id: string; current_path: string }[];
    const row = pg[0];
    if (!row) throw new Error("seed failed");
    // The 0211 trigger derived the composition-free default.
    if (row.current_path !== `/${slug}`) {
      throw new Error(`trigger default wrong: ${row.current_path}`);
    }
    return row.id;
  });
}

describe("#390 — URL-diff engine", () => {
  it("activation → propose → execute moves pages + creates redirects; re-propose refuses; deactivation diffs back", async () => {
    const pageA = await seedPage("t390-alpha");
    const pageB = await seedPage("t390-beta");

    // Activate the URL plugin; alpha becomes a de-page.
    await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: intlPlugin }],
    });
    localeByPage.set(pageA, "de");
    localeByPage.set(pageB, "en");

    // Propose: only alpha moves.
    const proposed = await execute(registry, adapter, SYS_CTX, "url_migrations.propose_migrate", {
      reason: "activate t390-intl",
    });
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const { proposalId, preview } = proposed.value as {
      proposalId: string;
      preview: { pagesMoved: number; sample: string[] };
    };
    expect(preview.pagesMoved).toBe(1);
    expect(preview.sample[0]).toBe("/t390-alpha → /de/t390-alpha");

    // Execute: current_path updated + 301 created, one tx.
    const applied = await execute(registry, adapter, SYS_CTX, "url_migrations.execute_proposal", {
      proposalId,
    });
    if (!applied.ok) throw new Error(JSON.stringify(applied.error));
    expect(applied.value).toEqual({ pagesMoved: 1, redirectsCreated: 1 });

    const after = await sqlSystem(async (tx) => {
      const paths = (await tx.unsafe(
        `SELECT slug, current_path FROM pages WHERE slug LIKE 't390-%' ORDER BY slug`,
      )) as { slug: string; current_path: string }[];
      const redirects = (await tx.unsafe(
        `SELECT from_path, to_path, status_code FROM redirects WHERE from_path = '/t390-alpha'`,
      )) as { from_path: string; to_path: string; status_code: number }[];
      return { paths, redirects };
    });
    expect(after.paths).toEqual([
      { slug: "t390-alpha", current_path: "/de/t390-alpha" },
      { slug: "t390-beta", current_path: "/t390-beta" },
    ]);
    expect(after.redirects).toEqual([
      { from_path: "/t390-alpha", to_path: "/de/t390-alpha", status_code: 301 },
    ]);

    // Zero diff now — the re-propose refuses (AI-actionable, no junk row).
    const again = await execute(registry, adapter, SYS_CTX, "url_migrations.propose_migrate", {});
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(JSON.stringify(again.error)).toContain("no URL changes");
    }

    // Deactivate (registry reset = plugin gone). The diff computes FROM
    // the materialized paths — alpha moves back even though the plugin
    // that put it at /de/ no longer exists.
    urlContributionsRegistry.reset();
    const back = await execute(registry, adapter, SYS_CTX, "url_migrations.propose_migrate", {
      reason: "deactivate t390-intl",
    });
    if (!back.ok) throw new Error(JSON.stringify(back.error));
    const backPreview = (back.value as { preview: { sample: string[] } }).preview;
    expect(backPreview.sample[0]).toBe("/de/t390-alpha → /t390-alpha");
    const backApplied = await execute(
      registry,
      adapter,
      SYS_CTX,
      "url_migrations.execute_proposal",
      { proposalId: (back.value as { proposalId: string }).proposalId },
    );
    expect(backApplied.ok).toBe(true);
    const finalPaths = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(`SELECT current_path FROM pages WHERE id = '${pageA}'`)) as {
          current_path: string;
        }[],
    );
    expect(finalPaths[0]?.current_path).toBe("/t390-alpha");
  });

  it("stale proposal aborts loudly instead of applying wrong paths", async () => {
    localeByPage.clear();
    const pageC = await seedPage("t390-gamma");
    await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: intlPlugin }],
    });
    localeByPage.set(pageC, "de");
    const proposed = await execute(
      registry,
      adapter,
      SYS_CTX,
      "url_migrations.propose_migrate",
      {},
    );
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    // The site moves underneath the pending proposal.
    await sqlSystem(async (tx) => {
      await tx.unsafe(`UPDATE pages SET current_path = '/t390-gamma-moved' WHERE id = '${pageC}'`);
    });
    const applied = await execute(registry, adapter, SYS_CTX, "url_migrations.execute_proposal", {
      proposalId: (proposed.value as { proposalId: string }).proposalId,
    });
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(JSON.stringify(applied.error)).toContain("stale proposal");
    }
  });

  // #684 — the Owner queue at /settings/url_migrations/pending lists and
  // rejects; before these ops a queued migration could only ever wait.
  it("list_pending shows the queued migration; reject closes it; the AI cannot reject", async () => {
    // Earlier cases leave stale pages (t390-gamma) behind; start clean.
    await cleanup();
    const pageD = await seedPage("t390-delta");
    // A stored path that no longer matches the (plugin-free) resolution.
    await sqlSystem(async (tx) => {
      await tx.unsafe(`UPDATE pages SET current_path = '/de/t390-delta' WHERE id = '${pageD}'`);
    });
    const proposed = await execute(registry, adapter, SYS_CTX, "url_migrations.propose_migrate", {
      reason: "queue check",
    });
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const { proposalId } = proposed.value as { proposalId: string };

    const listed = await execute(registry, adapter, SYS_CTX, "url_migrations.list_pending", {});
    if (!listed.ok) throw new Error(JSON.stringify(listed.error));
    const rows = (listed.value as { proposals: { id: string; preview: { pagesMoved: number } }[] })
      .proposals;
    expect(rows.map((r) => r.id)).toEqual([proposalId]);
    expect(rows[0]?.preview.pagesMoved).toBe(1);

    const aiReject = await execute(
      registry,
      adapter,
      { ...SYS_CTX, actorKind: "ai" },
      "url_migrations.reject_proposal",
      { proposalId },
    );
    expect(aiReject.ok).toBe(false);

    const rejected = await execute(registry, adapter, SYS_CTX, "url_migrations.reject_proposal", {
      proposalId,
      reason: "not now",
    });
    expect(rejected.ok).toBe(true);
    const after = await execute(registry, adapter, SYS_CTX, "url_migrations.list_pending", {});
    expect(after.ok && (after.value as { proposals: unknown[] }).proposals).toEqual([]);

    const twice = await execute(registry, adapter, SYS_CTX, "url_migrations.reject_proposal", {
      proposalId,
    });
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(JSON.stringify(twice.error)).toContain("already decided");

    // Rejecting moved nothing.
    const path = await sqlSystem(
      (tx) =>
        tx.unsafe(`SELECT current_path FROM pages WHERE id = '${pageD}'`) as Promise<
          { current_path: string }[]
        >,
    );
    expect(path[0]?.current_path).toBe("/de/t390-delta");
  });

  // #699 — the AI withdraws a URL-migration proposal it queued in error.
  it("the AI cancels its own pending migration; another actor cannot", async () => {
    await cleanup();
    const pageE = await seedPage("t390-epsilon");
    await sqlSystem(async (tx) => {
      await tx.unsafe(`UPDATE pages SET current_path = '/de/t390-epsilon' WHERE id = '${pageE}'`);
    });
    const AI_CTX: ExecutionContext = { ...SYS_CTX, actorKind: "ai" };
    const proposed = await execute(registry, adapter, AI_CTX, "url_migrations.propose_migrate", {
      reason: "queued in error",
    });
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const { proposalId } = proposed.value as { proposalId: string };

    const foreign = await execute(
      registry,
      adapter,
      { ...AI_CTX, actorId: "00000000-0000-0000-0000-00000000eeee" },
      "pending_proposals.cancel",
      { proposalId },
    );
    expect(foreign.ok).toBe(false);

    const cancelled = await execute(registry, adapter, AI_CTX, "pending_proposals.cancel", {
      proposalId,
      reason: "wrong plugin",
    });
    if (!cancelled.ok) throw new Error(JSON.stringify(cancelled.error));
    expect(cancelled.value).toEqual({ cancelled: true, domain: "url_migrations" });

    const row = await sqlSystem(
      (tx) =>
        tx.unsafe(
          `SELECT status, decision_reason FROM url_migration_pending_actions WHERE id = '${proposalId}'`,
        ) as Promise<{ status: string; decision_reason: string }[]>,
    );
    expect(row[0]).toEqual({ status: "cancelled", decision_reason: "wrong plugin" });
    const queue = await execute(registry, adapter, SYS_CTX, "url_migrations.list_pending", {});
    expect(queue.ok && (queue.value as { proposals: unknown[] }).proposals).toEqual([]);
    // Withdrawing moved nothing.
    const path = await sqlSystem(
      (tx) =>
        tx.unsafe(`SELECT current_path FROM pages WHERE id = '${pageE}'`) as Promise<
          { current_path: string }[]
        >,
    );
    expect(path[0]?.current_path).toBe("/de/t390-epsilon");
  });

  it("pending_proposals.cancel covers every *_pending_actions table, and each allows 'cancelled'", async () => {
    const tables = await sqlSystem(
      (tx) =>
        tx.unsafe(`
          SELECT c.relname AS name, pg_get_constraintdef(k.oid) AS status_check
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
            LEFT JOIN pg_constraint k
              ON k.conrelid = c.oid AND k.contype = 'c' AND k.conname = c.relname || '_status_check'
           WHERE c.relkind = 'r' AND c.relname LIKE '%\\_pending\\_actions'
           ORDER BY 1`) as Promise<{ name: string; status_check: string | null }[]>,
    );
    expect(tables.length).toBeGreaterThan(10);
    expect(tables.map((t) => t.name)).toEqual([...PENDING_TABLES].sort());
    for (const t of tables) expect(`${t.name}: ${t.status_check}`).toContain("'cancelled'");
  });
});
