// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 part B — the one-way migration of the three dogfood installs
 * (0350–0353), replayed against a dogfood-shaped fixture.
 *
 * The test database is already migrated, so the pre-0350 shape is rebuilt
 * inside one transaction: a scratch schema first on the search_path holds
 * the tables the migrations touch (only the columns they read), the
 * fixture goes in, the migration files run verbatim (single source — no
 * drifting copy of their SQL here) and the transaction rolls back.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const DIR = join(import.meta.dir, "..", "migrations", "cms_admin");

/** Migration body without its BEGIN/COMMIT, so it replays inside our transaction. */
function body(file: string): string {
  return readFileSync(join(DIR, file), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(BEGIN|COMMIT)\s*;\s*$/.test(line))
    .join("\n");
}

const PRE_0350 = `
CREATE TABLE actors (id uuid PRIMARY KEY);
CREATE TABLE site_snapshots (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE NOT NULL, description text NOT NULL);
CREATE TABLE roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
CREATE TABLE role_permissions (role_id uuid NOT NULL, permission_id uuid NOT NULL, PRIMARY KEY (role_id, permission_id));
CREATE TABLE templates (
  id uuid PRIMARY KEY, slug text NOT NULL, kind text NOT NULL DEFAULT 'content'
    CONSTRAINT templates_kind_check CHECK (kind IN ('home','landing','product','blog','doc','content','utility')),
  created_at timestamptz NOT NULL, deleted_at timestamptz, chat_branch_id uuid);
CREATE TABLE pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL, template_id uuid NOT NULL REFERENCES templates(id),
  status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, chat_branch_id uuid);
CREATE TABLE page_snapshots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), page_id uuid NOT NULL, state jsonb NOT NULL);
CREATE TABLE deploy_targets (id uuid PRIMARY KEY, env text NOT NULL);
CREATE TABLE deploy_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_id uuid NOT NULL, status text NOT NULL, finished_at timestamptz);
CREATE TABLE site_defaults (id int PRIMARY KEY, default_template_id uuid NOT NULL REFERENCES templates(id));
CREATE TABLE modules (id uuid PRIMARY KEY, html text NOT NULL, fields jsonb NOT NULL);
CREATE TABLE module_snapshots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), module_id uuid NOT NULL, state jsonb NOT NULL);
CREATE TABLE content_instances (id uuid PRIMARY KEY, module_id uuid NOT NULL, "values" jsonb NOT NULL);
CREATE TABLE content_instance_snapshots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), state jsonb NOT NULL);
`;

const ID = {
  tHome: "10000000-0000-0000-0000-000000000001",
  tContent1: "10000000-0000-0000-0000-000000000002",
  tContent2: "10000000-0000-0000-0000-000000000003",
  tBlogOld: "10000000-0000-0000-0000-000000000004",
  tBlog: "10000000-0000-0000-0000-000000000005",
  pHome: "20000000-0000-0000-0000-000000000001",
  pAbout: "20000000-0000-0000-0000-000000000002",
  pDraft: "20000000-0000-0000-0000-000000000003",
  pTeam: "20000000-0000-0000-0000-000000000004",
  pPost: "20000000-0000-0000-0000-000000000005",
  pGone: "20000000-0000-0000-0000-000000000006",
  module: "30000000-0000-0000-0000-000000000001",
  ci: "40000000-0000-0000-0000-000000000001",
  gone: "90000000-0000-0000-0000-000000000009",
};

const MODULE_HTML =
  "<ul>{{#bullets}}<li>{{.}}</li><li>{{ item }}</li>{{/bullets}}</ul>" +
  '<nav>{{#nav}}<a href="{{href}}">{{label}}</a>{{/nav}}</nav>' +
  '<p>{{title}}</p><a href="{{href}}">outside</a>{{#other}}{{.}}{{/other}}';

const MODULE_FIELDS = [
  { name: "title", label: "Title", kind: "text" },
  { name: "bullets", label: "Bullets", kind: "text-list", max: 5, default: ["a", "b"] },
  {
    name: "nav",
    label: "Nav",
    kind: "link-list",
    default: [{ label: "Home", href: "caelo:page/20000000-0000-0000-0000-000000000001" }],
  },
];

