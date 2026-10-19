// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout C) — write-time canonicalisation of internal links
 * at the op boundary, against a real Postgres (CLAUDE.md §6).
 *
 * Covers, per link-carrying surface:
 *   - content values: a `url` field and an HTML value become references
 *     (anchor kept), a plain text value that looks like a path does not,
 *     an own-domain absolute URL and an old URL behind a 301 both
 *     resolve to the page;
 *   - module HTML + field defaults (where layout chrome content lives);
 *   - structured sets, submenu `children` included;
 *   - media: `/_caelo/media/<slug>` in an image position → `caelo:media/<id>`;
 *   - the loud failure: a link to no page refuses the write with an
 *     AI-actionable message and writes nothing;
 *   - grandfathering: a literal already stored stays editable around;
 *   - reads humanise: the AI and the editor see paths, never ids, and a
 *     read-modify-write round trip stores the same reference again;
 *   - review fixes: a link padded with whitespace or hidden in a srcset
 *     candidate is canonicalised (the old string pre-check let it slip
 *     into a lookup-less run); only PERMANENT redirects pin a link; layout
 *     HTML is canonicalised; snapshot rows carry the reference form;
 *     content written in a chat reads the module's fields and pages as
 *     that chat's branch has them; bulk refusals name the failing entry.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { createDefaultToolRegistry, type ToolContext } from "../ai/tools/index.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "link-canonicalise-writes-test",
};

const PFX = `lcw-${Date.now().toString(36)}`;
const SHA = `1c0a${"7".repeat(60)}`;
const OWN_HOST = `${PFX}.example.org`;
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let aboutId = "";
let pricingId = "";
let mediaId = "";
let mediaSlug = "";
let savedBaseUrl: string | null = null;
const SESSION_PREFIX = `${PFX}-chat-`;

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
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${SESSION_PREFIX}%`}`;
    await tx`DELETE FROM layout_blocks WHERE layout_id IN (SELECT id FROM layouts WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM layouts WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM structured_sets WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM redirects WHERE from_path LIKE ${`%${PFX}%`} OR to_path LIKE ${`%${PFX}%`}`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
    await tx`DELETE FROM media_variants WHERE asset_id IN (SELECT id FROM media_assets WHERE sha256 = ${SHA})`;
    await tx`DELETE FROM media_assets WHERE sha256 = ${SHA}`;
  });
}

async function run<T>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYSTEM, op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function refused(op: string, input: unknown): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, op, input);
  if (r.ok) throw new Error(`${op} unexpectedly succeeded`);
  return (r.error as { message?: string }).message ?? JSON.stringify(r.error);
}

