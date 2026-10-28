// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1212 — the preview's cached site view never serves a stale page.
 *
 * The site view (every page, SEO summary, media asset, list, setting) is
 * kept in memory per branch and re-read only when the site-view
 * generation (migration 0394) moved. These writes must each show in the
 * very next preview:
 *
 *   - a raw write with no actor at all (a fixture, psql, a migration):
 *     a linked page's path, the site base URL in the canonical;
 *   - a chat's pending page edit (a branch snapshot), which renames the
 *     linked page in that chat's preview only;
 *   - an op write (the main-line rename through `pages.update`).
 *
 * And an unchanged draft is served from the cache: the second render
 * reads only the generation, not the site.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execute } from "@caelo-cms/query-api";
import { COST_SYSTEM, type CostSite, setupCostSite } from "./_preview-cost.js";

let site: CostSite;
let linkedId = "";

/** The hero link's path, without the publish target's trailing slash. */
const hrefTo = (html: string) =>
  /<a href="([^"]*)">Go<\/a>/.exec(html)?.[1]?.replace(/(.)\/$/, "$1");
const canonicalOf = (html: string) => /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1];

beforeAll(async () => {
  site = await setupCostSite({ plugins: false });
  linkedId = await site.asSystem(async (tx) => {
    const rows = (await tx`SELECT id::text AS id FROM pages WHERE slug = 'cost-filler-2'`) as {
      id: string;
    }[];
    return rows[0]?.id ?? "";
  });
});

afterAll(async () => {
  await site.close();
});

describe("preview site-view cache (#1212)", () => {
  it("serves an unchanged draft from the cache", async () => {
    await site.measure();
    const { cold, warm } = await site.measure();
    // The first render of measure() after an earlier one is already warm.
    expect(warm).toBe(cold);
    expect(site.lastStatements().some((s) => /FROM media_assets WHERE deleted_at IS NULL/.test(s))).toBe(false);
    expect(site.lastStatements().some((s) => /site_view_generation/.test(s))).toBe(true);
  });

  it("shows a raw write with no actor in the next preview", async () => {
    expect(hrefTo((await site.render({ pageId: site.pageId })).html)).toBe("/cost-filler-2");
    await site.asSystem(async (tx) => {
      await tx`UPDATE pages SET current_path = '/moved-by-psql' WHERE id = ${linkedId}::uuid`;
    });
    expect(hrefTo((await site.render({ pageId: site.pageId })).html)).toBe("/moved-by-psql");

    expect(canonicalOf((await site.render({ pageId: site.pageId })).html)).toStartWith(
      "https://example.com/",
    );
    await site.asSystem(async (tx) => {
      await tx`UPDATE site_defaults SET site_base_url = 'https://changed.example.org' WHERE id = 1`;
    });
    expect(canonicalOf((await site.render({ pageId: site.pageId })).html)).toStartWith(
      "https://changed.example.org/",
    );
    await site.asSystem(async (tx) => {
      await tx`UPDATE site_defaults SET site_base_url = 'https://example.com' WHERE id = 1`;
      await tx`UPDATE pages SET current_path = '/cost-filler-2' WHERE id = ${linkedId}::uuid`;
    });
  });

  it("shows a chat's pending rename in that chat's preview only", async () => {
    const branch = { pageId: site.pageId, chatBranchId: site.branchId };
    expect(hrefTo((await site.render(branch)).html)).toBe("/cost-filler-2");
    await site.asSystem(async (tx) => {
      const [live] = (await tx`
        SELECT title, short_title, template_id::text AS template_id, status, version,
               page_type_id::text AS page_type_id
        FROM pages WHERE id = ${linkedId}::uuid
      `) as {
        title: string;
        short_title: string;
        template_id: string;
        status: string;
        version: string;
        page_type_id: string;
      }[];
      if (!live) throw new Error("linked page missing");
      const [snap] = (await tx`
        INSERT INTO site_snapshots (actor_id, op_kind, description, chat_branch_id)
        VALUES (${COST_SYSTEM.actorId}::uuid, 'unknown', 'preview cache: pending rename',
                ${site.branchId}::uuid)
        RETURNING id::text AS id
      `) as { id: string }[];
      const state = {
        schemaVersion: 1,
        slug: "renamed-in-chat",
        title: live.title,
        shortTitle: live.short_title,
        templateId: live.template_id,
        status: live.status,
        version: Number(live.version) + 1,
        deletedAt: null,
        parentPageId: null,
        pageTypeId: live.page_type_id,
        properties: {},
        terms: [],
      };
      await tx`
        INSERT INTO page_snapshots (site_snapshot_id, page_id, state)
        VALUES (${snap?.id}::uuid, ${linkedId}::uuid, ${state}::jsonb)
      `;
    });
    expect(hrefTo((await site.render(branch)).html)).toBe("/renamed-in-chat");
    expect(hrefTo((await site.render({ pageId: site.pageId })).html)).toBe("/cost-filler-2");
  });

  it("shows an op write in the next preview", async () => {
    const r = await execute(site.registry, site.adapter, COST_SYSTEM, "pages.update", {
      pageId: linkedId,
      slug: "renamed-by-op",
    });
    if (!r.ok) throw new Error(`pages.update: ${JSON.stringify(r.error)}`);
    expect(hrefTo((await site.render({ pageId: site.pageId })).html)).toBe("/renamed-by-op");
  });
});
