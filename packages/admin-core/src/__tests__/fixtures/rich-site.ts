// SPDX-License-Identifier: MPL-2.0

/**
 * A site shaped like a real marketing site (searchVIU, 2026-11): pages of
 * ~250 KB composed HTML out of a dozen modules — inline SVG illustrations
 * and logo strips, base64 data-URI images, a script and a stylesheet per
 * module, a shared header menu and local link lists, a card grid of nested
 * modules, internal page references, and copy that differs on every page.
 *
 * The small-page fixtures of the scale tests (#1003, #1271) render the same
 * module template on every page, so per-render costs that depend on the
 * template text being unique (sections, lists, nested modules and link
 * references all paste content into it) never showed there. Rows are
 * inserted with SQL in bulk, so a few hundred pages seed in seconds.
 */

import type { SQL } from "bun";

/** Every row this fixture writes carries this prefix in its slug. */
export const RICH_PREFIX = "rich";

/** Deterministic pseudo-random numbers, so every run renders the same bytes. */
function prng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x = (x * 1103515245 + 12345) >>> 0;
    return x / 2 ** 32;
  };
}

/** An inline SVG of about `kb` KB of path data. */
export function svg(seed: number, kb: number): string {
  const rnd = prng(seed);
  const paths: string[] = [];
  let size = 0;
  while (size < kb * 1024) {
    const n = () => (rnd() * 400).toFixed(2);
    const p = `<path d="M${n()} ${n()}C${n()} ${n()} ${n()} ${n()} ${n()} ${n()}L${n()} ${n()}Z" fill="#${Math.floor(rnd() * 0xffffff)
      .toString(16)
      .padStart(6, "0")}"/>`;
    paths.push(p);
    size += p.length;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" aria-hidden="true">${paths.join("")}</svg>`;
}

/** A base64 data-URI image of about `kb` KB. */
export function dataUri(seed: number, kb: number): string {
  const rnd = prng(seed);
  const bytes = new Uint8Array(Math.round((kb * 1024 * 3) / 4));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(rnd() * 256);
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

function css(slug: string): string {
  const rules: string[] = [];
  for (let i = 0; i < 24; i += 1) {
    rules.push(
      `.${slug}__el-${i}{display:flex;gap:${i}px;padding:${i % 5}rem ${i % 3}rem;color:#1a1a1a;border-radius:${i}px}`,
    );
  }
  return rules.join("\n");
}

function js(slug: string): string {
  return `document.querySelectorAll(".${slug} [data-toggle]").forEach(function (el) {
  el.addEventListener("click", function () {
    var target = document.getElementById(el.getAttribute("data-toggle"));
    if (target) target.hidden = !target.hidden;
    el.setAttribute("aria-expanded", String(!target.hidden));
  });
});`;
}

/** The text of page `i`'s copy block `k` (~3 KB, different on every page). */
function copy(i: number, k: number): string {
  const para = `<p>Page ${i}, part ${k}: a site migration moves URLs, templates and content at once; every redirect, canonical and internal link has to land where search engines expect it.</p>`;
  return para.repeat(16);
}

interface ModuleDef {
  slug: string;
  html: string;
  fields: unknown[];
  kind: "chrome" | "hero" | "content" | "cta";
}

/** The modules of the fixture; `home` is the page every CTA links to. */
function modules(): ModuleDef[] {
  const m = (
    slug: string,
    kind: ModuleDef["kind"],
    html: string,
    fields: unknown[],
  ): ModuleDef => ({ slug: `${RICH_PREFIX}-${slug}`, kind, html, fields });
  const text = (name: string) => ({ name, kind: "text", label: name });
  return [
    m(
      "header",
      "chrome",
      `<div class="rich-header"><a href="/" class="rich-header__logo">${svg(1, 8)}</a><button data-toggle="rich-menu" aria-expanded="false">Menu</button><nav id="rich-menu"><ul>{{#menu}}<li><a href="{{link}}">{{label}}</a></li>{{/menu}}</ul></nav></div>`,
      [
        {
          name: "menu",
          kind: "list",
          listType: "menu",
          bind: "shared",
          list: "{{MENU_LIST}}",
          label: "Menu",
        },
      ],
    ),
    m(
      "footer",
      "chrome",
      `<div class="rich-footer"><ul>{{#links}}<li><a href="{{link}}">{{label}}</a></li>{{/links}}</ul><div class="rich-footer__social">${svg(2, 6)}</div><p>{{copyright}}</p></div>`,
      [{ name: "links", kind: "list", listType: "links", label: "Links" }, text("copyright")],
    ),
    m(
      "hero",
      "hero",
      `<section class="rich-hero"><h1>{{hero_title}}</h1><p>{{hero_text}}</p><img src="{{hero_image}}" alt="{{hero_title}}" width="600" height="400"><div class="rich-hero__art">${svg(3, 20)}</div><a class="rich-hero__cta" href="{{cta_href}}">{{cta_label}}</a></section>`,
      [
        text("hero_title"),
        text("hero_text"),
        { name: "hero_image", kind: "image", label: "Image" },
        text("cta_label"),
        { name: "cta_href", kind: "url", label: "Link" },
      ],
    ),
    m(
      "card",
      "content",
      `<article class="rich-card"><div class="rich-card__icon">{{icon}}</div><h3>{{card_title}}</h3><p>{{card_text}}</p></article>`,
      [text("icon"), text("card_title"), text("card_text")],
    ),
    m(
      "cards",
      "content",
      `<section class="rich-cards"><h2>{{cards_title}}</h2><div class="rich-cards__grid">{{#cards}}{{/cards}}</div></section>`,
      [text("cards_title"), { name: "cards", kind: "module-list", label: "Cards" }],
    ),
    m(
      "logos",
      "content",
      `<section class="rich-logos"><h2>{{logos_title}}</h2>${svg(4, 32)}</section>`,
      [text("logos_title")],
    ),
    m("copy", "content", `<section class="rich-copy"><h2>{{copy_title}}</h2>{{body}}</section>`, [
      text("copy_title"),
      { name: "body", kind: "richtext", label: "Body" },
    ]),
    m(
      "faq",
      "content",
      `<section class="rich-faq"><h2>{{faq_title}}</h2><dl>{{#faqs}}<dt>{{label}}</dt><dd><a href="{{link}}">Read the answer to {{label}}</a></dd>{{/faqs}}</dl></section>`,
      [text("faq_title"), { name: "faqs", kind: "list", listType: "links", label: "FAQ" }],
    ),
    m(
      "screenshot",
      "content",
      `<figure class="rich-shot"><img src="${dataUri(5, 27)}" alt="{{shot_alt}}" width="800" height="500"><figcaption>{{shot_caption}}</figcaption></figure>`,
      [text("shot_alt"), text("shot_caption")],
    ),
    m(
      "steps",
      "content",
      `<section class="rich-steps"><h2>{{steps_title}}</h2>${svg(6, 26)}<p>{{steps_text}}</p></section>`,
      [text("steps_title"), text("steps_text")],
    ),
    m(
      "cta",
      "cta",
      `<aside class="rich-cta"><p>{{cta_text}}</p><a href="{{cta_href}}">{{cta_label}}</a>${svg(7, 4)}</aside>`,
      [text("cta_text"), text("cta_label"), { name: "cta_href", kind: "url", label: "Link" }],
    ),
  ];
}

/** Placements of every page: module slug suffix + the values of page `i`. */
function placements(
  i: number,
  home: string,
  cards: { moduleId: string; contentInstanceId: string }[],
): { module: string; values: (i: number) => Record<string, unknown> }[] {
  const linkList = (n: number, label: string) =>
    Array.from({ length: n }, (_, k) => ({
      id: crypto.randomUUID(),
      node: "link",
      values: {
        label: `${label} ${k + 1} of page ${i}`,
        link: { href: k % 2 === 0 ? `caelo:page/${home}` : `https://example.org/${label}/${k}` },
      },
    }));
  return [
    {
      module: "hero",
      values: () => ({
        hero_title: `Rich page ${i}`,
        hero_text: `Why page ${i} matters for a migration.`,
        hero_image: dataUri(1000 + (i % 7), 27),
        cta_label: "Start",
        cta_href: `caelo:page/${home}`,
      }),
    },
    {
      module: "cards",
      values: () => ({ cards_title: `What page ${i} covers`, cards }),
    },
    { module: "logos", values: () => ({ logos_title: `Trusted on page ${i}` }) },
    { module: "copy", values: () => ({ copy_title: `Part one of ${i}`, body: copy(i, 1) }) },
    { module: "screenshot", values: () => ({ shot_alt: `Screen ${i}`, shot_caption: `Shot ${i}` }) },
    { module: "faq", values: () => ({ faq_title: `Questions on ${i}`, faqs: linkList(10, "faq") }) },
    { module: "copy", values: () => ({ copy_title: `Part two of ${i}`, body: copy(i, 2) }) },
    { module: "steps", values: () => ({ steps_title: `Steps ${i}`, steps_text: `Do ${i}.` }) },
    { module: "copy", values: () => ({ copy_title: `Part three of ${i}`, body: copy(i, 3) }) },
    {
      module: "cta",
      values: () => ({ cta_text: `Ready, page ${i}?`, cta_label: "Go", cta_href: `caelo:page/${home}` }),
    },
  ];
}

/** Ids the fixture hands back for seeding more pages. */
export interface RichSite {
  readonly templateId: string;
  readonly homeId: string;
  readonly moduleIds: ReadonlyMap<string, string>;
  readonly cards: { moduleId: string; contentInstanceId: string }[];
  /** Pages seeded so far (the home page included). */
  seeded: number;
}

/** Delete every row of the fixture (templates are seed data the reset keeps). */
export async function wipeRichSite(tx: SQL): Promise<void> {
  const like = `${RICH_PREFIX}-%`;
  await tx`DELETE FROM deploy_runs`;
  await tx`UPDATE site_defaults SET home_page_id = NULL WHERE home_page_id IN (SELECT id FROM pages WHERE slug LIKE ${like})`;
  await tx`DELETE FROM layout_modules WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${like})`;
  await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${like})`;
  await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${like})`;
  await tx`DELETE FROM pages WHERE slug LIKE ${like}`;
  await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${like})`;
  await tx`DELETE FROM modules WHERE slug LIKE ${like}`;
  await tx`DELETE FROM lists WHERE slug LIKE ${like}`;
}

/**
 * Seed the modules, the site chrome (header + footer on the `site-default`
 * layout), the shared menu, the nested cards and the home page.
 *
 * @param templateId a template on the `site-default` layout with a `content` block.
 */
export async function seedRichSite(tx: SQL, templateId: string): Promise<RichSite> {
  const menuId = crypto.randomUUID();
  const moduleIds = new Map<string, string>();
  const homeRows = (await tx`
    INSERT INTO pages (slug, title, template_id, status)
    VALUES (${`${RICH_PREFIX}-home`}, 'Rich home', ${templateId}::uuid, 'published')
    RETURNING id::text AS id`) as { id: string }[];
  const homeId = homeRows[0]?.id ?? "";
  const menuItems = Array.from({ length: 25 }, (_, k) => ({
    id: crypto.randomUUID(),
    node: "entry",
    values: { label: `Menu entry ${k + 1}`, link: { href: `caelo:page/${homeId}` } },
  }));
  await tx`
    INSERT INTO lists (id, slug, name, purpose, list_type_id, items)
    SELECT ${menuId}::uuid, ${`${RICH_PREFIX}-menu`}, 'Rich menu', 'Header navigation of the rich fixture.',
           t.id, ${JSON.stringify(menuItems)}::text::jsonb
    FROM list_types t WHERE t.slug = 'menu' AND t.chat_branch_id IS NULL AND t.deleted_at IS NULL`;
  for (const def of modules()) {
    const fields = JSON.stringify(def.fields).replaceAll("{{MENU_LIST}}", `caelo:list/${menuId}`);
    const rows = (await tx`
      INSERT INTO modules (slug, display_name, type, kind, html, css, js, fields, description)
      VALUES (${def.slug}, ${def.slug}, ${def.slug}, ${def.kind}, ${def.html}, ${css(def.slug)},
              ${js(def.slug)}, ${fields}::text::jsonb, 'Rich fixture module.')
      RETURNING id::text AS id`) as { id: string }[];
    moduleIds.set(def.slug.slice(RICH_PREFIX.length + 1), rows[0]?.id ?? "");
  }
  const id = (slug: string) => moduleIds.get(slug) ?? "";
  // Chrome: synced instances on the site-default layout.
  const footerValues = {
    links: Array.from({ length: 40 }, (_, k) => ({
      id: crypto.randomUUID(),
      node: "link",
      values: { label: `Footer link ${k + 1}`, link: { href: `https://example.org/f/${k}` } },
    })),
    copyright: "(c) Rich fixture",
  };
  await tx`
    INSERT INTO content_instances (module_id, slug, values)
    VALUES (${id("footer")}::uuid, ${`${RICH_PREFIX}-footer`}, ${JSON.stringify(footerValues)}::text::jsonb)`;
  // Layout modules render from field defaults: put the footer values there.
  const footerFields = modules()
    .find((d) => d.slug === `${RICH_PREFIX}-footer`)
    ?.fields.map((f) => {
      const field = f as { name: string };
      return { ...field, default: footerValues[field.name as keyof typeof footerValues] };
    });
  await tx`UPDATE modules SET fields = ${JSON.stringify(footerFields)}::text::jsonb WHERE id = ${id("footer")}::uuid`;
  await tx`
    INSERT INTO layout_modules (layout_id, block_name, position, module_id)
    SELECT l.id, b.block, 0, b.module_id
    FROM layouts l,
         (VALUES ('header', ${id("header")}::uuid), ('footer', ${id("footer")}::uuid)) AS b(block, module_id)
    WHERE l.slug = 'site-default'`;
  // Six nested cards, shared by every page's card grid.
  const cards: { moduleId: string; contentInstanceId: string }[] = [];
  for (let k = 0; k < 6; k += 1) {
    const values = {
      icon: svg(100 + k, 5),
      card_title: `Card ${k + 1}`,
      card_text: `What card ${k + 1} is about.`,
    };
    const rows = (await tx`
      INSERT INTO content_instances (module_id, values)
      VALUES (${id("card")}::uuid, ${JSON.stringify(values)}::text::jsonb)
      RETURNING id::text AS id`) as { id: string }[];
    cards.push({ moduleId: id("card"), contentInstanceId: rows[0]?.id ?? "" });
  }
  const site: RichSite = { templateId, homeId, moduleIds, cards, seeded: 0 };
  await insertPlacements(tx, site, [{ pageId: homeId, i: 0 }]);
  site.seeded = 1;
  return site;
}