async function makePage(slug: string): Promise<string> {
  const r = await run<{ pageId: string }>("pages.build_page", {
    page: { slug, title: `${PFX} ${slug}`, templateId, status: "published" },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} ${slug} Body`,
        description: "Page body.",
        kind: "content",
        html: "<p>{{body_text}}</p>",
        fields: [{ name: "body_text", kind: "text", label: "Body" }],
        content: { source: "inline", values: { body_text: slug } },
      },
    ],
  });
  return r.pageId;
}

async function makeModule(
  slug: string,
  html: string,
  fields: { name: string; kind: string; label: string; default?: unknown }[],
): Promise<string> {
  const r = await run<{ moduleId: string }>("modules.create", {
    slug: `${PFX}-${slug}`,
    displayName: `${PFX} ${slug}`,
    description: "Link canonicalisation fixture.",
    html,
    fields,
  });
  return r.moduleId;
}

async function storedValues(instanceId: string): Promise<Record<string, unknown>> {
  const rows = await asSystem(
    (tx) => tx`SELECT "values" FROM content_instances WHERE id = ${instanceId}::uuid`,
  );
  const v = (rows as { values: unknown }[])[0]?.values;
  return (typeof v === "string" ? JSON.parse(v) : v) as Record<string, unknown>;
}

async function storedModule(moduleId: string): Promise<{ html: string; fields: unknown }> {
  const rows = await asSystem(
    (tx) => tx`SELECT html, fields FROM modules WHERE id = ${moduleId}::uuid`,
  );
  const r = (rows as { html: string; fields: unknown }[])[0];
  if (!r) throw new Error(`module ${moduleId} not stored`);
  return { html: r.html, fields: typeof r.fields === "string" ? JSON.parse(r.fields) : r.fields };
}

/** One explicit field, so modules.create keeps authored HTML as written. */
const NOTE_FIELD = [{ name: "note", kind: "text", label: "Note", default: "n" }];

const CTA_FIELDS = [
  { name: "cta_label", kind: "text", label: "CTA label" },
  { name: "cta_href", kind: "url", label: "CTA link" },
  { name: "price_note", kind: "text", label: "Price note" },
  { name: "body_html", kind: "richtext", label: "Body" },
];

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const tpl = await run<{ templateId: string }>("templates.create", {
    slug: `${PFX}-tpl`,
    displayName: `${PFX} TPL`,
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  templateId = tpl.templateId;
  await run("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  aboutId = await makePage(`${PFX}-about`);
  pricingId = await makePage(`${PFX}-pricing-old`);
  // A rename leaves a 301 from the old path behind.
  await run("pages.update", { pageId: pricingId, slug: `${PFX}-pricing` });

  const media = await run<{ assetId: string; slug: string }>("media.upload", {
    sha256: SHA,
    originalName: `${PFX}-hero.png`,
    name: `${PFX} hero`,
    mime: "image/png",
    sizeBytes: 4,
    width: 4,
    height: 4,
    alt: "",
    storageKey: `${SHA}/orig.png`,
    variants: [
      {
        variant: "orig",
        format: "png",
        width: 4,
        height: 4,
        sizeBytes: 4,
        storageKey: `${SHA}/orig.png`,
      },
    ],
  });
  mediaId = media.assetId;
  mediaSlug = media.slug;

  const base = await asSystem((tx) => tx`SELECT site_base_url FROM site_defaults WHERE id = 1`);
  savedBaseUrl = (base as { site_base_url: string | null }[])[0]?.site_base_url ?? null;
  await asSystem(
    (tx) => tx`UPDATE site_defaults SET site_base_url = ${`https://${OWN_HOST}`} WHERE id = 1`,
  );
});

afterAll(async () => {
  await asSystem((tx) => tx`UPDATE site_defaults SET site_base_url = ${savedBaseUrl} WHERE id = 1`);
  await wipe();
  await adapter.close();
});

describe("content values", () => {
  it("stores internal links as references and leaves text and external links literal", async () => {
    const moduleId = await makeModule(
      "cta",
      '<a href="{{cta_href}}">{{cta_label}}</a><small>{{price_note}}</small>{{body_html}}',
      CTA_FIELDS,
    );
    const { contentInstanceId } = await run<{ contentInstanceId: string }>(
      "content_instances.create",
      {
        moduleId,
        values: {
          cta_label: "About us",
          cta_href: `/${PFX}-about/#team`,
          price_note: "/month",
          body_html: `<p>See <a href="https://${OWN_HOST}/${PFX}-pricing">pricing</a>, <a href="/${PFX}-pricing-old">old pricing</a> and <a href="https://example.com/x">elsewhere</a>.</p>`,
        },
      },
    );
    const stored = await storedValues(contentInstanceId);
    expect(stored.cta_href).toBe(`caelo:page/${aboutId}#team`);
    // A plain text value is never a link, whatever it looks like.
    expect(stored.price_note).toBe("/month");
    // Own-domain absolute URL and the 301'd old path both name the page.
    expect(stored.body_html).toBe(
      `<p>See <a href="caelo:page/${pricingId}">pricing</a>, <a href="caelo:page/${pricingId}">old pricing</a> and <a href="https://example.com/x">elsewhere</a>.</p>`,
    );

    // Reads show paths, never ids (CLAUDE.md §1A)…
    const got = await run<{ instance: { values: Record<string, unknown> } }>(
      "content_instances.get",
      { id: contentInstanceId },
    );
    expect(got.instance.values.cta_href).toBe(`/${PFX}-about#team`);
    expect(JSON.stringify(got.instance.values)).not.toContain("caelo:page/");

    // …and writing the humanised form back stores the same reference.
    await run("content_instances.set_values", {
      id: contentInstanceId,
      values: got.instance.values,
    });
    const again = await storedValues(contentInstanceId);
    expect(again.cta_href).toBe(`caelo:page/${aboutId}#team`);
    expect(again.body_html).toBe(stored.body_html);
  });

  it("refuses a link to no page with an actionable message and writes nothing", async () => {
    const moduleId = await makeModule("cta-missing", '<a href="{{cta_href}}">x</a>', CTA_FIELDS);
    const message = await refused("content_instances.create", {
      moduleId,
      values: { cta_href: `/${PFX}-nowhere` },
    });
    expect(message).toContain(`"/${PFX}-nowhere" is not the path of any page`);
    expect(message).toContain("list_pages");
    const rows = await asSystem(
      (tx) =>
        tx`SELECT count(*)::int AS n FROM content_instances WHERE module_id = ${moduleId}::uuid`,
    );
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  it("grandfathers a literal already stored, but refuses a new broken one", async () => {
    const moduleId = await makeModule("legacy", '<a href="{{cta_href}}">x</a>', CTA_FIELDS);
    const { contentInstanceId } = await run<{ contentInstanceId: string }>(
      "content_instances.create",
      { moduleId, values: { cta_label: "Legacy" } },
    );
    // Pre-#724 content: a literal to a path that no longer answers.
    await asSystem(
      (tx) => tx`UPDATE content_instances
                 SET "values" = ${JSON.stringify({ cta_label: "Legacy", cta_href: "/gone-before-724" })}::jsonb
                 WHERE id = ${contentInstanceId}::uuid`,
    );
    await run("content_instances.set_values", {
      id: contentInstanceId,
      values: { cta_label: "Legacy, edited", cta_href: "/gone-before-724" },
    });
    expect((await storedValues(contentInstanceId)).cta_href).toBe("/gone-before-724");

    const message = await refused("content_instances.set_values", {
      id: contentInstanceId,
      values: { cta_label: "Legacy", cta_href: `/${PFX}-also-nowhere` },
    });
    expect(message).toContain(`/${PFX}-also-nowhere`);
  });
});

