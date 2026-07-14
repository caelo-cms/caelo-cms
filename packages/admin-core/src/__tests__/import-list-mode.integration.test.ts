// SPDX-License-Identifier: MPL-2.0

/**
 * issue #229 — LIST-mode site import, end to end at the DB boundary.
 *
 * The #278 migration flow proposes a crawl of an EXACT URL set (the
 * homepage's one-sample-per-page-type picks, then the scoped per-type
 * fill) rather than a blind BFS. This test pins the storage + read path
 * the orchestrator relies on: propose_run persists `explicit_urls`,
 * execute_proposal flips the run to 'crawling', the run reads back with
 * that exact list on every surface, and driving the real crawler with
 * the list read from the DB fetches ONLY those URLs (+ the source
 * origin) — never a link the pages expose.
 *
 * CI-only: requires the two real Postgres URLs (mocks are banned for
 * Query API tests — CLAUDE.md §6). Not run locally (dev-DB truncation).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { crawlSite, estimateListScope } from "@caelo-cms/site-importer";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let systemCtx: ExecutionContext;

const SOURCE_URL = "https://list-mode-regression.example.com/";
const ACTOR_EMAIL = "import-list-mode-actor@example.com";
const CHOSEN = [
  "https://list-mode-regression.example.com/products",
  "https://list-mode-regression.example.com/blog/one",
  "https://list-mode-regression.example.com/pricing",
];

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

/** Read import_runs.explicit_urls exactly as the orchestrator's claim
 *  does, normalising the jsonb (decoded array vs JSON string). */
async function readExplicitUrls(runId: string): Promise<string[] | null> {
  const sql = new SQL(ADMIN_URL!);
  try {
    const rows = (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return tx`SELECT explicit_urls FROM import_runs WHERE id = ${runId}::uuid`;
    })) as unknown as Array<{ explicit_urls: unknown }>;
    const raw = rows[0]?.explicit_urls;
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.filter((u): u is string => typeof u === "string") : null;
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
    requestId: "import-list-mode-bootstrap",
  };
  const created = await execute(registry, adapter, bootstrapCtx, "users.create", {
    email: ACTOR_EMAIL,
    password: "import-list-mode-pass",
    displayName: "Import List Mode Actor",
    roleNames: [],
  });
  if (!created.ok) throw new Error(`users.create failed: ${created.error.kind}`);
  systemCtx = {
    actorId: (created.value as { userId: string }).userId,
    actorKind: "system",
    requestId: "import-list-mode-test",
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

describe("list-mode site import (#229)", () => {
  it("propose → execute stores the exact URL set; the crawler fetches only those", async () => {
    // Propose in LIST mode with the exact scope estimate.
    const proposed = await execute(registry, adapter, systemCtx, "imports.propose_run", {
      sourceUrl: SOURCE_URL,
      urls: CHOSEN,
      estimate: estimateListScope(CHOSEN.length),
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const runId = (proposed.value as { runId: string }).runId;

    // The read surface carries the chosen URLs + the list-basis estimate.
    const got = await execute(registry, adapter, systemCtx, "imports.get", { runId });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const run = (got.value as { run: { explicitUrls: string[] | null; estimate: unknown } }).run;
    expect(run.explicitUrls).toEqual(CHOSEN);
    expect((run.estimate as { basis: string }).basis).toBe("list");

    // The pending inbox names it as an exact-count crawl, not "up to N".
    const pending = await execute(registry, adapter, systemCtx, "pending_proposals.list", {
      limit: 200,
    });
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    const item = (pending.value as { items: { proposalId: string; summary: string }[] }).items.find(
      (i) => i.proposalId === runId,
    );
    expect(item?.summary).toContain("specific pages");

    // Owner approves → run flips to 'crawling'.
    const approved = await execute(registry, adapter, systemCtx, "imports.execute_proposal", {
      runId,
    });
    expect(approved.ok).toBe(true);

    // The orchestrator claim reads explicit_urls straight off the row;
    // reproduce that read and confirm the exact set survived the write.
    const persisted = await readExplicitUrls(runId);
    expect(persisted).toEqual(CHOSEN);

    // Drive the real crawler with the persisted list + an injected site
    // whose pages ALL link to /trap. LIST mode must fetch only CHOSEN +
    // the source origin, never /trap.
    const linkToTrap = (title: string): string =>
      `<html><head><title>${title}</title></head><body><a href="/trap">t</a></body></html>`;
    const routes: Record<string, string> = {
      "/": linkToTrap("Home"),
      "/products": linkToTrap("Products"),
      "/blog/one": linkToTrap("Blog One"),
      "/pricing": linkToTrap("Pricing"),
      "/trap": linkToTrap("Trap"),
    };
    const fetched: string[] = [];
    const result = await crawlSite({
      sourceUrl: SOURCE_URL,
      urls: persisted ?? [],
      throttleMs: 0,
      fetcher: async (url: string) => {
        fetched.push(url);
        const path = new URL(url).pathname;
        const html = routes[path];
        if (html === undefined) return { ok: false, html: "", contentType: "text/html" };
        return { ok: true, html, contentType: "text/html" };
      },
    });
    const fetchedPaths = fetched.map((u) => new URL(u).pathname).sort();
    expect(fetchedPaths).toEqual(["/", "/blog/one", "/pricing", "/products"]);
    expect(fetchedPaths).not.toContain("/trap");
    expect(result.pages.map((p) => p.proposedSlug).sort()).toEqual([
      "blog-one",
      "home",
      "pricing",
      "products",
    ]);
  });
});
