// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1454 — a real build carries its headers: the page script is a file,
 * the CSP names what the pages reference, the Caddy snippet serves it, and
 * the Owner's policy decides the mode.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { localBuildPluginServices } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import {
  DEFAULT_SITE_SECURITY_POLICY,
  type ExecutionContext,
  parseSiteHeaderSet,
  SECURITY_HEADERS_BUILD_FILE,
} from "@caelo-cms/shared";
import { SQL } from "bun";
import { generateSite } from "./generate.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "security-headers-build-test",
};

const PFX = `shb-${Date.now().toString(36)}`;
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
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
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE display_name LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
  });
}

const setPolicy = (policy: unknown) =>
  asSystem(
    (tx) =>
      tx`UPDATE site_settings SET security_headers = ${JSON.stringify(policy)}::text::jsonb WHERE id = 1`,
  );

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
      tx`UPDATE site_defaults SET site_base_url = 'https://headers.example', site_language = 'en' WHERE id = 1`,
  );
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: `${PFX} TPL`,
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  const templateId = (tpl.value as { templateId: string }).templateId;
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
        description: "Page body text with a video and a little behaviour.",
        kind: "content",
        html: '<div class="shb"><p>{{body_text}}</p><iframe src="https://video.vendor.example/embed/1" title="v"></iframe></div>',
        js: '(function(){document.querySelector(".shb").dataset.ready="1";})();',
        fields: [{ name: "body_text", kind: "text", label: "Body" }],
        content: { source: "inline", values: { body_text: "A" } },
      },
    ],
  });
  if (!page.ok) throw new Error(`build_page: ${JSON.stringify(page.error)}`);
});

afterAll(async () => {
  await wipe();
  await setPolicy(DEFAULT_SITE_SECURITY_POLICY);
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = ${baseBefore}, site_language = ${languageBefore} WHERE id = 1`,
  );
  await adapter.close();
});

async function build(): Promise<string> {
  const runId = crypto.randomUUID();
  const root = mkdtempSync(join(tmpdir(), "caelo-security-headers-build-"));
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
        baseUrl: "https://headers.example",
        robotsDefault: "noindex",
      },
      runId,
      repoRoot: root,
    }),
  );
  return join(root, "out", "builds", runId);
}

describe("a build's security headers", () => {
  it("the page script is a file, and the CSP allows it and what the page embeds", async () => {
    const dir = await build();
    const set = parseSiteHeaderSet(await readFile(join(dir, SECURITY_HEADERS_BUILD_FILE), "utf8"));
    const report = set.headers["Content-Security-Policy-Report-Only"] ?? "";
    expect(report).toContain("frame-src 'self' https://video.vendor.example");
    expect(set.facts.inlineScriptHashes).toEqual([]);
    expect(report.match(/script-src [^;]*/)?.[0]).toBe("script-src 'self'");

    const html = await readFile(join(dir, `${PFX}-a`, "index.html"), "utf8");
    const src = html.match(/<script defer data-source="modules" src="\/([^"]+)"/)?.[1];
    expect(src).toMatch(/^_assets\/page-script\.[0-9a-f]{16}\.js$/);
    expect(await readFile(join(dir, src ?? ""), "utf8")).toContain("dataset.ready");

    const snippet = await readFile(join(dir, "_redirects.caddy"), "utf8");
    expect(snippet).toContain("header @caelo_documents Content-Security-Policy-Report-Only");
  });

  it("the Owner's policy decides the mode", async () => {
    await setPolicy({ ...DEFAULT_SITE_SECURITY_POLICY, cspMode: "enforce" });
    try {
      const dir = await build();
      const set = parseSiteHeaderSet(
        await readFile(join(dir, SECURITY_HEADERS_BUILD_FILE), "utf8"),
      );
      expect(set.headers["Content-Security-Policy"]).toContain("script-src 'self'");
      expect(set.headers["Content-Security-Policy-Report-Only"]).toBeUndefined();
    } finally {
      await setPolicy(DEFAULT_SITE_SECURITY_POLICY);
    }
  });

  it("a stored policy that does not parse stops the build, naming the setting", async () => {
    await setPolicy({ cspMode: "off" });
    try {
      await expect(build()).rejects.toThrow("site_settings.security_headers");
    } finally {
      await setPolicy(DEFAULT_SITE_SECURITY_POLICY);
    }
  });
});