describe("module code", () => {
  it("canonicalises HTML hrefs, media srcs and field defaults; reads humanise", async () => {
    const moduleId = await makeModule(
      "chrome",
      `<nav><a href="/${PFX}-about">About</a><img src="/_caelo/media/${mediaSlug}" alt=""><a href="mailto:x@example.com">Mail</a></nav>{{footer_links}}`,
      [
        {
          name: "footer_links",
          kind: "link-list",
          label: "Footer links",
          default: [{ label: "Pricing", href: `/${PFX}-pricing` }],
        },
      ],
    );
    const stored = await storedModule(moduleId);
    expect(stored.html).toContain(`href="caelo:page/${aboutId}"`);
    expect(stored.html).toContain(`src="caelo:media/${mediaId}"`);
    expect(stored.html).toContain('href="mailto:x@example.com"');
    expect(JSON.stringify(stored.fields)).toContain(`"href":"caelo:page/${pricingId}"`);

    const got = await run<{ module: { html: string; fields: unknown } }>("modules.get", {
      moduleId,
    });
    expect(got.module.html).toContain(`href="/${PFX}-about"`);
    expect(got.module.html).toContain(`src="/_caelo/media/${mediaSlug}"`);
    expect(JSON.stringify(got.module)).not.toContain("caelo:");
  });

  it("refuses an update that adds a link to no page", async () => {
    const moduleId = await makeModule("plain", "<p>{{body_text}}</p>", [
      { name: "body_text", kind: "text", label: "Body" },
    ]);
    const before = await storedModule(moduleId);
    const message = await refused("modules.update", {
      moduleId,
      html: `<p><a href="/${PFX}-ghost">ghost</a>{{body_text}}</p>`,
    });
    expect(message).toContain(`/${PFX}-ghost`);
    expect(await storedModule(moduleId)).toEqual(before);
  });
});

describe("structured sets", () => {
  it("stores every item href as a reference, submenus included", async () => {
    await run("structured_sets.set", {
      kind: "nav-menu",
      slug: `${PFX}-main`,
      displayName: `${PFX} main`,
      items: [
        {
          label: "About",
          href: `/${PFX}-about`,
          children: [{ label: "Pricing", href: `/${PFX}-pricing#plans` }],
        },
        { label: "Docs", href: "https://docs.example.com/" },
      ],
    });
    const rows = await asSystem(
      (tx) => tx`SELECT items FROM structured_sets WHERE slug = ${`${PFX}-main`}`,
    );
    const raw = (rows as { items: unknown }[])[0]?.items;
    const items = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
      href: string;
      children?: { href: string }[];
    }[];
    expect(items[0]?.href).toBe(`caelo:page/${aboutId}`);
    expect(items[0]?.children?.[0]?.href).toBe(`caelo:page/${pricingId}#plans`);
    expect(items[1]?.href).toBe("https://docs.example.com/");

    const got = await run<{ set: { items: { href: string }[] } }>("structured_sets.get", {
      kind: "nav-menu",
      slug: `${PFX}-main`,
    });
    expect(got.set.items[0]?.href).toBe(`/${PFX}-about`);
  });

  it("refuses a set item linking to no page", async () => {
    const message = await refused("structured_sets.set", {
      kind: "link-list",
      slug: `${PFX}-broken`,
      displayName: `${PFX} broken`,
      items: [{ label: "Nope", href: `/${PFX}-void` }],
    });
    expect(message).toContain(`items[0].href: "/${PFX}-void"`);
  });
});

