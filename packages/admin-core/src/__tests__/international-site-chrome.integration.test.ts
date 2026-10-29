// SPDX-License-Identifier: MPL-2.0

/**
 * #592 — menus and footer per language, end to end against a real
 * Postgres with a scripted AI provider: the content-variants composition
 * point (core) resolved by international-site's chrome variants.
 *
 * Covers: a missing variant is flagged in the preview and stops the build
 * pass; translate_chrome builds the German chrome in one call; a German
 * page renders the German footer + shared CTA with menu links resolved to
 * the German pages (core's link-resolve point, #724 D — the chrome
 * values keep page references) while the English page keeps its own;
 * independent mode (own items, own module in a layout slot) is never
 * marked stale by source edits while translated mode is; its own links
 * are canonicalised by core, and a link to a page without a German
 * version is flagged by core; re-attaching re-derives from the source.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  localBuildPluginServices,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { resolveBuildContentVariants } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const AI_ACTOR_ID = "00000000-0000-0000-0000-000000000a1a";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t592",
};
const PFX = "t592";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;

/**
 * Scripted translator: answers every offered path with "DE:<source>".
 * #992 — translate_chrome uses structured output, so the answer is built
 * from the JSON Schema the plugin sent (which targets and paths it allows)
 * and the source text from the prompt; `complete` would mean the plugin
 * fell back to parsing free text.
 */
const aiPrompts: string[] = [];
const aiSchemas: Record<string, unknown>[] = [];
type ChromeSchema = {
  properties: {
    targets: {
      items: {
        anyOf: Array<{
          properties: { target: { enum: string[] }; strings: { required: string[] } };
        }>;
      };
    };
  };
};
const scriptedProvider = {
  complete: async () => {
    throw new Error("scripted provider: translate_chrome must call generateObject, not complete");
  },
  generateObject: async (opts: {
    messages: ReadonlyArray<{ content: string }>;
    jsonSchema: Record<string, unknown>;
  }) => {
    const user = opts.messages[0]?.content ?? "";
    aiPrompts.push(user);
    aiSchemas.push(opts.jsonSchema);
    const source = new Map<string, string>();
    for (const section of user.split("### Target ").slice(1)) {
      const id = section.slice(0, section.indexOf(" "));
      for (const m of section.matchAll(/([^\n]+):\n```\n([\s\S]*?)\n```/g)) {
        if (m[1] && m[2] !== undefined) source.set(`${id}|${m[1]}`, m[2]);
      }
    }
    const variants = (opts.jsonSchema as ChromeSchema).properties.targets.items.anyOf;
    const targets = variants.map((v) => {
      const id = v.properties.target.enum[0] ?? "";
      const strings: Record<string, string> = {};
      for (const path of v.properties.strings.required) {
        const text = source.get(`${id}|${path}`);
        if (text === undefined) throw new Error(`schema offers ${id} ${path}, the prompt does not`);
        strings[path] = `DE:${text}`;
      }
      return { target: id, strings };
    });
    return { object: { targets }, inputTokens: 1, outputTokens: 1 };
  },
};

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe(`DELETE FROM redirects WHERE from_path LIKE '%${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM layout_modules WHERE layout_id IN (SELECT id FROM layouts WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(
      `DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM modules WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`DELETE FROM layouts WHERE slug LIKE '${PFX}-%'`);
  });
}

