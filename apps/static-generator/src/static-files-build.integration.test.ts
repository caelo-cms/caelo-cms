// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1461 — static files in the build: written at their path with their
 * Content-Type, never listed as pages, gone from the next build once
 * deleted, and a build stops rather than letting a file and a page share a
 * URL.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { localBuildPluginServices } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, parseStaticFilesManifest } from "@caelo-cms/shared";
import { SQL } from "bun";
import { assertStaticFilesFit, generateSite } from "./generate.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "static-files-build-test",
};

const PFX = `sfb-${Date.now().toString(36)}`;
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let baseBefore: string | null = null;
let languageBefore: string | null = null;

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM static_files`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE display_name LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
  });
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const row = await asSystem(
    (tx) => tx`SELECT site_base_url, site_language FROM site_defaults WHERE id = 1`,
  );
  const settings = row[0] as { site_base_url: string | null; site_language: string | null };
  baseBefore = settings.site_base_url;
  languageBefore = settings.site_language;
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = 'https://files.example', site_language = 'en' WHERE id = 1`,
  );
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: `${PFX} TPL`,
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const page = await execute(registry, adapter, SYSTEM, "pages.build_page", {
    page: { slug: `${PFX}-a`, title: `${PFX} A`, templateId, status: "published" },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} Body`,
        description: "Page body text.",
        kind: "content",
        html: '<p class="body">{{body_text}}</p>',
        fields: [{ name: "body_text", kind: "text", label: "Body" }],
        content: { source: "inline", values: { body_text: "A" } },
      },
    ],
  });
  if (!page.ok) throw new Error(`build_page: ${JSON.stringify(page.error)}`);
  const set = await execute(registry, adapter, SYSTEM, "static_files.set_many", {
    files: [
      {
        path: "/bot/ips.json",
        contentType: "application/json",
        body: '{"ips":["192.0.2.1"]}',
        purpose: "The bot's IP list.",
      },
      {
        path: "/.well-known/apple-app-site-association",
        contentType: "application/json",
        body: "{}",
        purpose: "Universal links.",
      },
    ],
  });
  if (!set.ok) throw new Error(`static_files.set_many: ${JSON.stringify(set.error)}`);
});

afterAll(async () => {
  await wipe();
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = ${baseBefore}, site_language = ${languageBefore} WHERE id = 1`,
  );
  await adapter.close();
});

async function build(runId: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "caelo-static-files-build-"));
  await adapter.withAdminTransaction(SYSTEM, (tx) =>
    generateSite({
      publishAt: new Date().toISOString(),
      tx,
      plugins: localBuildPluginServices,
      target: {
        id: "00000000-0000-0000-0000-0000000000a9",
        name: "dev",
        env: "dev",
        outDir: "out",
        baseUrl: "https://files.example",
        robotsDefault: "noindex",
      },
      runId,
      repoRoot: root,
    }),
  );
  return join(root, "out", "builds", runId);
}

describe("static files in the build", () => {
  it("writes each file byte for byte with its Content-Type, and never as a page", async () => {
    const dir = await build(`${PFX}-one`);
    expect(await readFile(join(dir, "bot/ips.json"), "utf8")).toBe('{"ips":["192.0.2.1"]}');
    expect(existsSync(join(dir, ".well-known/apple-app-site-association"))).toBe(true);

    const types = JSON.parse(await readFile(join(dir, "_content-types.json"), "utf8"));
    expect(types["bot/ips.json"]).toBe("application/json; charset=utf-8");
    expect(types[".well-known/apple-app-site-association"]).toBe("application/json; charset=utf-8");

    const entries = parseStaticFilesManifest(
      await readFile(join(dir, "_static-files.json"), "utf8"),
    );
    expect(entries.map((e) => e.path).sort()).toEqual([
      ".well-known/apple-app-site-association",
      "bot/ips.json",
    ]);
    expect(await readFile(join(dir, "_redirects.caddy"), "utf8")).toContain(
      'Content-Type "application/json; charset=utf-8"',
    );

    // The quality check reads the manifest's pages; a file is not one of them.
    const manifest = JSON.parse(await readFile(join(dir, "routing-manifest.json"), "utf8")) as {
      pages: { path: string; outputPath: string }[];
    };
    expect(manifest.pages.some((p) => p.outputPath.includes("ips"))).toBe(false);
    expect(await readFile(join(dir, "sitemap.xml"), "utf8")).not.toContain("ips.json");
  });

  it("leaves a deleted file out of the next build", async () => {
    const del = await execute(registry, adapter, SYSTEM, "static_files.delete_many", {
      paths: ["/.well-known/apple-app-site-association"],
    });
    expect(del.ok).toBe(true);
    const dir = await build(`${PFX}-two`);
    expect(existsSync(join(dir, ".well-known/apple-app-site-association"))).toBe(false);
    expect(existsSync(join(dir, "bot/ips.json"))).toBe(true);
  });

  it("refuses a file at a page's path when it is written", async () => {
    const r = await execute(registry, adapter, SYSTEM, "static_files.set_many", {
      files: [{ path: `/${PFX}-a`, contentType: "text/plain", body: "x", purpose: "Collides." }],
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("a page already serves");
  });

  it("stops the build when a page reached a file's path later, and names the way out", async () => {
    await asSystem(async (tx) => {
      await tx`INSERT INTO static_files (path, content_type, body, purpose)
               VALUES (${`/${PFX}-a`}, 'text/plain', 'x', 'Collides.')`;
    });
    await expect(build(`${PFX}-three`)).rejects.toThrow(/static file conflict.*Next step/s);
    await asSystem(async (tx) => {
      await tx`DELETE FROM static_files WHERE path = ${`/${PFX}-a`}`;
    });
  });
});

describe("assertStaticFilesFit", () => {
  const free = { pagePaths: [], redirectFromPaths: [], servedPaths: new Set<string>() };

  it("passes a free site", () => {
    expect(() => assertStaticFilesFit([{ path: "/a.json" }], free)).not.toThrow();
  });

  it("stops at a page below an extension-less file", () => {
    expect(() =>
      assertStaticFilesFit([{ path: "/docs" }], { ...free, pagePaths: ["/docs/intro"] }),
    ).toThrow("sits below");
  });

  it("stops at a redirect from the file's path", () => {
    expect(() =>
      assertStaticFilesFit([{ path: "/a.json" }], { ...free, redirectFromPaths: ["/a.json"] }),
    ).toThrow("redirect starts at");
  });

  it("stops at a path the build already wrote, and at a bare-slug page in its folder", () => {
    expect(() =>
      assertStaticFilesFit([{ path: "/a.json" }], { ...free, servedPaths: new Set(["a.json"]) }),
    ).toThrow("already writes");
    expect(() =>
      assertStaticFilesFit([{ path: "/docs/a.json" }], { ...free, servedPaths: new Set(["docs"]) }),
    ).toThrow("already writes");
  });
});