async function insertPlacements(
  tx: SQL,
  site: RichSite,
  pages: readonly { pageId: string; i: number }[],
): Promise<void> {
  const instances: { id: string; module_id: string; values: unknown }[] = [];
  const rows: { page_id: string; position: number; module_id: string; ci: string }[] = [];
  for (const { pageId, i } of pages) {
    placements(i, site.homeId, site.cards).forEach((p, position) => {
      const moduleId = site.moduleIds.get(p.module) ?? "";
      const ci = crypto.randomUUID();
      instances.push({ id: ci, module_id: moduleId, values: p.values(i) });
      rows.push({ page_id: pageId, position, module_id: moduleId, ci });
    });
  }
  await tx`
    INSERT INTO content_instances (id, module_id, values)
    SELECT x.id, x.module_id, x.values
    FROM jsonb_to_recordset(${JSON.stringify(instances)}::text::jsonb) AS x(id uuid, module_id uuid, values jsonb)`;
  await tx`
    INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
    SELECT x.page_id, 'content', x.position, x.module_id, x.ci, 'unsynced'
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb)
      AS x(page_id uuid, position int, module_id uuid, ci uuid)`;
  await tx`
    INSERT INTO pages_seo (page_id, meta_description)
    SELECT x.page_id, 'A page of the rich-site fixture.'
    FROM jsonb_to_recordset(${JSON.stringify(pages.map((p) => ({ page_id: p.pageId })))}::text::jsonb)
      AS x(page_id uuid)
    ON CONFLICT DO NOTHING`;
}

/** Add published pages until the site has `n` (the home page counts). */
export async function seedRichPagesTo(tx: SQL, site: RichSite, n: number): Promise<void> {
  if (n <= site.seeded) return;
  const pages: { pageId: string; i: number }[] = [];
  for (let i = site.seeded; i < n; i += 1) {
    const rows = (await tx`
      INSERT INTO pages (slug, title, template_id, status)
      VALUES (${`${RICH_PREFIX}-page-${i}`}, ${`Rich page ${i}`}, ${site.templateId}::uuid, 'published')
      RETURNING id::text AS id`) as { id: string }[];
    pages.push({ pageId: rows[0]?.id ?? "", i });
  }
  for (let at = 0; at < pages.length; at += 50) {
    await insertPlacements(tx, site, pages.slice(at, at + 50));
  }
  site.seeded = n;
}
