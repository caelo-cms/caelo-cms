// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout C) — imports canonicalise at import time, against a
 * real Postgres (CLAUDE.md §6). `imports.compose_from_run` turns the
 * composed markup's internal links into page references once every page
 * of the run exists:
 *   - an old URL the compose redirected (301) names its new page;
 *   - an absolute self-link on the migrated site's www / apex twin host
 *     names the page (sites link themselves under both);
 *   - a path no imported page answers, and a file path nothing serves,
 *     stay literal and come back in `unresolvedInternalLinks` — never
 *     guessed (maintainer decision 3 on #724).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sourceSiteHosts } from "../links/canonicalise-writes.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const PFX = `lcc-${Date.now().toString(36)}`;
const SOURCE = `https://${PFX}.example`;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "link-canonicalise-compose-test",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let sqlc: SQL;

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  return (await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    return query(tx);
  })) as T;
}

async function cleanup(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM redirects WHERE to_path LIKE ${`/${PFX}%`}`;
    const composed = (await tx`
      SELECT module_id::text AS m, content_instance_id::text AS c FROM page_modules
      WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`) as {
      m: string;
      c: string;
    }[];
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    for (const r of composed) {
      await tx`DELETE FROM content_instances WHERE id = ${r.c}::uuid`;
      await tx`DELETE FROM modules WHERE id = ${r.m}::uuid
                 AND id NOT IN (SELECT module_id FROM page_modules)`;
    }
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM import_pages WHERE source_url LIKE ${`${SOURCE}%`}`;
    await tx`DELETE FROM import_runs WHERE source_url LIKE ${`${SOURCE}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  sqlc = new SQL(ADMIN_URL as string);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await sqlc.end();
  await adapter.close();
});

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYSTEM, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

describe("sourceSiteHosts", () => {
  it("adds the www / apex twin, keeping the port", () => {
    expect(sourceSiteHosts("https://Example.com/")).toEqual(["example.com", "www.example.com"]);
    expect(sourceSiteHosts("https://www.example.com:8443/x")).toEqual([
      "www.example.com:8443",
      "example.com:8443",
    ]);
    expect(sourceSiteHosts("not a url")).toEqual([]);
  });
});

describe("imports.compose_from_run canonicalises internal links", () => {
  it("stores references for imported pages and reports the rest", async () => {
    const { runId } = await op<{ runId: string }>("imports.create_run", {
      sourceUrl: `${SOURCE}/`,
      depth: 2,
      maxPages: 10,
    });
    const page = (path: string, slug: string, html: string) => ({
      sourceUrl: `${SOURCE}${path}`,
      proposedSlug: slug,
      proposedTitle: slug,
      proposedModules: [{ blockName: "content", position: 0, html, displayName: slug }],
      proposedThemeTokens: {},
      signature: `sig-${slug}`,
    });
    const homeHtml =
      `<section><a href="/alt/artikel.html">Artikel</a>` +
      `<a href="https://www.${PFX}.example/${PFX}-kontakt#form">Kontakt</a>` +
      `<a href="/${PFX}-nowhere">Weg</a><a href="/files/broschuere.pdf">PDF</a>` +
      `<a href="https://elsewhere.example/">Extern</a></section>`;
    await op("imports.write_extracted_pages", {
      runId,
      pages: [
        page("/", `${PFX}-home`, homeHtml),
        page("/alt/artikel.html", `${PFX}-artikel`, "<section>Artikel</section>"),
        page(`/${PFX}-kontakt`, `${PFX}-kontakt`, "<section>Kontakt</section>"),
      ],
    });
    await op("imports.update_run_status", {
      runId,
      status: "ready_for_review",
      pagesSeen: 3,
      pagesExtracted: 3,
    });

    const composed = await op<{ unresolvedInternalLinks: string[] }>("imports.compose_from_run", {
      runId,
      templateSlug: `${PFX}-tpl`,
    });
    expect([...composed.unresolvedInternalLinks].sort()).toEqual(
      ["/files/broschuere.pdf", `/${PFX}-nowhere`].sort(),
    );

    const ids = (await asSystem(
      (tx) => tx`SELECT id::text AS id, slug FROM pages WHERE slug LIKE ${`${PFX}%`}`,
    )) as { id: string; slug: string }[];
    const idOf = (slug: string) => ids.find((p) => p.slug === slug)?.id;
    const homeId = idOf(`${PFX}-home`);
    if (!homeId) throw new Error("home page not composed");
    const rows = (await asSystem(
      (tx) => tx`
        SELECT m.html FROM page_modules pm JOIN modules m ON m.id = pm.module_id
        WHERE pm.page_id = ${homeId}::uuid`,
    )) as { html: string }[];
    const html = rows.map((r) => r.html).join("\n");
    expect(html).toContain(`href="caelo:page/${idOf(`${PFX}-artikel`)}"`);
    expect(html).toContain(`href="caelo:page/${idOf(`${PFX}-kontakt`)}#form"`);
    expect(html).toContain(`href="/${PFX}-nowhere"`);
    expect(html).toContain('href="/files/broschuere.pdf"');
    expect(html).toContain('href="https://elsewhere.example/"');
  });
});
