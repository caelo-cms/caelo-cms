// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout B) — the static build resolves internal references.
 *
 * A module value carrying `caelo:page/<id>#anchor` ships as the target's
 * public path in the target's URL style; a link to a draft page ships
 * its URL and is reported in `unpublishedLinkTargets` (warning at Stage);
 * a link to a deleted page fails the build in the render gate, naming
 * the page, the module and the marker; so does a malformed `caelo:`
 * href; a media reference goes through the media pass like a literal
 * embed and ships as the content-hashed `/_assets/…` file.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { localBuildPluginServices } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { type DeployTarget, generateSite, pageOutputPath } from "./generate.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "link-refs-build-test",
};

const PFX = `lrb-${Date.now().toString(36)}`;
const MEDIA_SHA = `7e1f0b03${"d".repeat(56)}`;
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
      return query(tx);
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
    await tx`DELETE FROM media_assets WHERE sha256 = ${MEDIA_SHA}`;
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
      tx`UPDATE site_defaults SET site_base_url = 'https://links.example', site_language = 'en' WHERE id = 1`,
  );
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
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
});

afterAll(async () => {
  await wipe();
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = ${baseBefore}, site_language = ${languageBefore} WHERE id = 1`,
  );
  await adapter.close();
});

async function buildPage(
  slug: string,
  status: "draft" | "published",
  html: string,
  values: Record<string, unknown>,
  fields: { name: string; kind: string; label: string }[],
): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "pages.build_page", {
    page: { slug, title: `${PFX} ${slug}`, templateId, status },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} ${slug} Body`,
        description: "Page body.",
        kind: "content",
        html,
        fields,
        content: { source: "inline", values },
      },
    ],
  });
  if (!r.ok) throw new Error(`build_page ${slug}: ${JSON.stringify(r.error)}`);
  return (r.value as { pageId: string }).pageId;
}

function stagingTarget(): DeployTarget {
  return {
    id: "00000000-0000-0000-0000-0000000000a9",
    name: "staging",
    env: "staging",
    outDir: "out",
    baseUrl: "https://links.example",
    robotsDefault: "noindex",
    pageUrlStyle: "directory",
  };
}

const TEXT = [{ name: "body_text", kind: "text", label: "Body" }];

