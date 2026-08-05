// SPDX-License-Identifier: MPL-2.0

/**
 * issue #425 — locale-aware crawl scope + final-URL provenance, end to
 * end at the DB boundary (the import-list-mode / import-pipeline-stage
 * pattern: real ops against real Postgres, the crawler driven with an
 * injected fixture site exactly the way the orchestrator drives it).
 *
 * Pins the two dogfood failures:
 *   - REDIRECTING fixture: a sample whose requested URL redirects is
 *     stored under its FINAL URL (`import_pages.source_url`) with the
 *     requested URL kept as provenance (`requested_url`).
 *   - SCOPED fixture: a `/de/`-scoped crawl fetches only in-scope pages;
 *     out-of-scope URLs (frontier/list entries AND out-of-scope redirect
 *     landings) are recorded as skipped, and the run report states the
 *     active scope + the skipped-out-of-scope count (CLAUDE.md §2).
 *
 * CI-only: requires the two real Postgres URLs (mocks are banned for
 * Query API tests — CLAUDE.md §6). Not run locally (dev-DB truncation).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { type CrawledPage, crawlSite, estimateListScope } from "@caelo-cms/site-importer";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let systemCtx: ExecutionContext;

const ORIGIN = "https://svscope-425.example";
const SOURCE_URL = `${ORIGIN}/de/`;
const ACTOR_EMAIL = "import-locale-scope-actor@example.com";
const SCOPE = { pathPrefix: "/de/" };
// One in-scope redirect (provenance case), one out-of-scope list entry
// (never fetched), one redirect landing outside the scope (dropped).
const CHOSEN = [`${ORIGIN}/de/alt-artikel`, `${ORIGIN}/en/pricing`, `${ORIGIN}/de/weg`];

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM import_runs WHERE source_url = ${SOURCE_URL}`;
      await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ${ACTOR_EMAIL})`;
    });
  } finally {
    await sql.end();
  }
}

/** The orchestrator's post-crawl crawl_state slice (#192/#425), verbatim. */
async function writeCrawlStateSlice(
  runId: string,
  slice: { errors: unknown; skipped: unknown; skippedOutOfScope: number },
): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`UPDATE import_runs SET crawl_state = ${JSON.stringify(slice)}::jsonb WHERE id = ${runId}::uuid`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const bootstrapCtx: ExecutionContext = {
    actorId: "00000000-0000-0000-0000-00000000ffff",
    actorKind: "system",
    requestId: "import-locale-scope-bootstrap",
  };
  const created = await execute(registry, adapter, bootstrapCtx, "users.create", {
    email: ACTOR_EMAIL,
    password: "lantern-willow-68",
    displayName: "Import Locale Scope Actor",
    roleNames: [],
  });
  if (!created.ok) throw new Error(`users.create failed: ${created.error.kind}`);
  systemCtx = {
    actorId: (created.value as { userId: string }).userId,
    actorKind: "system",
    requestId: "import-locale-scope-test",
  };
  await wipe();
});