async function sysOp<T>(name: string, args: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS_CTX, name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function op<T>(operationName: string, args: unknown): Promise<T> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
    pluginSlug: "international-site",
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

async function preview(pageId: string): Promise<{ html: string; missingSlots: string[] }> {
  const r = await sysOp<{ html: string; missingSlots: string[] }>("pages.render_preview", {
    pageId,
  });
  // List entries carry their item address (epic #1107); these assertions read the markup.
  return { ...r, html: r.html.replace(/ data-caelo-list-item="[^"]*"/g, "") };
}

/** A local `links` list entry (epic #1107). */
const link = (n: number, label: string, href: string) => ({
  id: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
  node: "link",
  values: { label, link: { href } },
});

const ids = {
  layoutId: "",
  footerModuleId: "",
  altFooterModuleId: "",
  enPricing: "",
  enAbout: "",
  enSolo: "",
  dePreise: "",
  deUeber: "",
};

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  restoreBase = await pinSiteBaseUrl(ADMIN_URL, "https://example.com");
  restoreLanguage = await pinSiteLanguage(ADMIN_URL, "en");
  const report = await bootstrap({
    infra: { adapter, registry, aiProvider: scriptedProvider, lockPluginRow },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));

  ids.layoutId = (
    await sysOp<{ layoutId: string }>("layouts.create", {
      slug: `${PFX}-layout`,
      displayName: "T592 layout",
      html: '<body><caelo-slot name="content"></caelo-slot><caelo-slot name="footer"></caelo-slot></body>',
      css: "",
      blocks: [
        { name: "content", displayName: "Content", position: 0 },
        { name: "footer", displayName: "Footer", position: 1 },
      ],
    })
  ).layoutId;
  const { templateId } = await sysOp<{ templateId: string }>("templates.create", {
    slug: `${PFX}-tpl`,
    displayName: "T592",
    html: '<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
    css: "",
    layoutId: ids.layoutId,
  });
  await sysOp("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  // The pages exist before the footer that links to them: an internal
  // link must name an existing page (#724), stored as a reference.
  for (const slug of ["pricing", "about", "solo"]) {
    const p = await sysOp<{ pageId: string }>("pages.create", {
      slug: `${PFX}-${slug}`,
      title: slug,
      templateId,
    });
    if (slug === "pricing") ids.enPricing = p.pageId;
    if (slug === "about") ids.enAbout = p.pageId;
    if (slug === "solo") ids.enSolo = p.pageId;
  }
  ids.footerModuleId = (
    await sysOp<{ moduleId: string }>("modules.create", {
      slug: `${PFX}-footer`,
      displayName: "Site footer",
      html: '<footer><p class="tag">{{tagline}}</p>{{#nav}}<a href="{{link}}">{{label}}</a>{{/nav}}</footer>',
      css: "",
      js: "",
      fields: [
        { name: "tagline", kind: "text", label: "Tagline", default: "Made with care" },
        {
          name: "nav",
          kind: "list",
          listType: "links",
          label: "Footer menu",
          default: [link(1, "About", "/t592-about")],
        },
      ],
    })
  ).moduleId;
  ids.altFooterModuleId = (
    await sysOp<{ moduleId: string }>("modules.create", {
      slug: `${PFX}-footer-us`,
      displayName: "US footer",
      html: '<footer class="us">{{#nav}}<a href="{{link}}">{{label}}</a>{{/nav}}</footer>',
      css: "",
      js: "",
      fields: [{ name: "nav", kind: "list", listType: "links", label: "Menu", default: [] }],
    })
  ).moduleId;
  await sysOp("layout_modules.set", {
    layoutId: ids.layoutId,
    blockName: "footer",
    moduleIds: [ids.footerModuleId],
  });

  await op("set_locales", {
    locales: [
      { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
      { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
    ],
  });
  ids.dePreise = (
    await op<{ pageId: string }>("create_variant", {
      sourcePageId: ids.enPricing,
      localeCode: "de",
      slug: `${PFX}-preise`,
    })
  ).pageId;
  ids.deUeber = (
    await op<{ pageId: string }>("create_variant", {
      sourcePageId: ids.enAbout,
      localeCode: "de",
      slug: `${PFX}-ueber`,
    })
  ).pageId;
  for (const id of Object.values(ids).slice(3)) {
    await sysOp("pages.set_status", { pageId: id, status: "published" });
  }
}, 60_000);

afterAll(async () => {
  await cleanup();
  await restoreBase?.();
  await restoreLanguage?.();
  await adapter.close();
});

const footerKey = () => `layout:${ids.layoutId}:footer:0`;

describe("#592 — menus and footer per language", () => {
  it("flags a missing German footer in the preview and refuses it in the build pass", async () => {
    const de = await preview(ids.dePreise);
    expect(de.missingSlots.join("\n")).toContain(
      'there is no Deutsch (de) version of "Site footer"',
    );
    // The English page is the source language: untouched, no flags.
    const en = await preview(ids.enPricing);
    // The footer's link is a stored reference (#724), rendered as the
    // page's canonical path.
    expect(en.html).toContain('<a href="/t592-about/">About</a>');
    expect(en.missingSlots.filter((m) => m.startsWith("content-variant:"))).toEqual([]);

    await expect(
      adapter.withAdminTransaction(SYS_CTX, (tx) =>
        resolveBuildContentVariants(tx, localBuildPluginServices, [
          {
            pageId: ids.dePreise,
            slug: `${PFX}-preise`,
            layoutId: ids.layoutId,
            layoutBlocks: new Map([
              [
                "footer",
                [
                  {
                    moduleId: ids.footerModuleId,
                    slug: `${PFX}-footer`,
                    displayName: "Site footer",
                    html: "",
                    css: "",
                    js: "",
                    fields: [{ name: "tagline", kind: "text", default: "Made with care" }],
                  },
                ],
              ],
            ]),
            pageBlocks: [],
          },
        ]),
      ),
    ).rejects.toThrow(/no Deutsch \(de\) version of "Site footer"/);
  }, 60_000);

  it("translate_chrome builds the German footer + shared content; links go to German pages", async () => {
    // Shared content synced on the English AND the German pricing page.
    const cta = await sysOp<{ moduleId: string }>("modules.create", {
      slug: `${PFX}-cta`,
      displayName: "Call to action",
      html: '<a class="cta" href="{{cta_href}}">{{cta_label}}</a>',
      css: "",
      js: "",
      fields: [
        { name: "cta_label", kind: "text", label: "Label" },
        { name: "cta_href", kind: "url", label: "Link" },
      ],
    });
    await sqlSystem(async (tx) => {
      const ci = (await tx.unsafe(
        `INSERT INTO content_instances (module_id, slug, display_name, "values")
         VALUES ('${cta.moduleId}', '${PFX}-cta-shared', 'CTA', '{"cta_label": "Talk to us", "cta_href": "caelo:page/${ids.enAbout}"}')
         RETURNING id::text AS id`,
      )) as { id: string }[];
      for (const pageId of [ids.enPricing, ids.dePreise]) {
        await tx.unsafe(
          `INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
           VALUES ('${pageId}', 'content', 9, '${cta.moduleId}', '${ci[0]?.id}', 'synced')`,
        );
      }
    });

    const r = await op<{ translated: number }>("translate_chrome", { localeCode: "de" });
    expect(r.translated).toBeGreaterThanOrEqual(2);
    expect(aiPrompts.at(-1)).toContain("Made with care");
    expect(aiPrompts.at(-1)).toContain("Talk to us");
    // #992 — the schema sent offers exactly the prompt's targets, closed.
    const sent = aiSchemas.at(-1) as ChromeSchema & { additionalProperties: boolean };
    expect(sent.additionalProperties).toBe(false);
    const offeredIds = [...(aiPrompts.at(-1) ?? "").matchAll(/### Target (c\d+) /g)].map(
      (m) => m[1],
    );
    expect(sent.properties.targets.items.anyOf.map((v) => v.properties.target.enum[0])).toEqual(
      offeredIds,
    );

    const de = await preview(ids.dePreise);
    expect(de.missingSlots.filter((m) => m.startsWith("content-variant:"))).toEqual([]);
    expect(de.html).toContain('<p class="tag">DE:Made with care</p>');
    // Menu link resolved to the German "about" page, in core's canonical form.
    expect(de.html).toContain('<a href="/de/t592-ueber/">DE:About</a>');
    expect(de.html).toMatch(/<a class="cta" href="\/de\/t592-ueber\/"[^>]*>DE:Talk to us<\/a>/);
    // English keeps its own chrome.
    const en = await preview(ids.enPricing);
    expect(en.html).toContain('<p class="tag">Made with care</p>');
    expect(en.html).toMatch(/<a class="cta" href="\/t592-about\/"[^>]*>Talk to us<\/a>/);
    // The SEO read's core text shows the same per-language shared content
    // and leaves the (translated) footer chrome out.
    const seo = await sysOp<{ pages: { pageId: string; contentText: string }[] }>(
      "pages_seo.get_many",
      { pageIds: [ids.dePreise, ids.enPricing] },
    );
    expect(seo.pages[0]?.contentText).toContain("DE:Talk to us");
    expect(seo.pages[0]?.contentText).not.toContain("Made with care");
    expect(seo.pages[1]?.contentText).toContain("Talk to us");
    expect(seo.pages[1]?.contentText).not.toContain("DE:");

    const status = await op<{ chrome: { targetKey: string; locales: Record<string, string> }[] }>(
      "intl_status",
      {},
    );
    expect(status.chrome.find((c) => c.targetKey === footerKey())?.locales.de).toBe(
      "translated/up_to_date",
    );
  }, 60_000);

  it("independent chrome keeps its own items and module; source edits mark only translated chrome stale", async () => {
    await op("set_chrome_variants", {
      variants: [
        {
          targetKey: footerKey(),
          localeCode: "de",
          moduleId: ids.altFooterModuleId,
          values: {
            nav: [
              link(2, "Kontakt", "/t592-solo"),
              // A stored reference (#724) is named by its page's path, never its id.
              link(3, "Team", `caelo:page/${ids.enSolo}#team`),
            ],
          },
        },
      ],
    });
    const de = await preview(ids.dePreise);
    expect(de.html).toContain('<footer class="us"');
    expect(de.html).not.toContain('<p class="tag">');
    // The variant's own link was stored as a reference to the page...
    const stored = await sqlSystem(async (tx) => {
      // Plugin tables are FORCE-RLS scoped to the plugin's id.
      const plug =
        (await tx`SELECT id::text AS id FROM plugins WHERE slug = 'international-site'`) as {
          id: string;
        }[];
      await tx.unsafe(`SET LOCAL caelo.plugin_id = '${plug[0]?.id}'`);
      return tx`SELECT "values"::text AS v FROM plugin_international_site.chrome_variants WHERE locale_code = 'de' AND module_id IS NOT NULL`;
    });
    expect((stored as { v: string }[])[0]?.v).toContain(`caelo:page/${ids.enSolo}`);
    // ...which has no German version: flagged, not silently English.
    expect(de.missingSlots).toContain(`link-variant-missing:page/${ids.enSolo}:de`);
    expect(de.html).not.toContain('href="/t592-solo/"');
    // English still shows the source footer.
    expect((await preview(ids.enPricing)).html).toContain('<p class="tag">Made with care</p>');

    // Edit the source: footer default + the shared CTA.
    await sqlSystem(async (tx) => {
      await tx.unsafe(
        `UPDATE modules SET fields = jsonb_set(fields, '{0,default}', '"Made with even more care"') WHERE id = '${ids.footerModuleId}'`,
      );
      await tx.unsafe(
        `UPDATE content_instances SET "values" = '{"cta_label": "Call us", "cta_href": "caelo:page/${ids.enAbout}"}' WHERE slug = '${PFX}-cta-shared'`,
      );
    });
    const status = await op<{
      chrome: { targetKey: string; label: string; locales: Record<string, string> }[];
    }>("intl_status", {});
    expect(status.chrome.find((c) => c.targetKey === footerKey())?.locales.de).toBe(
      "independent (own module)",
    );
    expect(status.chrome.find((c) => c.label.startsWith("Call to action"))?.locales.de).toBe(
      "translated/needs_update",
    );
  }, 60_000);

  it("re-attaching re-derives the footer from the source", async () => {
    const r = await op<{ translated: number }>("reattach_chrome_variant", {
      targetKey: footerKey(),
      localeCode: "de",
    });
    expect(r.translated).toBe(1);
    const de = await preview(ids.dePreise);
    expect(de.html).toContain('<p class="tag">DE:Made with even more care</p>');
    expect(de.html).not.toContain('<footer class="us"');
  }, 60_000);

  it("set_chrome_variants is all-or-nothing: a refused variant stores none of the batch", async () => {
    const status = await op<{ chrome: { targetKey: string; label: string }[] }>("intl_status", {});
    const ctaKey = status.chrome.find((c) => c.label.startsWith("Call to action"))?.targetKey;
    if (!ctaKey) throw new Error("CTA chrome target missing — the translate_chrome test seeds it");
    const readRows = () =>
      sqlSystem(async (tx) => {
        // Plugin tables are FORCE-RLS scoped to the plugin's id.
        const plug =
          (await tx`SELECT id::text AS id FROM plugins WHERE slug = 'international-site'`) as {
            id: string;
          }[];
        await tx.unsafe(`SET LOCAL caelo.plugin_id = '${plug[0]?.id}'`);
        return tx`SELECT target_key, locale_code, mode, "values"::text AS v FROM plugin_international_site.chrome_variants ORDER BY target_key, locale_code`;
      });
    const before = await readRows();
    expect(before.length).toBeGreaterThan(0);

    // The first variant is valid; the second links to a path that names
    // no page, which core's canonicalisation refuses.
    await expect(
      op("set_chrome_variants", {
        variants: [
          {
            targetKey: ctaKey,
            localeCode: "de",
            values: { cta_label: "Schreib uns", cta_href: "/t592-ueber" },
          },
          {
            targetKey: footerKey(),
            localeCode: "de",
            values: { nav: [link(4, "Nirgends", "/t592-nowhere")] },
          },
        ],
      }),
    ).rejects.toThrow(/t592-nowhere/);
    expect(await readRows()).toEqual(before);
  }, 60_000);
});

describe("#1196 — chrome translation plans against the chat's draft", () => {
  it("a field the chat added to the footer is offered by translate_chrome in that chat", async () => {
    const chat = await sysOp<{ chatSessionId: string; chatBranchId: string }>(
      "chat.create_session",
      { title: `${PFX}-chrome-draft` },
    );
    // The chat acts for an Owner: translate_chrome needs content.write.
    const owner = crypto.randomUUID();
    await sqlSystem(async (tx) => {
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${owner}::uuid, 'human', 'Owner')`;
      await tx`INSERT INTO users (id, email, password_hash) VALUES (${owner}::uuid, ${`${owner}@t1196.test`}, 'test-only')`;
      await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${owner}::uuid, id FROM roles WHERE name = 'owner'`;
    });
    const chatCtx: ExecutionContext = {
      actorId: AI_ACTOR_ID,
      actorKind: "ai",
      requestId: "t1196",
      chatBranchId: chat.chatBranchId,
      chatTaskId: chat.chatSessionId,
    };
    const [footer] = (await sqlSystem(
      (tx) => tx`SELECT html, fields FROM modules WHERE id = ${ids.footerModuleId}::uuid`,
    )) as { html: string; fields: unknown }[];
    const fields = (
      typeof footer?.fields === "string" ? JSON.parse(footer.fields) : footer?.fields
    ) as Record<string, unknown>[];
    // Since #1156 a layout module edit in a chat is draft state: the live
    // row keeps the old fields until a Stage.
    const updated = await execute(registry, adapter, chatCtx, "modules.update", {
      moduleId: ids.footerModuleId,
      html: `${footer?.html}<a class="mbar">{{mbar_label}}</a>`,
      fields: [
        ...fields,
        { name: "mbar_label", kind: "text", label: "Demo button", default: "Book a demo" },
      ],
    });
    if (!updated.ok) throw new Error(JSON.stringify(updated.error));

    const inChat = await runPluginOperation({
      invocation: {
        origin: "chat",
        actorId: AI_ACTOR_ID,
        operatorActorId: owner,
        chatBranchId: chat.chatBranchId,
        chatTaskId: chat.chatSessionId,
      },
      pluginSlug: "international-site",
      operationName: "translate_chrome",
      args: { localeCode: "de" },
    });
    if (!inChat.ok) throw new Error(`${inChat.error.kind}: ${inChat.error.message}`);
    expect(aiPrompts.at(-1)).toContain("Book a demo");

    // Main has not seen the field: the live chrome stays as it was.
    const live = await sysOp<{
      layoutPlacements: { moduleId: string; fields: { name: string }[] }[];
    }>("pages.list_shared_content", {});
    const liveFooter = live.layoutPlacements.find((p) => p.moduleId === ids.footerModuleId);
    expect(liveFooter?.fields.map((f) => f.name)).not.toContain("mbar_label");

    // A module the chat places in a layout block is a chrome target on
    // its branch only.
    const placed = await execute(registry, adapter, chatCtx, "layout_modules.set", {
      layoutId: ids.layoutId,
      blockName: "footer",
      moduleIds: [ids.footerModuleId, ids.altFooterModuleId],
    });
    if (!placed.ok) throw new Error(JSON.stringify(placed.error));
    const mainView = await sysOp<typeof live>("pages.list_shared_content", {});
    expect(mainView.layoutPlacements.some((p) => p.moduleId === ids.altFooterModuleId)).toBe(false);
    const r = await execute(
      registry,
      adapter,
      { ...SYS_CTX, chatBranchId: chat.chatBranchId },
      "pages.list_shared_content",
      {},
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const branchView = r.value as typeof live;
    expect(branchView.layoutPlacements.some((p) => p.moduleId === ids.altFooterModuleId)).toBe(
      true,
    );
  }, 60_000);
});
