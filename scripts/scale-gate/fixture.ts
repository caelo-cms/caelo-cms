// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — the scale-gate fixture: a site shaped like the 50,000-page
 * target with a long history, seeded into a THROWAWAY database.
 *
 * Structure goes through the real Query API operations (users' logins, MCP
 * tokens, templates, modules, page types, lists, chats, the
 * international-site plugin and its locales), so what the gate measures is
 * reached the way the product reaches it. Volume (pages, placements,
 * terms, SEO rows, variant groups, snapshot history) is bulk SQL with
 * `generate_series`, like the scale integration tests do: creating 50,000
 * pages through `pages.create` would measure `pages.create`.
 *
 *   CAELO_SCALE_GATE_THROWAWAY_DB=1 SCALE_GATE_PAGES=50000 \
 *     bun scripts/scale-gate/fixture.ts --out scale-gate-fixture.json
 *
 * Shape for N pages (docs/dev/scale-gate.md): 0.7·N English pages, 0.3·N
 * German variants of the first ones (so agents still have pages left to
 * translate), every page one article placement with its own content
 * instance, every 50th page an overview with a page-query list, one
 * category term per page, an SEO row per page; ≈4·N staged snapshots of
 * history and ≈0.4·N pending ones spread over 20 open chats on the shared
 * draft; an owner and five editors with sessions; twenty admin MCP tokens.
 */

import { hashPassword } from "@caelo-cms/admin-core";
import { bootstrap, runPluginOperation } from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../../packages/admin-core/src/register.ts";