afterAll(async () => {
  await wipe();
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM users WHERE email = ${ACTOR_EMAIL}`;
    });
  } finally {
    await sql.end();
  }
  await adapter.close();
});

describe("locale-aware scoped import (#425)", () => {
  it("rejects a proposal whose sourceUrl lies outside the scope prefix, actionably", async () => {
    const r = await execute(registry, adapter, systemCtx, "imports.propose_run", {
      sourceUrl: `${ORIGIN}/`,
      depth: 2,
      scope: SCOPE,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.error)).toContain("outside scope.pathPrefix");
  });

  it("propose → approve → scoped crawl: final URLs + provenance persisted, scope + skips reported", async () => {
    // Propose a scoped LIST run (the #278 pilot shape).
    const proposed = await execute(registry, adapter, systemCtx, "imports.propose_run", {
      sourceUrl: SOURCE_URL,
      urls: CHOSEN,
      scope: SCOPE,
      estimate: estimateListScope(CHOSEN.length),
    });
    if (!proposed.ok) throw new Error(`propose_run ${JSON.stringify(proposed.error)}`);
    const runId = (proposed.value as { runId: string }).runId;

    // The read surface echoes the scope the Owner is approving.
    const got = await execute(registry, adapter, systemCtx, "imports.get", { runId });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const run = (got.value as { run: { crawlScope: unknown; explicitUrls: string[] | null } }).run;
    expect(run.crawlScope).toEqual(SCOPE);
    expect(run.explicitUrls).toEqual(CHOSEN);

    // Owner approves (unpriced list estimate ⇒ explicit budget, #297).
    const approved = await execute(registry, adapter, systemCtx, "imports.execute_proposal", {
      runId,
      ceiling: 5,
    });
    if (!approved.ok) throw new Error(`execute_proposal ${JSON.stringify(approved.error)}`);

    // Drive the real crawler the way the orchestrator does, against a
    // fixture site with a redirecting sample + an out-of-scope redirect.
    const page = (title: string): string =>
      `<html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;
    const routes: Record<string, string> = {
      "/de": page("Start"),
      "/de/neu-artikel": page("Neuer Artikel"),
      "/en/weg": page("Gone EN"),
      "/en/pricing": page("Pricing"),
    };
    const redirects: Record<string, string> = {
      "/de/alt-artikel": "/de/neu-artikel",
      "/de/weg": "/en/weg",
    };
    const fetched: string[] = [];
    const flushBatch = async (pages: CrawledPage[]): Promise<void> => {
      const r = await execute(registry, adapter, systemCtx, "imports.write_extracted_pages", {
        runId,
        pages: pages.map((p) => ({
          sourceUrl: p.url,
          ...(p.requestedUrl !== undefined ? { requestedUrl: p.requestedUrl } : {}),
          proposedSlug: p.proposedSlug,
          proposedTitle: p.title,
          proposedModules: p.modules.map((m) => ({
            blockName: m.blockName,
            position: m.position,
            html: m.html,
            displayName: m.displayName,
          })),
          proposedThemeTokens: p.themeTokens,
          signature: p.signature,
          pageCss: p.pageCss,
        })),
      });
      if (!r.ok) throw new Error(`write_extracted_pages ${JSON.stringify(r.error)}`);
    };
    const result = await crawlSite({
      sourceUrl: SOURCE_URL,
      urls: CHOSEN,
      scope: SCOPE,
      throttleMs: 0,
      onBatch: flushBatch,
      fetcher: async (url: string) => {
        fetched.push(url);
        const u = new URL(url);
        const finalPath = redirects[u.pathname] ?? u.pathname;
        const html = routes[finalPath];
        if (html === undefined) return { ok: false, html: "", contentType: "text/html" };
        return { ok: true, html, contentType: "text/html", finalUrl: `${u.origin}${finalPath}` };
      },
    });

    // The out-of-scope list entry was never fetched (skipped pre-fetch).
    expect(fetched.map((u) => new URL(u).pathname)).not.toContain("/en/pricing");
    expect(result.skippedOutOfScope).toBe(2);

    // Persist the orchestrator's post-crawl slice + status flip.
    await writeCrawlStateSlice(runId, {
      errors: result.errors,
      skipped: result.skipped,
      skippedOutOfScope: result.skippedOutOfScope,
    });
    const status = await execute(registry, adapter, systemCtx, "imports.update_run_status", {
      runId,
      status: "ready_for_review",
      pagesSeen: result.seenCount,
      pagesExtracted: result.pagesCrawled,
    });
    expect(status.ok).toBe(true);

    // AC #425-1: the redirected sample is stored under its FINAL URL,
    // requested URL kept as provenance on the row.
    const after = await execute(registry, adapter, systemCtx, "imports.get", { runId });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const pages = (
      after.value as {
        pages: { sourceUrl: string; requestedUrl: string | null; proposedSlug: string }[];
      }
    ).pages;
    const artikel = pages.find((p) => p.proposedSlug === "neu-artikel");
    expect(artikel?.sourceUrl).toBe(`${ORIGIN}/de/neu-artikel`);
    expect(artikel?.requestedUrl).toBe(`${ORIGIN}/de/alt-artikel`);
    const home = pages.find((p) => p.proposedSlug === "home");
    expect(home?.requestedUrl).toBeNull();
    // Nothing outside the scope was stored.
    expect(pages.every((p) => new URL(p.sourceUrl).pathname.startsWith("/de"))).toBe(true);

    // AC #425-2: the run report states the active scope and the
    // skipped-out-of-scope count, with the skip reasons readable.
    const report = await execute(registry, adapter, systemCtx, "imports.get_run_report", {
      runId,
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const rep = report.value as {
      crawlScope: unknown;
      skippedOutOfScope: number;
      crawlSkipped: { url: string; reason: string }[];
    };
    expect(rep.crawlScope).toEqual(SCOPE);
    expect(rep.skippedOutOfScope).toBe(2);
    const reasons = new Map(rep.crawlSkipped.map((s) => [new URL(s.url).pathname, s.reason]));
    expect(reasons.get("/en/pricing")).toContain("out-of-scope");
    expect(reasons.get("/de/weg")).toContain("redirected to");
  });
});