const FIXTURE = `
INSERT INTO actors (id) VALUES ('00000000-0000-0000-0000-00000000ffff');
INSERT INTO permissions (name, description) VALUES ('content.write', 'w'), ('content.read', 'r');
INSERT INTO roles (name) VALUES ('owner'), ('editor'), ('reviewer');
INSERT INTO role_permissions SELECT r.id, p.id FROM roles r, permissions p
  WHERE (r.name IN ('owner','editor') AND p.name = 'content.write') OR p.name = 'content.read';
INSERT INTO templates (id, slug, kind, created_at, deleted_at) VALUES
  ('${ID.tHome}', 'home', 'home', '2026-01-01', NULL),
  ('${ID.tContent1}', 'content-a', 'content', '2026-01-02', NULL),
  ('${ID.tContent2}', 'content-b', 'content', '2026-01-03', NULL),
  ('${ID.tBlogOld}', 'blog-old', 'blog', '2026-01-04', '2026-02-01'),
  ('${ID.tBlog}', 'blog', 'blog', '2026-01-05', NULL);
INSERT INTO pages (id, slug, template_id, status, created_at, deleted_at) VALUES
  ('${ID.pHome}', 'home', '${ID.tHome}', 'published', '2026-03-01', NULL),
  ('${ID.pAbout}', 'about', '${ID.tContent1}', 'published', '2026-03-01', NULL),
  ('${ID.pDraft}', 'draft', '${ID.tContent2}', 'draft', '2026-03-01', NULL),
  ('${ID.pTeam}', 'team', '${ID.tContent2}', 'published', '2026-03-01', NULL),
  ('${ID.pPost}', 'post', '${ID.tBlog}', 'published', '2026-05-01', NULL),
  ('${ID.pGone}', 'gone', '${ID.tBlogOld}', 'draft', '2026-01-10', '2026-02-01');
INSERT INTO deploy_targets (id, env) VALUES ('50000000-0000-0000-0000-000000000001', 'production'),
  ('50000000-0000-0000-0000-000000000002', 'staging');
INSERT INTO deploy_runs (target_id, status, finished_at) VALUES
  ('50000000-0000-0000-0000-000000000001', 'succeeded', '2026-04-01T12:00:00Z'),
  ('50000000-0000-0000-0000-000000000001', 'failed', '2026-03-15'),
  ('50000000-0000-0000-0000-000000000002', 'succeeded', '2026-03-02');
INSERT INTO site_defaults (id, default_template_id) VALUES (1, '${ID.tContent2}');
INSERT INTO page_snapshots (page_id, state) VALUES
  ('${ID.pAbout}', '{"schemaVersion":1,"slug":"about","title":"About","templateId":"${ID.tContent1}","status":"published","version":1,"deletedAt":null}'),
  ('${ID.pAbout}', '{"schemaVersion":1,"slug":"about","title":"About","templateId":"${ID.gone}","status":"draft","version":0,"deletedAt":null}');
INSERT INTO modules (id, html, fields) VALUES ('${ID.module}', $h$${MODULE_HTML}$h$, $f$${JSON.stringify(MODULE_FIELDS)}$f$::jsonb);
INSERT INTO module_snapshots (module_id, state) VALUES
  ('${ID.module}', $s$ {"schemaVersion":1,"slug":"m","displayName":"M","type":"m","css":"","js":"","deletedAt":null,"html":"<i>{{#nav}}{{href}}{{/nav}}</i>","fields":[{"name":"nav","label":"Nav","kind":"link-list","default":[{"label":"Old","href":"/old","target":"_blank"}]}]}$s$::jsonb);
INSERT INTO content_instances (id, module_id, "values") VALUES
  ('${ID.ci}', '${ID.module}', '{"title":"T","bullets":["x"],"nav":[{"label":"Empty","href":""}]}');
INSERT INTO content_instance_snapshots (state) VALUES
  ('{"schemaVersion":1,"moduleId":"${ID.module}","slug":null,"displayName":null,"version":2,"deletedAt":null,"values":{"bullets":["y","z"]}}');
`;