describe("static build — internal references", () => {
  it("renders references as target paths and reports links to unpublished pages", async () => {
    const about = await buildPage(
      `${PFX}-about`,
      "published",
      "<p>{{body_text}}</p>",
      { body_text: "About" },
      TEXT,
    );
    const draft = await buildPage(
      `${PFX}-soon`,
      "draft",
      "<p>{{body_text}}</p>",
      { body_text: "Soon" },
      TEXT,
    );
    const home = await buildPage(
      `${PFX}-links`,
      "published",
      '<nav><a href="{{about_href}}">About</a>{{#more}}<a href="{{href}}">{{label}}</a>{{/more}}</nav>',
      {
        about_href: `caelo:page/${about}#team`,
        more: [{ label: "Soon", href: `caelo:page/${draft}` }],
      },
      [
        { name: "about_href", kind: "url", label: "About link" },
        { name: "more", kind: "link-list", label: "More" },
      ],
    );

    const root = mkdtempSync(join(tmpdir(), "caelo-link-refs-build-"));
    const runId = `${PFX}-run`;
    const result = await adapter.withAdminTransaction(SYSTEM, (tx) =>
      generateSite({
        tx,
        adapter,
        plugins: localBuildPluginServices,
        target: stagingTarget(),
        runId,
        repoRoot: root,
        changedPageIds: [home],
      }),
    );
    const html = await readFile(
      join(root, "out", "builds", runId, pageOutputPath(`/${PFX}-links`)),
      "utf8",
    );
    expect(html).toContain(`<a href="/${PFX}-about/#team">About</a>`);
    expect(html).toContain(`<a href="/${PFX}-soon/">Soon</a>`);
    expect(html).not.toContain("caelo:page/");
    expect(result.unpublishedLinkTargets).toEqual([
      {
        pageSlug: `${PFX}-links`,
        pagePath: `/${PFX}-links`,
        targetPageId: draft,
        targetUrl: `/${PFX}-soon/`,
      },
    ]);
  });

  it("refuses to ship a link to a deleted page and names the marker", async () => {
    const gone = await buildPage(
      `${PFX}-gone`,
      "published",
      "<p>{{body_text}}</p>",
      { body_text: "Gone" },
      TEXT,
    );
    const linking = await buildPage(
      `${PFX}-dangling`,
      "published",
      '<a href="{{target}}">Old</a>',
      { target: `caelo:page/${gone}` },
      [{ name: "target", kind: "url", label: "Target" }],
    );
    await asSystem((tx) => tx`UPDATE pages SET deleted_at = now() WHERE id = ${gone}::uuid`);

    const root = mkdtempSync(join(tmpdir(), "caelo-link-refs-build-"));
    const build = adapter.withAdminTransaction(SYSTEM, (tx) =>
      generateSite({
        tx,
        adapter,
        plugins: localBuildPluginServices,
        target: stagingTarget(),
        runId: `${PFX}-run2`,
        repoRoot: root,
        changedPageIds: [linking],
      }),
    );
    await expect(build).rejects.toThrow(`link-target-missing:page/${gone}`);
  });

  it("refuses to ship a malformed caelo: href and names the marker", async () => {
    const target = await buildPage(
      `${PFX}-mal-target`,
      "published",
      "<p>{{body_text}}</p>",
      { body_text: "T" },
      TEXT,
    );
    const linking = await buildPage(
      `${PFX}-mal`,
      "published",
      `<a href="caelo:page/${target}/team">Team</a>`,
      {},
      [],
    );
    const root = mkdtempSync(join(tmpdir(), "caelo-link-refs-build-"));
    const build = adapter.withAdminTransaction(SYSTEM, (tx) =>
      generateSite({
        tx,
        adapter,
        plugins: localBuildPluginServices,
        target: stagingTarget(),
        runId: `${PFX}-run3`,
        repoRoot: root,
        changedPageIds: [linking],
      }),
    );
    await expect(build).rejects.toThrow(`link-ref-malformed:caelo:page/${target}/team`);
  });

  it("ships a media reference as the media pass's hashed asset", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const upload = await execute(registry, adapter, SYSTEM, "media.upload", {
      sha256: MEDIA_SHA,
      originalName: "logo.png",
      name: `${PFX} Logo`,
      mime: "image/png",
      sizeBytes: bytes.length,
      width: null,
      height: null,
      alt: "",
      storageKey: `${MEDIA_SHA}/orig.png`,
      variants: [
        {
          variant: "orig",
          format: "png",
          width: null,
          height: null,
          sizeBytes: bytes.length,
          storageKey: `${MEDIA_SHA}/orig.png`,
        },
      ],
    });
    if (!upload.ok) throw new Error(`media seed: ${JSON.stringify(upload.error)}`);
    const { assetId, slug } = upload.value as { assetId: string; slug: string };
    const page = await buildPage(
      `${PFX}-media`,
      "published",
      `<a class="dl" href="caelo:media/${assetId}">Logo</a>`,
      {},
      [],
    );
    const root = mkdtempSync(join(tmpdir(), "caelo-link-refs-build-"));
    // The generator reads media bytes from <repoRoot>/data/media/<storageKey>.
    await mkdir(join(root, "data", "media", MEDIA_SHA), { recursive: true });
    await writeFile(join(root, "data", "media", MEDIA_SHA, "orig.png"), bytes);
    const runId = `${PFX}-run4`;
    await adapter.withAdminTransaction(SYSTEM, (tx) =>
      generateSite({
        tx,
        adapter,
        plugins: localBuildPluginServices,
        target: stagingTarget(),
        runId,
        repoRoot: root,
        changedPageIds: [page],
      }),
    );
    const html = await readFile(
      join(root, "out", "builds", runId, pageOutputPath(`/${PFX}-media`)),
      "utf8",
    );
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    expect(html).toContain(`<a class="dl" href="/_assets/${slug}.${hash}.png"`);
    expect(html).not.toContain("caelo:media/");
  });
});
