// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: deployed pages lost every nested module. The static
 * generator composed placed modules only; a `module-list` of cards (or a
 * single `module` field) rendered as
 * `<!-- caelo:module-list cards needs recursive renderer (compose path) -->`
 * — an empty pricing grid / card grid / FAQ on the live site, while the
 * editor preview (which recursed) showed everything. The build also
 * passed, because the marker is an HTML comment.
 *
 * Covers, against a real Postgres:
 *   - cards of a module-list and a single nested module render in the
 *     built HTML, with the nested module's CSS in the page bundle;
 *   - an edit to a nested, placement-less instance made in a chat
 *     reaches the build after Stage's merge (chat.merge_to_main);
 *   - a broken nested ref fails the build, naming page, module and field,
 *     before any page file is written.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { localBuildPluginServices } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { generateSite, pageOutputPath } from "./generate.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "nested-modules-build-test",
};

const TS = Date.now().toString(36);
const PFX = `nmb-${TS}`;
const TPL_SLUG = `${PFX}-tpl`;

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
    await tx`DELETE FROM chat_entity_locks WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE display_name LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
    await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
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
      tx`UPDATE site_defaults SET site_base_url = 'https://nested.example', site_language = 'en' WHERE id = 1`,
  );

  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: TPL_SLUG,
    displayName: `${PFX} TPL`,
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  const blocks = await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  if (!blocks.ok) throw new Error(`template blocks seed failed: ${JSON.stringify(blocks.error)}`);
});

afterAll(async () => {
  await wipe();
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = ${baseBefore}, site_language = ${languageBefore} WHERE id = 1`,
  );
  await adapter.close();
});

interface BuiltPage {
  pageId: string;
  /** The two card instances (module-list elements), in order. */
  cards: { moduleId: string; contentInstanceId: string }[];
  /** The single nested module's instance. */
  featured: { moduleId: string; contentInstanceId: string };
}

/**
 * One page: a pricing grid placed in `content` whose `plans` module-list
 * holds two plan cards and whose `featured` module field holds a badge.
 * Only the grid has a placement; cards and badge are nested-only.
 */
async function buildPricingPage(slug: string, tag: string): Promise<BuiltPage> {
  const r = await execute(registry, adapter, SYSTEM, "pages.build_page", {
    page: { slug, title: `${PFX} Pricing`, templateId },
    modules: [
      {
        ref: "plan_a",
        displayName: `${PFX} ${tag} Plan Card`,
        description: "One pricing plan card.",
        kind: "content",
        html: '<article class="plan">{{plan_name}}</article>',
        css: ".plan{border:1px solid}",
        fields: [{ name: "plan_name", kind: "text", label: "Plan name" }],
        content: { source: "inline", values: { plan_name: "Starter" } },
      },
      {
        ref: "plan_b",
        moduleId: { $ref: "plan_a" },
        content: { source: "inline", values: { plan_name: "Business" } },
      },
      {
        ref: "badge",
        displayName: `${PFX} ${tag} Badge`,
        description: "Highlight badge above the plans.",
        kind: "content",
        html: '<p class="badge">{{badge_text}}</p>',
        fields: [{ name: "badge_text", kind: "text", label: "Badge text" }],
        content: { source: "inline", values: { badge_text: "Most popular" } },
      },
      {
        blockName: "content",
        displayName: `${PFX} ${tag} Pricing Grid`,
        description: "Pricing table: a badge plus a grid of plan cards.",
        kind: "content",
        html: '<section class="ps">{{>featured}}<div class="ps__grid">{{#plans}}{{/plans}}</div></section>',
        fields: [
          { name: "featured", kind: "module", label: "Featured badge" },
          { name: "plans", kind: "module-list", label: "Plans" },
        ],
        content: {
          source: "inline",
          values: { featured: { $ref: "badge" }, plans: [{ $ref: "plan_a" }, { $ref: "plan_b" }] },
        },
      },
    ],
  });
  if (!r.ok) throw new Error(`build_page failed: ${JSON.stringify(r.error)}`);
  const v = r.value as {
    pageId: string;
    detached: { ref: string; moduleId: string; contentInstanceId: string }[];
  };
  const byRef = new Map(v.detached.map((d) => [d.ref, d]));
  const pick = (ref: string) => {
    const d = byRef.get(ref);
    if (!d) throw new Error(`detached ${ref} missing`);
    return { moduleId: d.moduleId, contentInstanceId: d.contentInstanceId };
  };
  return { pageId: v.pageId, cards: [pick("plan_a"), pick("plan_b")], featured: pick("badge") };
}

// One repo root for every build in this file: the generator's font cache
// lives under it and the resolver memoises resolved files per process.
const root = mkdtempSync(join(tmpdir(), "caelo-nested-build-"));

