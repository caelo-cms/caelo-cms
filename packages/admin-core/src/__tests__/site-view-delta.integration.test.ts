// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1270 — the cached site view, carried forward by the change
 * journal, is the view a whole read gives (maintained == rebuilt,
 * docs/dev/state-and-changes.md), and the delta reads what changed, not
 * the site.
 *
 * Each step writes the way the admin or an outside session does (raw rows,
 * a branch's pending snapshot, a header undo), then loads the view
 * through the cache and compares it, in the same transaction, with a
 * whole read at the same mark. The page read of a delta names its pages
 * (`p.id = ANY(...)`); a whole read has no id filter. Past
 * MAX_DELTA_CHANGES journal rows the cache reads the whole site again,
 * and is still exact.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { clearSiteViewCache, loadSiteView, readSiteView } from "../site-view.js";
import { MAX_DELTA_CHANGES } from "../site-view-read.js";
import { COST_SYSTEM, type CostSite, setupCostSite } from "./_preview-cost.js";

let site: CostSite;
let adapter: DatabaseAdapter;
let statements: string[] = [];
let counting = false;
const fillerIds: string[] = [];

beforeAll(async () => {
  site = await setupCostSite({ plugins: false });
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const publicUrl = process.env.PUBLIC_ADMIN_DATABASE_URL;
  if (!adminUrl || !publicUrl) throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: adminUrl,
    publicDatabaseUrl: publicUrl,
    onStatement: (s) => {
      if (counting) statements.push(s);
    },
  });
  const rows = await site.asSystem(
    async (tx) =>
      (await tx`SELECT id::text AS id FROM pages WHERE slug LIKE 'cost-filler-%' ORDER BY slug`) as {
        id: string;
      }[],
  );
  fillerIds.push(...rows.map((r) => r.id));
  clearSiteViewCache();
});

afterAll(async () => {
  clearSiteViewCache();
  await adapter.close();
  await site.close();
});

