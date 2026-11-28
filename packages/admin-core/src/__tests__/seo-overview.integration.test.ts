// SPDX-License-Identifier: MPL-2.0

/**
 * #1757, #1760 — `pages_seo.overview` against real Postgres: each page's
 * head with its origins, the latest finished Stage audit's findings, the
 * filters, keyset paging, by ids; and the seo plugin may call it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "seo-overview-int",
};
const PFX = "t1760ov";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const ids: Record<string, string> = {};

async function asSystem<T>(body: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return body(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function ok<T>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

type Row = {
  pageId: string;
  path: string;
  seoTitle: { value: string; origin: string };
  metaDescription: { value: string; origin: string };
  noindex: boolean;
  findings: { ruleId: string }[];
};

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const { templateId } = await ok<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: "Ov T",
    html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  for (const slug of ["a", "b", "c"]) {
    const { pageId } = await ok<{ pageId: string }>("pages.create", {
      slug: `${PFX}-${slug}`,
      title: `Ov ${slug.toUpperCase()}`,
      templateId,
    });
    ids[slug] = pageId;
  }
  // a: its own title and description; b: noindex, nothing of its own; c: untouched.
  await ok("pages_seo.set", {
    pageId: ids.a,
    seoTitle: "Own title of A",
    metaDescription: "What A is about.",
  });
  await ok("pages_seo.set", { pageId: ids.b, noindex: true });
  // A finished audit that found something on a.
  await asSystem(async (tx) => {
    const deploy = crypto.randomUUID();
    await tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, started_at, finished_at)
             SELECT ${deploy}::uuid, t.id, ${SYS.actorId}::uuid, 'succeeded', now(), now()
               FROM deploy_targets t WHERE t.name = 'staging'`;
    const run = (await tx`
      INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, finished_at)
      VALUES (${deploy}::uuid, ${SYS.actorId}::uuid, 'problems', '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now())
      RETURNING id::text AS id`) as { id: string }[];
    await tx`
      INSERT INTO quality_audit_pages (audit_run_id, page_id, url, status, check_findings)
      VALUES (${run[0]?.id}::uuid, ${ids.a}::uuid, 'https://x.example/a/', 'problems',
              (${JSON.stringify([{ ruleId: "plugin.seo/h1-count", severity: "error", message: "No H1." }])}::text)::jsonb)`;
  });
});

afterAll(async () => {
  await asSystem(async (tx) => {
    await tx`DELETE FROM quality_audit_pages WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}-%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}-%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}-%`}`;
  });
  await adapter.close();
});

describe("pages_seo.overview", () => {
  it("answers each page's head with its origins and the last Stage's findings", async () => {
    const { pages } = await ok<{ pages: Row[] }>("pages_seo.overview", {
      pageIds: [ids.a, ids.b, ids.c],
    });
    const byId = new Map(pages.map((p) => [p.pageId, p]));
    // The page's own texts: written by whoever set them (a person or the AI).
    const own = byId.get(ids.a as string);
    expect(own?.seoTitle.value).toBe("Own title of A");
    expect(["human", "ai"]).toContain(own?.seoTitle.origin as string);
    expect(["human", "ai"]).toContain(own?.metaDescription.origin as string);
    expect(byId.get(ids.a as string)?.findings.map((f) => f.ruleId)).toEqual([
      "plugin.seo/h1-count",
    ]);
    expect(byId.get(ids.b as string)?.noindex).toBe(true);
    // No description of its own and no template for it: unset.
    expect(byId.get(ids.c as string)?.metaDescription.origin).toBe("unset");
    expect(byId.get(ids.c as string)?.findings).toEqual([]);
  });

  it("filters by finding and by origin, and pages by path", async () => {
    const withFinding = await ok<{ pages: Row[] }>("pages_seo.overview", {
      pageIds: [ids.a, ids.b, ids.c],
      finding: "plugin.seo/",
    });
    expect(withFinding.pages.map((p) => p.pageId)).toEqual([ids.a]);
    const unset = await ok<{ pages: Row[] }>("pages_seo.overview", {
      pageIds: [ids.a, ids.b, ids.c],
      origin: "unset",
    });
    expect(unset.pages.map((p) => p.pageId).sort()).toEqual([ids.b, ids.c].sort());
    // Keyset paging over every page: no page twice, none left out.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const page = await ok<{ pages: Row[]; nextCursor: string | null }>("pages_seo.overview", {
        limit: 2,
        withFindings: false,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.pages.map((p) => p.pageId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of Object.values(ids)) expect(seen).toContain(id);
  });

  it("refuses a cursor it did not write", async () => {
    const r = await execute(registry, adapter, SYS, "pages_seo.overview", { cursor: "bm9wZQ" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.ok ? null : r.error)).toContain("not a pages_seo.overview cursor");
  });
});
