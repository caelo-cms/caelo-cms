// SPDX-License-Identifier: MPL-2.0

/**
 * #592 — menus and footer per language, end to end against a real
 * Postgres with a scripted AI provider: the content-variants composition
 * point (core) resolved by international-site's chrome variants.
 *
 * Covers: a missing variant is flagged in the preview and stops the build
 * pass; translate_chrome builds the German chrome in one call; a German
 * page renders the German footer + shared CTA with menu links mapped to
 * the German pages (canonical form from core's URL builder) while the
 * English page keeps its own; independent mode (own items, own module in
 * a layout slot) is never marked stale by source edits while translated
 * mode is; a link to a page without a German version is flagged;
 * re-attaching re-derives from the source.
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
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
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

/** Scripted translator: answers every offered path with "DE:<source>". */
const aiPrompts: string[] = [];
const scriptedProvider = {
  complete: async (opts: { messages: ReadonlyArray<{ content: string }> }) => {
    const user = opts.messages[0]?.content ?? "";
    aiPrompts.push(user);
    const targets: { target: string; strings: Record<string, string> }[] = [];
    for (const section of user.split("### Target ").slice(1)) {
      const id = section.slice(0, section.indexOf(" "));
      const strings: Record<string, string> = {};
      for (const m of section.matchAll(/([^\n]+):\n```\n([\s\S]*?)\n```/g)) {
        if (m[1] && m[2] !== undefined) strings[m[1]] = `DE:${m[2]}`;
      }
      targets.push({ target: id, strings });
    }
    return { text: JSON.stringify({ targets }), inputTokens: 1, outputTokens: 1 };
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
  return sysOp("pages.render_preview", { pageId });
}

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
    infra: { adapter, registry, aiProvider: scriptedProvider },
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
  ids.footerModuleId = (
    await sysOp<{ moduleId: string }>("modules.create", {
      slug: `${PFX}-footer`,
      displayName: "Site footer",
      html: '<footer><p class="tag">{{tagline}}</p>{{#nav}}<a href="{{href}}">{{label}}</a>{{/nav}}</footer>',
      css: "",
      js: "",
      fields: [
        { name: "tagline", kind: "text", label: "Tagline", default: "Made with care" },
        {
          name: "nav",
          kind: "link-list",
          label: "Footer menu",
          default: [{ label: "About", href: "/t592-about" }],
        },
      ],
    })
  ).moduleId;
  ids.altFooterModuleId = (
    await sysOp<{ moduleId: string }>("modules.create", {
      slug: `${PFX}-footer-us`,
      displayName: "US footer",
      html: '<footer class="us">{{#nav}}<a href="{{href}}">{{label}}</a>{{/nav}}</footer>',
      css: "",
      js: "",
      fields: [{ name: "nav", kind: "link-list", label: "Menu", default: [] }],
    })
  ).moduleId;
  await sysOp("layout_modules.set", {
    layoutId: ids.layoutId,
    blockName: "footer",
    moduleIds: [ids.footerModuleId],
  });

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
    expect(en.html).toContain('<a href="/t592-about">About</a>');
    expect(en.missingSlots.filter((m) => m.startsWith("content-variant:"))).toEqual([]);

    await expect(
      adapter.withAdminTransaction(SYS_CTX, (tx) =>
        resolveBuildContentVariants(
          tx,
          localBuildPluginServices,
          [
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
          ],
          "directory",
        ),
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
         VALUES ('${cta.moduleId}', '${PFX}-cta-shared', 'CTA', '{"cta_label": "Talk to us", "cta_href": "/t592-about/"}')
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

    const de = await preview(ids.dePreise);
    expect(de.missingSlots.filter((m) => m.startsWith("content-variant:"))).toEqual([]);
    expect(de.html).toContain('<p class="tag">DE:Made with care</p>');
    // Menu link mapped to the German "about" page, in core's canonical form.
    expect(de.html).toContain('<a href="/de/t592-ueber/">DE:About</a>');
    expect(de.html).toMatch(/<a class="cta" href="\/de\/t592-ueber\/"[^>]*>DE:Talk to us<\/a>/);
    // English keeps its own chrome.
    const en = await preview(ids.enPricing);
    expect(en.html).toContain('<p class="tag">Made with care</p>');
    expect(en.html).toMatch(/<a class="cta" href="\/t592-about\/"[^>]*>Talk to us<\/a>/);

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
          values: { nav: [{ label: "Kontakt", href: "/t592-solo" }] },
        },
      ],
    });
    const de = await preview(ids.dePreise);
    expect(de.html).toContain('<footer class="us"');
    expect(de.html).not.toContain('<p class="tag">');
    // The link target has no German version: flagged, not silently English.
    expect(de.missingSlots.join("\n")).toContain(
      'the link "/t592-solo" goes to a page that has no Deutsch version',
    );
    // English still shows the source footer.
    expect((await preview(ids.enPricing)).html).toContain('<p class="tag">Made with care</p>');

    // Edit the source: footer default + the shared CTA.
    await sqlSystem(async (tx) => {
      await tx.unsafe(
        `UPDATE modules SET fields = jsonb_set(fields, '{0,default}', '"Made with even more care"') WHERE id = '${ids.footerModuleId}'`,
      );
      await tx.unsafe(
        `UPDATE content_instances SET "values" = '{"cta_label": "Call us", "cta_href": "/t592-about/"}' WHERE slug = '${PFX}-cta-shared'`,
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
});