describe("review fixes (#873)", () => {
  it("canonicalises links padded with whitespace and media in a srcset candidate", async () => {
    const moduleId = await makeModule(
      "padded",
      `<a href=" /${PFX}-about">About</a><img src="hero.jpg" srcset="hero.jpg 1x, /_caelo/media/${mediaSlug}/webp-800 2x" alt="">{{note}}`,
      NOTE_FIELD,
    );
    const stored = await storedModule(moduleId);
    expect(stored.html).toContain(`href="caelo:page/${aboutId}"`);
    expect(stored.html).toContain(`srcset="hero.jpg 1x, caelo:media/${mediaId}/webp-800 2x"`);

    await run("structured_sets.set", {
      kind: "link-list",
      slug: `${PFX}-padded`,
      displayName: `${PFX} padded`,
      items: [{ label: "About", href: ` /${PFX}-about` }],
    });
    const rows = await asSystem(
      (tx) => tx`SELECT items FROM structured_sets WHERE slug = ${`${PFX}-padded`}`,
    );
    const raw = (rows as { items: unknown }[])[0]?.items;
    const items = (typeof raw === "string" ? JSON.parse(raw) : raw) as { href: string }[];
    expect(items[0]?.href).toBe(`caelo:page/${aboutId}`);

    // A padded link to no page is checked too (it used to slip through).
    const ctaModule = await makeModule("padded-cta", '<a href="{{cta_href}}">x</a>', CTA_FIELDS);
    const message = await refused("content_instances.create", {
      moduleId: ctaModule,
      values: { cta_href: ` /${PFX}-padded-nowhere` },
    });
    expect(message).toContain(`/${PFX}-padded-nowhere`);
  });

  it("follows permanent redirects only", async () => {
    await run("redirects.create", {
      fromPath: `/${PFX}-moved-for-now`,
      toPath: `/${PFX}-about`,
      statusCode: 302,
    });
    await run("redirects.create", {
      fromPath: `/${PFX}-moved-for-good`,
      toPath: `/${PFX}-about`,
      statusCode: 308,
    });
    const moduleId = await makeModule("redir", '<a href="{{cta_href}}">x</a>', CTA_FIELDS);
    const message = await refused("content_instances.create", {
      moduleId,
      values: { cta_href: `/${PFX}-moved-for-now` },
    });
    expect(message).toContain(`"/${PFX}-moved-for-now" is not the path of any page`);
    const { contentInstanceId } = await run<{ contentInstanceId: string }>(
      "content_instances.create",
      { moduleId, values: { cta_href: `/${PFX}-moved-for-good` } },
    );
    expect((await storedValues(contentInstanceId)).cta_href).toBe(`caelo:page/${aboutId}`);
  });

  it("canonicalises layout HTML on create and update, and refuses a link to no page", async () => {
    const { layoutId } = await run<{ layoutId: string }>("layouts.create", {
      slug: `${PFX}-layout`,
      displayName: `${PFX} layout`,
      html: `<body><a href="/${PFX}-about">About</a><caelo-slot name="content">_</caelo-slot></body>`,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    const html = async () =>
      (
        (await asSystem((tx) => tx`SELECT html FROM layouts WHERE id = ${layoutId}::uuid`)) as {
          html: string;
        }[]
      )[0]?.html;
    expect(await html()).toContain(`href="caelo:page/${aboutId}"`);

    await run("layouts.update", {
      layoutId,
      html: `<body><a href="/${PFX}-pricing#plans">Pricing</a><caelo-slot name="content">_</caelo-slot></body>`,
    });
    expect(await html()).toContain(`href="caelo:page/${pricingId}#plans"`);

    const message = await refused("layouts.update", {
      layoutId,
      html: `<body><a href="/${PFX}-layout-ghost">x</a><caelo-slot name="content">_</caelo-slot></body>`,
    });
    expect(message).toContain(`/${PFX}-layout-ghost`);
    expect(await html()).toContain(`caelo:page/${pricingId}#plans`);
  });

  it("stores the reference form in snapshot rows, so undo restores references", async () => {
    const moduleId = await makeModule(
      "snap",
      `<a href="/${PFX}-about">About</a>{{note}}`,
      NOTE_FIELD,
    );
    const rows = (await asSystem(
      (tx) =>
        tx`SELECT state->>'html' AS html FROM module_snapshots WHERE module_id = ${moduleId}::uuid`,
    )) as { html: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.html).toContain(`caelo:page/${aboutId}`);
      expect(r.html).not.toContain(`href="/${PFX}-about"`);
    }
  });

  it("names the failing entry in bulk refusals (build_page, create_many)", async () => {
    const built = await refused("pages.build_page", {
      page: { slug: `${PFX}-bulk`, title: "Bulk", templateId },
      modules: [
        {
          blockName: "content",
          displayName: "Bulk CTA",
          description: "CTA.",
          kind: "cta",
          html: '<a href="{{cta_href}}">go</a>',
          fields: [{ name: "cta_href", kind: "url", label: "Link" }],
          content: { source: "inline", values: { cta_href: `/${PFX}-bulk-ghost` } },
        },
      ],
    });
    expect(built).toContain('modules[0] ("Bulk CTA")');
    expect(built).toContain(`values.cta_href: "/${PFX}-bulk-ghost"`);

    const moduleId = await makeModule("bulk", '<a href="{{cta_href}}">x</a>', CTA_FIELDS);
    const many = await refused("content_instances.create_many", {
      instances: [
        { moduleId, values: { cta_href: `/${PFX}-about` } },
        { moduleId, values: { cta_href: `/${PFX}-bulk-void` } },
      ],
    });
    expect(many).toContain("instances[1]");
    expect(many).toContain(`/${PFX}-bulk-void`);
  });

  it("edit_content on the humanised body keeps the stored reference", async () => {
    const tools = createDefaultToolRegistry();
    const toolCtx: ToolContext = { adapter, registry };
    const moduleId = await makeModule(
      "roundtrip",
      `<p class="lead">Read <a href="/${PFX}-about#team">about us</a>{{note}}</p>`,
      NOTE_FIELD,
    );
    const before = (await storedModule(moduleId)).html;
    expect(before).toContain(`caelo:page/${aboutId}#team`);

    const read = await tools.dispatch(
      "read_content",
      { entityKind: "module", entityId: moduleId, field: "html" },
      SYSTEM,
      toolCtx,
    );
    expect(read.ok).toBe(true);
    expect(read.content).toContain(`/${PFX}-about#team`);
    expect(read.content).not.toContain("caelo:page/");

    // The AI copies text from what it read — the humanised path included.
    const edit = await tools.dispatch(
      "edit_content",
      {
        entityKind: "module",
        entityId: moduleId,
        field: "html",
        edits: [
          {
            oldString: `Read <a href="/${PFX}-about#team">about us</a>`,
            newString: `Meet <a href="/${PFX}-about#team">the team</a>`,
          },
        ],
      },
      SYSTEM,
      toolCtx,
    );
    expect(edit.ok).toBe(true);
    expect((await storedModule(moduleId)).html).toBe(
      `<p class="lead">Meet <a href="caelo:page/${aboutId}#team">the team</a>{{note}}</p>`,
    );
  });

  it("in a chat, uses the branch's module fields and pages", async () => {
    const moduleId = await makeModule("branchy", "<p>{{target}}</p>", [
      { name: "target", kind: "text", label: "Link" },
    ]);
    const session = await run<{ chatSessionId: string; chatBranchId: string }>(
      "chat.create_session",
      { isolation: "experiment", title: `${SESSION_PREFIX}branch` },
    );
    const chat: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: `${PFX}-chat`,
      chatBranchId: session.chatBranchId,
      chatTaskId: session.chatSessionId,
    };
    const inChat = async <T>(op: string, input: unknown): Promise<T> => {
      const r = await execute(registry, adapter, chat, op, input);
      if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
      return r.value as T;
    };
    // The chat turns the field into a link field (a branched module edit:
    // main's row still says `text`) and creates the page it links to.
    await inChat("modules.update", {
      moduleId,
      html: '<a href="{{target}}">go</a>',
      fields: [{ name: "target", kind: "url", label: "Link" }],
    });
    const page = await inChat<{ pageId: string }>("pages.create", {
      slug: `${PFX}-branch-only`,
      title: "Branch only",
      templateId,
    });
    const { contentInstanceId } = await inChat<{ contentInstanceId: string }>(
      "content_instances.create",
      { moduleId, values: { target: `/${PFX}-branch-only` } },
    );
    expect((await storedValues(contentInstanceId)).target).toBe(`caelo:page/${page.pageId}`);

    // A module that does not exist is a loud refusal, not "no fields".
    const r = await execute(registry, adapter, chat, "content_instances.create", {
      moduleId: "00000000-0000-4000-8000-0000000000aa",
      values: { cta_href: `/${PFX}-about` },
    });
    expect(r.ok).toBe(false);
  });
});