interface Entry {
  id: string;
  node: string;
  values: Record<string, unknown>;
}

describe("migrations 0350–0353 on a dogfood-shaped install", () => {
  it("derives page types from template kinds, converts list fields, seeds list types", async () => {
    const sql = new SQL(ADMIN_URL as string);
    const conn = await sql.reserve();
    try {
      await conn`BEGIN`;
      await conn`SELECT set_config('caelo.actor_kind', 'system', true)`;
      await conn.unsafe("CREATE SCHEMA t1107_mig");
      await conn.unsafe("SET LOCAL search_path = t1107_mig, public");
      await conn.unsafe(PRE_0350);
      await conn.unsafe(FIXTURE);
      for (const file of [
        "0350_lists_tables.sql",
        "0351_page_types_from_template_kinds.sql",
        "0352_seed_default_list_types.sql",
        "0353_list_fields_from_text_link_lists.sql",
      ]) {
        await conn.unsafe(body(file));
      }

      // ── page types ────────────────────────────────────────────────
      const types = (await conn`
        SELECT id::text AS id, slug, definition FROM page_types ORDER BY slug
      `) as { id: string; slug: string; definition: Record<string, unknown> }[];
      expect(types.map((t) => t.slug)).toEqual(["blog", "content", "home"]);
      const bySlug = new Map(types.map((t) => [t.slug, t]));
      expect(bySlug.get("content")?.definition).toMatchObject({
        name: "Content page",
        templates: [ID.tContent1, ID.tContent2],
        // content-b carries two live pages, content-a one.
        defaultTemplate: ID.tContent2,
        properties: [],
        vocabularies: [],
      });
      // Deleted templates stay out while the kind has a live one.
      expect(bySlug.get("blog")?.definition).toMatchObject({
        templates: [ID.tBlog],
        defaultTemplate: ID.tBlog,
      });

      const pages = (await conn`
        SELECT p.id::text AS id, pt.slug AS type, p.first_published_at, p.properties
        FROM pages p JOIN page_types pt ON pt.id = p.page_type_id
      `) as { id: string; type: string; first_published_at: Date | null; properties: unknown }[];
      const page = new Map(pages.map((p) => [p.id, p]));
      expect(pages).toHaveLength(6);
      expect(page.get(ID.pHome)?.type).toBe("home");
      expect(page.get(ID.pTeam)?.type).toBe("content");
      expect(page.get(ID.pGone)?.type).toBe("blog");
      expect(page.get(ID.pAbout)?.properties).toEqual({});
      // first_published_at: the first successful PRODUCTION build after creation.
      expect(page.get(ID.pHome)?.first_published_at?.toISOString().slice(0, 10)).toBe("2026-04-01");
      expect(page.get(ID.pDraft)?.first_published_at).toBeNull();
      expect(page.get(ID.pPost)?.first_published_at).toBeNull();

      const snaps = (await conn`
        SELECT state FROM page_snapshots WHERE page_id = ${ID.pAbout}::uuid ORDER BY state->>'version' DESC
      `) as { state: Record<string, unknown> }[];
      expect(snaps[0]?.state).toMatchObject({
        pageTypeId: bySlug.get("content")?.id,
        properties: {},
        terms: [],
      });
      // A snapshot whose template no longer exists keeps its shape.
      expect(snaps[1]?.state).not.toHaveProperty("pageTypeId");

      const defaults = (await conn`SELECT default_page_type_id::text AS id FROM site_defaults`) as {
        id: string;
      }[];
      expect(defaults[0]?.id).toBe(bySlug.get("content")?.id);

      // templates.kind is gone; the INSERT trigger derives the type.
      const kindCol = (await conn`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 't1107_mig' AND table_name = 'templates' AND column_name = 'kind'
      `) as unknown[];
      expect(kindCol).toHaveLength(0);
      const inserted = (await conn`
        INSERT INTO pages (slug, template_id, status) VALUES ('new', ${ID.tBlog}::uuid, 'draft')
        RETURNING page_type_id::text AS t
      `) as { t: string }[];
      expect(inserted[0]?.t).toBe(bySlug.get("blog")?.id);
      await conn`SAVEPOINT orphan`;
      await expect(
        conn`INSERT INTO pages (slug, template_id, status) VALUES ('x', ${ID.tBlogOld}::uuid, 'draft')`,
      ).rejects.toThrow("belongs to no page type");
      await conn`ROLLBACK TO SAVEPOINT orphan`;

      // ── permission ────────────────────────────────────────────────
      const grants = (await conn`
        SELECT r.name FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
        WHERE p.name = 'content.structure' ORDER BY r.name
      `) as { name: string }[];
      expect(grants.map((g) => g.name)).toEqual(["editor", "owner"]);

      // ── list types ────────────────────────────────────────────────
      const listTypes = (await conn`SELECT slug FROM list_types ORDER BY slug`) as {
        slug: string;
      }[];
      expect(listTypes.map((t) => t.slug)).toEqual([
        "categories",
        "links",
        "menu",
        "tags",
        "texts",
      ]);

      // ── module fields + values ────────────────────────────────────
      const mod = (await conn`SELECT html, fields FROM modules WHERE id = ${ID.module}::uuid`) as {
        html: string;
        fields: Record<string, unknown>[];
      }[];
      expect(mod[0]?.html).toBe(
        "<ul>{{#bullets}}<li>{{text}}</li><li>{{text}}</li>{{/bullets}}</ul>" +
          '<nav>{{#nav}}<a href="{{link}}">{{label}}</a>{{/nav}}</nav>' +
          '<p>{{title}}</p><a href="{{href}}">outside</a>{{#other}}{{.}}{{/other}}',
      );
      const [title, bullets, nav] = mod[0]?.fields ?? [];
      expect(title).toEqual({ name: "title", label: "Title", kind: "text" });
      expect(bullets).toMatchObject({
        name: "bullets",
        kind: "list",
        listType: "texts",
        bind: "local",
        max: 5,
      });
      const bulletEntries = (bullets?.default ?? []) as Entry[];
      expect(bulletEntries.map((e) => [e.node, e.values])).toEqual([
        ["text", { text: "a" }],
        ["text", { text: "b" }],
      ]);
      expect(bulletEntries[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(nav).toMatchObject({ kind: "list", listType: "links", bind: "local" });
      expect(((nav?.default ?? []) as Entry[])[0]?.values).toEqual({
        label: "Home",
        link: { href: `caelo:page/${ID.pHome}` },
      });

      const msnap = (await conn`SELECT state FROM module_snapshots`) as {
        state: { html: string; fields: Record<string, unknown>[] };
      }[];
      expect(msnap[0]?.state.html).toBe("<i>{{#nav}}{{link}}{{/nav}}</i>");
      expect(((msnap[0]?.state.fields[0]?.default ?? []) as Entry[])[0]?.values).toEqual({
        label: "Old",
        link: { href: "/old", target: "_blank" },
      });

      const ci = (await conn`SELECT "values" FROM content_instances WHERE id = ${ID.ci}::uuid`) as {
        values: { title: string; bullets: Entry[]; nav: Entry[] };
      }[];
      expect(ci[0]?.values.title).toBe("T");
      expect(ci[0]?.values.bullets.map((e) => e.values)).toEqual([{ text: "x" }]);
      expect(ci[0]?.values.nav[0]?.values).toEqual({ label: "Empty", link: { href: "#" } });

      const cisnap = (await conn`SELECT state FROM content_instance_snapshots`) as {
        state: { values: { bullets: Entry[] } };
      }[];
      expect(cisnap[0]?.state.values.bullets.map((e) => e.values.text)).toEqual(["y", "z"]);
    } finally {
      await conn`ROLLBACK`;
      conn.release();
      await sql.end();
    }
  });
});