/** What the runner needs to drive the seeded site. */
export interface ScaleGateFixture {
  readonly pages: number;
  readonly draftBranchId: string;
  /** Session cookies (`caelo_session` values) of the five editors. */
  readonly editors: ReadonlyArray<{
    readonly email: string;
    readonly sessionToken: string;
    readonly chatSessionId: string;
  }>;
  /** Admin-scoped MCP bearer tokens, one per agent. */
  readonly mcpTokens: readonly string[];
  /** English pages without a German variant yet: the agents' work queue. */
  readonly untranslated: ReadonlyArray<{ readonly id: string; readonly path: string }>;
  /** Published pages editors open and preview. */
  readonly editorPages: ReadonlyArray<{ readonly id: string; readonly path: string }>;
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "scale-gate-fixture",
};
const SITE_BASE_URL = "https://scale-gate.example";
const PASSWORD = "scale gate password";
const AGENTS = 20;
const EDITORS = 5;
const OPEN_CHATS = 20;
const CATEGORIES = 10;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (point it at the throwaway database)`);
  return v;
}

function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

async function main(): Promise<void> {
  if (process.env.CAELO_SCALE_GATE_THROWAWAY_DB !== "1") {
    throw new Error(
      "scripts/scale-gate/fixture.ts seeds tens of thousands of rows and rewrites site settings. Point ADMIN_DATABASE_URL at a throwaway database and set CAELO_SCALE_GATE_THROWAWAY_DB=1.",
    );
  }
  const adminUrl = requireEnv("ADMIN_DATABASE_URL");
  const publicUrl = requireEnv("PUBLIC_ADMIN_DATABASE_URL");
  const n = Number.parseInt(process.env.SCALE_GATE_PAGES ?? "50000", 10);
  if (!Number.isInteger(n) || n < 100)
    throw new Error("SCALE_GATE_PAGES must be an integer >= 100");
  const out = argValue("--out", "scale-gate-fixture.json");
  const sources = Math.round(n * 0.7);
  const variants = n - sources;
  const started = Date.now();
  const step = (label: string) =>
    console.log(`[scale-gate fixture] ${((Date.now() - started) / 1000).toFixed(1)}s ${label}`);

  const adapter = new DatabaseAdapter({ adminDatabaseUrl: adminUrl, publicDatabaseUrl: publicUrl });
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  const raw = new SQL(adminUrl, { max: 2 });

  /** One transaction as `system`, for the bulk part. */
  const asSystem = <T>(fn: (tx: SQL) => Promise<T>): Promise<T> =>
    raw.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx.unsafe("SET LOCAL statement_timeout = 0");
      return fn(tx as unknown as SQL);
    }) as Promise<T>;

  const op = async <T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> => {
    const r = await execute(registry, adapter, ctx, name, input);
    if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error).slice(0, 800)}`);
    return r.value as T;
  };

  try {
    const existing = (await asSystem(
      (tx) => tx`SELECT count(*)::int AS n FROM pages`,
    )) as unknown as { n: number }[];
    if ((existing[0]?.n ?? 0) > 0) {
      throw new Error(
        "the database already holds pages — the fixture seeds a fresh install only (drop and re-migrate it)",
      );
    }

    // --- People: owner + editors (users are seed data, logins are real).
    const passwordHash = await hashPassword(PASSWORD);
    const people = await asSystem(async (tx) => {
      const made: { email: string; id: string }[] = [];
      for (let i = 0; i <= EDITORS; i += 1) {
        const email = i === 0 ? "owner@scale-gate.example" : `editor${i}@scale-gate.example`;
        const actor = (await tx`
          INSERT INTO actors (kind, display_name) VALUES ('human', ${email}) RETURNING id::text AS id
        `) as unknown as { id: string }[];
        const id = actor[0]?.id ?? "";
        await tx`INSERT INTO users (id, email, password_hash, is_first_owner, onboarded_at)
                 VALUES (${id}::uuid, ${email}, ${passwordHash}, ${i === 0}, now())`;
        await tx`INSERT INTO user_roles (user_id, role_id)
                 SELECT ${id}::uuid, r.id FROM roles r WHERE r.name = ${i === 0 ? "owner" : "editor"}`;
        made.push({ email, id });
      }
      await tx`UPDATE site_defaults SET site_base_url = ${SITE_BASE_URL} WHERE id = 1`;
      return made;
    });
    const owner = people[0];
    if (!owner) throw new Error("owner seed failed");
    const ownerCtx: ExecutionContext = {
      actorId: owner.id,
      actorKind: "human",
      requestId: "scale-gate",
    };
    // Live Mode refuses to open without an AI provider (/welcome/ai). The
    // load never calls the model: agents use Power-MCP tools directly.
    await op(SYS, "ai_providers.set", {
      name: "anthropic",
      displayName: "Scale gate (never called)",
      isActive: true,
      apiKey: "sk-ant-scale-gate-not-a-real-key",
    });
    step("people + AI provider");

    // --- The international-site plugin, active, with two locales.
    const report = await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: intlPlugin }],
    });
    if (report.failed.length > 0)
      throw new Error(`plugin bootstrap: ${JSON.stringify(report.failed)}`);
    const locales = await runPluginOperation({
      invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
      pluginSlug: "international-site",
      operationName: "set_locales",
      args: {
        locales: [
          { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
          { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
        ],
      },
    });
    if (!locales.ok) throw new Error(`set_locales: ${locales.error.message}`);
    step("plugin + locales");

    // --- Structure: categories, a news page type, modules, a mega menu.
    const vocab = await op<{ lists: { id: string }[] }>(SYS, "lists.upsert_many", {
      lists: [
        {
          slug: "sg-categories",
          name: "News categories",
          purpose: "Sections the news are filed under",
          type: "categories",
          items: Array.from({ length: CATEGORIES }, (_, i) => ({
            node: "category",
            values: { name: `Category ${i + 1}`, slug: `category-${i + 1}` },
          })),
        },
      ],
    });
    const vocabId = vocab.lists[0]?.id ?? "";
    const catItems = (
      await op<{ list: { items: { id: string }[] } }>(SYS, "lists.get", { slug: "sg-categories" })
    ).list.items.map((it) => it.id);
    const { templateId } = await op<{ templateId: string }>(SYS, "templates.create", {
      slug: "sg-news",
      displayName: "News article",
      html: '<main><caelo-slot name="content"></caelo-slot></main>',
    });
    await op(SYS, "page_types.upsert_many", {
      pageTypes: [
        {
          slug: "news",
          name: "News",
          purpose: "Dated news articles",
          templates: [templateId],
          defaultTemplate: templateId,
          properties: [],
          vocabularies: [{ list: vocabId, cardinality: "many" }],
        },
      ],
    });
    const article = await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: "sg-article",
      displayName: "Article",
      description: "The body of a news article: heading and text.",
      html: '<article><h1>{{heading}}</h1><div class="body">{{body}}</div></article>',
      fields: [
        { name: "heading", kind: "text", label: "Heading", default: "Heading" },
        { name: "body", kind: "richtext", label: "Body", default: "<p>Body</p>" },
      ],
    });
    const feed = await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: "sg-news-feed",
      displayName: "Latest news",
      description: "The newest news articles, as a page query.",
      html: '<ul class="feed">{{#latest}}<li><a href="{{link}}">{{title}}</a></li>{{/latest}}</ul>',
      fields: [
        {
          name: "latest",
          kind: "list",
          label: "Latest news",
          listType: "links",
          bind: "source",
          source: {
            kind: "query",
            editable: ["limit"],
            defaults: { page_type: "news", order: "published_desc", limit: 5 },
          },
        },
      ],
    });
    await op(SYS, "list_types.upsert_many", {
      listTypes: [
        {
          slug: "sg-mega",
          name: "Mega menu",
          purpose: "Header navigation with columns and the latest news",
          role: "navigation",
          root: { allow: ["column"] },
          nodes: {
            column: {
              label: "Column",
              fields: [{ name: "heading", type: "text", label: "Heading", required: true }],
              children: { name: "links", allow: ["news"] },
            },
            news: {
              label: "Latest news",
              fields: [],
              source: {
                kind: "query",
                editable: ["limit"],
                defaults: { page_type: "news", order: "published_desc", limit: 3 },
              },
            },
          },
        },
      ],
    });
    await op(SYS, "lists.upsert_many", {
      lists: [
        {
          slug: "sg-header",
          name: "Header",
          purpose: "Main navigation",
          type: "sg-mega",
          items: [
            {
              node: "column",
              values: { heading: "News" },
              children: [{ node: "news", values: {}, query: { limit: 3 } }],
            },
          ],
        },
      ],
    });
    step("structure");

    // --- Volume: pages, placements, terms, SEO, variant groups.
    const pageTypeRows = (await asSystem(
      (tx) => tx`SELECT id::text AS id FROM page_types WHERE slug = 'news' AND deleted_at IS NULL`,
    )) as unknown as { id: string }[];
    const pageTypeId = pageTypeRows[0]?.id ?? "";
    const pluginRows = (await asSystem(
      (tx) => tx`SELECT id::text AS id FROM plugins WHERE slug = 'international-site'`,
    )) as unknown as { id: string }[];
    const pluginId = pluginRows[0]?.id ?? "";
    if (!pageTypeId || !pluginId) throw new Error("page type or plugin row missing");

    await asSystem(async (tx) => {
      await tx.unsafe(`
        INSERT INTO pages (slug, title, short_title, template_id, page_type_id, page_type_confirmed, current_path, status,
                           first_published_at, created_at, updated_at)
        SELECT 'news-' || i, 'News article ' || i, 'News ' || i, '${templateId}', '${pageTypeId}', true,
               '/news-' || i, 'published',
               now() - (i || ' minutes')::interval, now() - (i || ' minutes')::interval, now()
        FROM generate_series(1, ${sources}) i`);
      await tx.unsafe(`
        INSERT INTO pages (slug, title, short_title, template_id, page_type_id, page_type_confirmed, current_path, status,
                           first_published_at, created_at, updated_at)
        SELECT 'nachricht-' || i, 'Nachricht ' || i, 'Nachricht ' || i, '${templateId}', '${pageTypeId}', true,
               '/de/nachricht-' || i, 'published',
               now() - (i || ' minutes')::interval, now() - (i || ' minutes')::interval, now()
        FROM generate_series(1, ${variants}) i`);
      // One article placement per page, each with its own content instance.
      await tx.unsafe(`
        WITH p AS MATERIALIZED (
               SELECT id, title, gen_random_uuid() AS ci_id FROM pages WHERE deleted_at IS NULL),
             ci AS (
               INSERT INTO content_instances (id, module_id, "values")
               SELECT p.ci_id, '${article.moduleId}',
                      jsonb_build_object('heading', p.title,
                                         'body', '<p>' || repeat('Lorem ipsum dolor sit amet. ', 20) || '</p>')
               FROM p RETURNING id)
        INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
        SELECT p.id, 'content', 0, '${article.moduleId}', p.ci_id, 'unsynced'
        FROM p WHERE EXISTS (SELECT 1 FROM ci WHERE ci.id = p.ci_id)`);
      // Every 50th English page is an overview with the page-query feed.
      await tx.unsafe(`
        WITH ci AS (
          INSERT INTO content_instances (module_id, "values", slug, display_name, purpose)
          VALUES ('${feed.moduleId}', '{}'::jsonb, 'sg-latest-news', 'Latest news', 'Shared feed of the newest articles')
          RETURNING id)
        INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
        SELECT p.id, 'content', 1, '${feed.moduleId}', ci.id, 'synced'
        FROM pages p, ci WHERE p.slug ~ '^news-[0-9]+$' AND (substring(p.slug from 6)::int % 50) = 0`);
      await tx.unsafe(`
        INSERT INTO page_terms (page_id, list_id, item_id)
        SELECT p.id, '${vocabId}', (ARRAY['${catItems.join("','")}']::uuid[])[1 + (abs(hashtext(p.id::text)) % ${catItems.length})]
        FROM pages p`);
      await tx.unsafe(`
        INSERT INTO pages_seo (page_id, meta_description)
        SELECT id, 'About ' || title FROM pages
        ON CONFLICT (page_id) DO UPDATE SET meta_description = EXCLUDED.meta_description`);
      await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${pluginId}', true)`);
      await tx.unsafe(`
        WITH pairs AS (
          SELECT en.id AS en, de.id AS de, gen_random_uuid() AS g
          FROM generate_series(1, ${variants}) i
          JOIN pages en ON en.slug = 'news-' || i
          JOIN pages de ON de.slug = 'nachricht-' || i)
        INSERT INTO plugin_international_site.page_variants
          (group_id, page_id, locale_code, translation_status, created_at)
        SELECT g, en, 'en', 'source', now() - interval '1 second' FROM pairs
        UNION ALL
        SELECT g, de, 'de', 'up_to_date', now() FROM pairs`);
    });
    step(`pages: ${sources} en + ${variants} de`);

    // --- Chats: twenty open chats on the shared draft, one per editor.
    const chats: string[] = [];
    for (let i = 0; i < OPEN_CHATS; i += 1) {
      const c = await op<{ chatSessionId: string }>(ownerCtx, "chat.create_session", {
        title: `Open chat ${i + 1}`,
      });
      chats.push(c.chatSessionId);
    }
    const editors: { email: string; sessionToken: string; chatSessionId: string }[] = [];
    for (const person of people.slice(1)) {
      const login = await op<{ token: string }>(SYS, "auth.login", {
        email: person.email,
        password: PASSWORD,
      });
      const c = await op<{ chatSessionId: string }>(
        { actorId: person.id, actorKind: "human", requestId: "scale-gate" },
        "chat.create_session",
        { title: `Editor ${person.email}` },
      );
      editors.push({
        email: person.email,
        sessionToken: login.token,
        chatSessionId: c.chatSessionId,
      });
    }
    const draft = (await asSystem(
      (tx) => tx`SELECT branch_id::text AS id FROM site_draft WHERE id = 1`,
    )) as unknown as { id: string }[];
    const draftBranchId = draft[0]?.id ?? "";
    if (!draftBranchId) throw new Error("site_draft row missing");
    step("chats");

    // --- History: ≈4·N staged snapshots, ≈0.4·N pending on the draft.
    const staged = 4 * n;
    const pending = Math.round(0.4 * n);
    await asSystem(async (tx) => {
      // #1267 — the history is loaded without change-journal rows, inside
      // this transaction only: in production snapshots this old are past
      // the journal's retention, so their rows would be gone already.
      // The previous release's site-view trigger (0394) is a DEFERRED
      // constraint trigger, kept until 0442: its events would be pending
      // at the ALTER TABLE below ("pending trigger events"). Firing it per
      // statement in this transaction keeps it running, just not deferred.
      await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
      for (const t of ["site_snapshots", "page_snapshots"]) {
        await tx.unsafe(`ALTER TABLE ${t} DISABLE TRIGGER caelo_journal_insert`);
      }
      const pageState = (title: string) => `jsonb_build_object(
          'schemaVersion', 1, 'slug', p.slug, 'title', ${title}, 'shortTitle', p.short_title,
          'templateId', p.template_id, 'status', p.status, 'version', p.version, 'deletedAt', null,
          'parentPageId', p.parent_page_id, 'pageTypeId', p.page_type_id, 'properties', p.properties,
          'terms', '[]'::jsonb)`;
      await tx.unsafe(`
        WITH pg AS (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM pages),
             cnt AS (SELECT count(*) AS c FROM pg),
             h AS (
               INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id,
                                           created_at, staged_at)
               SELECT '${owner.id}', 'pages.update', 'history ' || i,
                      (ARRAY['${chats.join("','")}']::uuid[])[1 + i % ${chats.length}],
                      '${draftBranchId}', now() - ((${staged} - i) || ' seconds')::interval - interval '2 days',
                      now() - ((${staged} - i) || ' seconds')::interval - interval '1 day'
               FROM generate_series(1, ${staged}) i
               RETURNING id, (substring(description from 9))::int AS i)
        INSERT INTO page_snapshots (site_snapshot_id, page_id, state)
        SELECT h.id, p.id, ${pageState("p.title")}
        FROM h CROSS JOIN cnt
        JOIN pg ON pg.rn = 1 + (h.i % cnt.c)
        JOIN pages p ON p.id = pg.id`);
      await tx.unsafe(`
        WITH pg AS (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM pages),
             h AS (
               INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id, created_at)
               SELECT '${owner.id}', 'pages.update', 'pending ' || i,
                      (ARRAY['${chats.join("','")}']::uuid[])[1 + i % ${chats.length}],
                      '${draftBranchId}', now() - ((${pending} - i) || ' seconds')::interval
               FROM generate_series(1, ${pending}) i
               RETURNING id, (substring(description from 9))::int AS i)
        INSERT INTO page_snapshots (site_snapshot_id, page_id, state)
        SELECT h.id, p.id, ${pageState("p.title || ' (edited)'")}
        FROM h JOIN pg ON pg.rn = h.i JOIN pages p ON p.id = pg.id`);
      for (const t of ["site_snapshots", "page_snapshots"]) {
        await tx.unsafe(`ALTER TABLE ${t} ENABLE TRIGGER caelo_journal_insert`);
      }
    });
    step(`history: ${staged} staged + ${pending} pending snapshots`);

    // --- MCP tokens for the agents (admin scope: Power-MCP tool calls).
    const mcpTokens: string[] = [];
    for (let i = 0; i < AGENTS; i += 1) {
      const t = await op<{ plaintextToken: string }>(ownerCtx, "mcp_tokens.create", {
        displayName: `scale-gate agent ${i + 1}`,
        scope: "admin",
      });
      mcpTokens.push(t.plaintextToken);
    }
    step("mcp tokens");

    const untranslated = (await asSystem(
      (tx) => tx`SELECT id::text AS id, current_path AS path FROM pages
                 WHERE slug ~ '^news-[0-9]+$' AND substring(slug from 6)::int > ${variants}
                 ORDER BY substring(slug from 6)::int`,
    )) as unknown as { id: string; path: string }[];
    const editorPages = (await asSystem(
      (tx) => tx`SELECT id::text AS id, current_path AS path FROM pages
                 WHERE slug ~ '^news-[0-9]+$' ORDER BY substring(slug from 6)::int LIMIT 500`,
    )) as unknown as { id: string; path: string }[];
    await asSystem((tx) => tx`ANALYZE`);

    const fixture: ScaleGateFixture = {
      pages: n,
      draftBranchId,
      editors,
      mcpTokens,
      untranslated,
      editorPages,
    };
    await Bun.write(out, JSON.stringify(fixture, null, 2));
    step(`wrote ${out}`);
  } finally {
    await raw.end();
    await adapter.close();
  }
}

await main();
process.exit(0);