/** The page reads of the last load: `delta` names its pages, `whole` does not. */
function pageReads(): { delta: number; whole: number } {
  const reads = statements.filter(
    (s) => /FROM pages p\b/.test(s) && /ORDER BY p\.current_path/.test(s),
  );
  const delta = reads.filter((s) => /p\.id = ANY\(/.test(s)).length;
  return { delta, whole: reads.length - delta };
}

/** Load through the cache and compare with a whole read at the same mark. */
async function loadAndCompare(branchId: string | null): Promise<{ delta: number; whole: number }> {
  statements = [];
  counting = true;
  const { cached, fresh } = await adapter.withAdminTransaction(COST_SYSTEM, async (tx) => {
    const cached = await loadSiteView(tx, branchId);
    counting = false;
    return { cached, fresh: await readSiteView(tx, branchId, cached.mark) };
  });
  counting = false;
  expect(cached).toEqual(fresh);
  return pageReads();
}

const both = async (): Promise<{
  main: { delta: number; whole: number };
  branch: { delta: number; whole: number };
}> => ({
  main: await loadAndCompare(null),
  branch: await loadAndCompare(site.branchId),
});

async function pendingSnapshot(pageId: string, slug: string): Promise<string> {
  return site.asSystem(async (tx) => {
    const [live] = (await tx`
      SELECT title, short_title, template_id::text AS template_id, status, version,
             page_type_id::text AS page_type_id
      FROM pages WHERE id = ${pageId}::uuid
    `) as {
      title: string;
      short_title: string;
      template_id: string;
      status: string;
      version: string;
      page_type_id: string;
    }[];
    if (!live) throw new Error("page missing");
    const [snap] = (await tx`
      INSERT INTO site_snapshots (actor_id, op_kind, description, chat_branch_id)
      VALUES (${COST_SYSTEM.actorId}::uuid, 'unknown', 'site view delta: pending rename',
              ${site.branchId}::uuid)
      RETURNING id::text AS id
    `) as { id: string }[];
    if (!snap) throw new Error("no snapshot header");
    const state = {
      schemaVersion: 1,
      slug,
      title: live.title,
      shortTitle: live.short_title,
      templateId: live.template_id,
      status: live.status,
      version: Number(live.version) + 1,
      deletedAt: null,
      parentPageId: null,
      pageTypeId: live.page_type_id,
      pageTypeConfirmed: true,
      properties: {},
      terms: [],
    };
    await tx`
      INSERT INTO page_snapshots (site_snapshot_id, page_id, state)
      VALUES (${snap.id}::uuid, ${pageId}::uuid, ${state}::jsonb)
    `;
    return snap.id;
  });
}

describe("site view delta (#1270)", () => {
  it("reads the whole site once per branch, then serves an unchanged one from the cache", async () => {
    const first = await both();
    expect(first.main.whole).toBe(1);
    expect(first.branch.whole).toBe(1);
    const again = await both();
    expect(again.main).toEqual({ delta: 0, whole: 0 });
    expect(again.branch).toEqual({ delta: 0, whole: 0 });
  });

  it("carries a title edit, a move and SEO forward by re-reading only those pages", async () => {
    const [a, b] = fillerIds;
    await site.asSystem(async (tx) => {
      await tx`UPDATE pages SET title = 'Edited in place' WHERE id = ${a}::uuid`;
      // A new path: the page changes place in the view's order.
      await tx`UPDATE pages SET current_path = '/aaa-moved-first' WHERE id = ${b}::uuid`;
      await tx`UPDATE pages_seo SET meta_description = 'Changed', canonical_url = 'https://x.example/c'
               WHERE page_id = ${a}::uuid`;
    });
    const r = await both();
    expect(r.main).toEqual({ delta: 1, whole: 0 });
    expect(r.branch).toEqual({ delta: 1, whole: 0 });
  });

  it("adds a new page and drops a deleted one", async () => {
    const [, , gone] = fillerIds;
    await site.asSystem(async (tx) => {
      await tx`UPDATE pages SET deleted_at = now() WHERE id = ${gone}::uuid`;
    });
    await site.seedFillerPages(150, 152);
    const r = await both();
    expect(r.main.whole).toBe(0);
    expect(r.branch.whole).toBe(0);
  });

  it("shows a branch's pending rename on that branch, and its undo", async () => {
    const [, , , d] = fillerIds;
    const headerId = await pendingSnapshot(d ?? "", "renamed-on-branch");
    const pending = await both();
    expect(pending.branch).toEqual({ delta: 1, whole: 0 });
    const view = await adapter.withAdminTransaction(COST_SYSTEM, (tx) =>
      loadSiteView(tx, site.branchId),
    );
    expect(view.pages.find((p) => p.id === d)?.slug).toBe("renamed-on-branch");
    expect(view.driftedIds).toContain(d);

    // Undo marks the header: the page's pending state is gone.
    await site.asSystem(async (tx) => {
      await tx`UPDATE site_snapshots SET undone_at = now() WHERE id = ${headerId}::uuid`;
    });
    const undone = await both();
    expect(undone.branch.whole).toBe(0);
    const after = await adapter.withAdminTransaction(COST_SYSTEM, (tx) =>
      loadSiteView(tx, site.branchId),
    );
    expect(after.pages.find((p) => p.id === d)?.slug).not.toBe("renamed-on-branch");
  });

  it("counts a write the reading transaction made after it read the view", async () => {
    const [, , , , e] = fillerIds;
    await loadAndCompare(null);
    await adapter.withAdminTransaction(COST_SYSTEM, async (tx) => {
      // An xid first (a header insert, which the view's filter drops), so
      // the view read below is cached with this transaction's own xid.
      await tx.execute(sql`INSERT INTO site_snapshots (actor_id, op_kind, description)
        VALUES (${COST_SYSTEM.actorId}::uuid, 'unknown', 'site view delta: own xid')`);
      // A later transaction commits first: the mark's xmax is then past this
      // transaction's xid, which Postgres leaves out of its own snapshot's
      // in-flight list — so the snapshot alone counts it as seen.
      await site.asSystem(async (other) => {
        await other`INSERT INTO site_snapshots (actor_id, op_kind, description)
          VALUES (${COST_SYSTEM.actorId}::uuid, 'unknown', 'site view delta: later xid')`;
      });
      const before = await loadSiteView(tx, null);
      expect(before.mark.ownXid).not.toBeNull();
      expect(before.mark.dirty).toBe(false);
      const [xmax] = before.mark.snapshot.split(":").slice(1);
      expect(BigInt(xmax ?? "0")).toBeGreaterThan(BigInt(before.mark.ownXid ?? "0"));
      await tx.execute(
        sql`UPDATE pages SET title = 'Written after the read' WHERE id = ${e}::uuid`,
      );
    });
    const r = await loadAndCompare(null);
    expect(r.whole).toBe(0);
    const view = await adapter.withAdminTransaction(COST_SYSTEM, (tx) => loadSiteView(tx, null));
    expect(view.pages.find((p) => p.id === e)?.title).toBe("Written after the read");
  });

  it("shows the reading transaction's own earlier write (a dirty mark)", async () => {
    const [, , , , , f] = fillerIds;
    await loadAndCompare(null);
    await adapter.withAdminTransaction(COST_SYSTEM, async (tx) => {
      await tx.execute(
        sql`UPDATE pages SET title = 'Written before the read' WHERE id = ${f}::uuid`,
      );
      const view = await loadSiteView(tx, null);
      expect(view.mark.dirty).toBe(true);
      expect(view.pages.find((p) => p.id === f)?.title).toBe("Written before the read");
      expect(view).toEqual(await readSiteView(tx, null, view.mark));
    });
  });

  it("reads the whole site again past MAX_DELTA_CHANGES journal rows, still exact", async () => {
    await site.seedFillerPages(152, 152 + MAX_DELTA_CHANGES + 1);
    const r = await both();
    expect(r.main.whole).toBe(1);
    expect(r.branch.whole).toBe(1);
  });
});