/** Build only `pageId` (incremental, dev target) as run `runId`. */
function build(pageId: string, runId: string): { run: Promise<unknown>; buildDir: string } {
  const run = adapter.withAdminTransaction(SYSTEM, (tx) =>
    generateSite({
      tx,
      adapter,
      plugins: localBuildPluginServices,
      target: {
        id: "00000000-0000-0000-0000-0000000000a7",
        name: "dev",
        env: "dev",
        outDir: "out",
        baseUrl: "https://nested.example",
        robotsDefault: "noindex",
      },
      runId,
      repoRoot: root,
      changedPageIds: [pageId],
    }),
  );
  return { run, buildDir: join(root, "out", "builds", runId) };
}

async function pageFile(pageId: string, buildDir: string): Promise<string> {
  const rows = await asSystem(
    (tx) => tx`SELECT current_path FROM pages WHERE id = ${pageId}::uuid`,
  );
  const currentPath = (rows[0] as { current_path: string }).current_path;
  return join(buildDir, pageOutputPath(currentPath));
}

describe("static build renders nested modules", () => {
  let page: BuiltPage;

  beforeAll(async () => {
    page = await buildPricingPage(`${PFX}-pricing`, "ok");
  });

  it("ships the module-list cards and the single nested module, with their CSS", async () => {
    const { run, buildDir } = build(page.pageId, `${PFX}-ok`);
    await run;
    const html = await readFile(await pageFile(page.pageId, buildDir), "utf8");
    expect(html).toContain('<p class="badge">Most popular</p>');
    expect(html).toContain(
      '<div class="ps__grid"><article class="plan">Starter</article><article class="plan">Business</article></div>',
    );
    expect(html).toContain(".plan{border:1px solid}");
    expect(html).not.toContain("needs recursive renderer");
    expect(html).not.toContain("caelo:missing");
  });

  it("an edit to a placement-less nested instance in a chat reaches the build after Stage's merge", async () => {
    const chat = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      title: `${PFX} chat`,
    });
    if (!chat.ok) throw new Error(`chat seed failed: ${JSON.stringify(chat.error)}`);
    const { chatSessionId, chatBranchId } = chat.value as {
      chatSessionId: string;
      chatBranchId: string;
    };
    const card = page.cards[1];
    if (!card) throw new Error("card seed missing");
    const edit = await execute(
      registry,
      adapter,
      { ...SYSTEM, chatBranchId, requestId: "nested-modules-build-chat-edit" },
      "content_instances.set_values",
      { id: card.contentInstanceId, values: { plan_name: "Enterprise" } },
    );
    expect(edit.ok).toBe(true);
    // Nested-only: no placement of its own, but listed by the grid — not
    // an orphan (the AI used to be told "Orphan — no placements affected").
    expect(edit.value as { placementCount: number; nestedParentCount: number }).toMatchObject({
      placementCount: 0,
      nestedParentCount: 1,
    });

    // Branched: main (and so the build) is unchanged until the merge.
    const before = build(page.pageId, `${PFX}-pre-merge`);
    await before.run;
    expect(await readFile(await pageFile(page.pageId, before.buildDir), "utf8")).toContain(
      "Business",
    );

    const merged = await execute(registry, adapter, SYSTEM, "chat.merge_to_main", {
      chatSessionId,
    });
    expect(merged.ok).toBe(true);

    const after = build(page.pageId, `${PFX}-post-merge`);
    await after.run;
    const html = await readFile(await pageFile(page.pageId, after.buildDir), "utf8");
    expect(html).toContain('<article class="plan">Enterprise</article>');
    expect(html).not.toContain("Business");
  });

  it("fails the build, naming page, module and field, when a nested ref is broken", async () => {
    const broken = await buildPricingPage(`${PFX}-broken`, "broken");
    const gone = broken.cards[1];
    if (!gone) throw new Error("card seed missing");
    // The referenced card's instance disappears behind the list's back.
    await asSystem(
      (tx) =>
        tx`UPDATE content_instances SET deleted_at = now() WHERE id = ${gone.contentInstanceId}::uuid`,
    );
    const gridSlug = (
      (await asSystem(
        (tx) =>
          tx`SELECT slug FROM modules WHERE display_name = ${`${PFX} broken Pricing Grid`} LIMIT 1`,
      )) as { slug: string }[]
    )[0]?.slug;

    const { run, buildDir } = build(broken.pageId, `${PFX}-broken`);
    await expect(run).rejects.toThrow(`page "${PFX}-broken"`);
    await expect(build(broken.pageId, `${PFX}-broken-2`).run).rejects.toThrow(
      `module "${gridSlug}" (block content) field "plans[1]": content-instance-missing:${gone.contentInstanceId}`,
    );
    expect(existsSync(await pageFile(broken.pageId, buildDir))).toBe(false);
  });
});
