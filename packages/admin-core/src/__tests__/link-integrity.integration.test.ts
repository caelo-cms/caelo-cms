// SPDX-License-Identifier: MPL-2.0

/**
 * Reference integrity (#724 rollout F) over LEGACY literal links: content
 * written before #724 stores `/about`, not `caelo:page/<id>`. The check
 * reports a working literal as a warning (the link migration converts it)
 * and one that matches no page as `broken-literal` — scanned by declared
 * field kind (#846), so image paths and path-shaped copy are never links.
 * Seeds through the op layer, writes the legacy literals underneath it,
 * and runs the check inside an admin tx (the same view the Stage merge uses).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { checkReferences } from "../ops/content/link-integrity.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "link-integrity-test",
};

const TS = Date.now().toString(36);
const TPL_SLUG = `lint-tpl-${TS}`;
const TARGET_SLUG = `lint-target-${TS}`;
const LINKER_SLUG = `lint-linker-${TS}`;
const KINDS_SLUG = `lint-kinds-${TS}`;
let templateId = "";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`lint-%-${TS}`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`lint-%-${TS}`}`;
      await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${`LINT %`})`;
      await tx`DELETE FROM modules WHERE display_name LIKE ${"LINT %"}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
    slug: TPL_SLUG,
    displayName: "LINT TPL",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, systemCtx, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });

  // An existing target page every valid internal link points at.
  const target = await execute(registry, adapter, systemCtx, "pages.build_page", {
    page: { slug: TARGET_SLUG, title: "LINT Target", templateId },
    modules: [
      {
        blockName: "content",
        displayName: "LINT Target Body",
        html: "<p>{{t}}</p>",
        fields: [{ name: "t", kind: "text", label: "T" }],
        content: { source: "inline", values: { t: "hi" } },
      },
    ],
  });
  if (!target.ok) throw new Error(`target seed failed: ${JSON.stringify(target.error)}`);

  // A page whose module links to BOTH the existing target (good) and a
  // page that was never built (broken) — via a hardcoded href in the
  // module HTML AND a url content value. Since #724 the write ops refuse
  // a link to no page and store valid ones as references, so literal
  // links like these exist only in content written before; the page is
  // built valid and the legacy literals are written underneath the ops.
  const linker = await execute(registry, adapter, systemCtx, "pages.build_page", {
    page: { slug: LINKER_SLUG, title: "LINT Linker", templateId },
    modules: [
      {
        blockName: "content",
        displayName: "LINT Linker Nav",
        html: `<nav><a href="#top">frag</a><a href="{{cta_href}}">cta</a></nav>`,
        fields: [{ name: "cta_href", kind: "url", label: "CTA href" }],
        content: { source: "inline", values: { cta_href: "https://example.com/cta" } },
      },
    ],
  });
  if (!linker.ok) throw new Error(`linker seed failed: ${JSON.stringify(linker.error)}`);
  const legacy = new SQL(ADMIN_URL!);
  try {
    await legacy.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`UPDATE modules
               SET html = ${`<nav><a href="/${TARGET_SLUG}">good</a><a href="/does-not-exist">bad html link</a><a href="#top">frag</a><a href="https://example.com">ext</a>{{cta_href}}</nav>`}
               WHERE display_name = 'LINT Linker Nav'`;
      await tx`UPDATE content_instances
               SET "values" = ${JSON.stringify({ cta_href: "/also-missing" })}::jsonb
               WHERE module_id IN (SELECT id FROM modules WHERE display_name = 'LINT Linker Nav')`;
    });
  } finally {
    await legacy.end();
  }

  // #846 — a page whose content values exercise every field kind. Only the
  // link-bearing kinds (link / url default / link-list / richtext / nested
  // sub-module) may be reported; image + text + text-list paths never.
  // The dead links and the legacy image paths are written as
  // `https://legacy.invalid/…` (#724 refuses an internal link to no page
  // and a file path nothing serves) and turned into the legacy literals
  // below, underneath the ops.
  const kinds = await execute(registry, adapter, systemCtx, "pages.build_page", {
    page: { slug: KINDS_SLUG, title: "LINT Kinds", templateId },
    modules: [
      {
        ref: "card",
        // No blockName → detached sub-module, rendered only through the
        // parent's module-list. Its HTML + values must still be scanned.
        displayName: "LINT Kinds Card",
        html: `<article><a href="https://legacy.invalid/missing-nested-html">{{card_label}}</a><a href="{{card_href}}">go</a><img src="{{card_image}}"></article>`,
        fields: [
          { name: "card_label", kind: "text", label: "Card label" },
          { name: "card_href", kind: "link", label: "Card link" },
          { name: "card_image", kind: "image", label: "Card image" },
        ],
        content: {
          source: "inline",
          values: {
            card_label: "/shop/nested-text",
            card_href: "https://legacy.invalid/missing-nested-link",
            card_image: "https://legacy.invalid/media/nested.webp",
          },
        },
      },
      {
        blockName: "content",
        displayName: "LINT Kinds Body",
        html:
          `<section><img src="{{hero_image}}"><p>{{alert_text}}</p>` +
          `{{#tags}}<span>{{.}}</span>{{/tags}}<a href="{{primary_link}}">x</a>` +
          `<a href="{{fallback_href}}">y</a>{{#menu}}<a href="{{href}}">{{label}}</a>{{/menu}}` +
          `<div>{{body}}</div>{{#cards}}_{{/cards}}</section>`,
        fields: [
          { name: "hero_image", kind: "image", label: "Hero image" },
          { name: "alert_text", kind: "text", label: "Alert text" },
          { name: "tags", kind: "text-list", label: "Tags" },
          { name: "primary_link", kind: "link", label: "Primary link" },
          {
            name: "fallback_href",
            kind: "url",
            label: "Fallback href",
            default: "https://legacy.invalid/missing-default-url",
          },
          { name: "menu", kind: "link-list", label: "Menu" },
          { name: "body", kind: "richtext", label: "Body" },
          { name: "cards", kind: "module-list", label: "Cards" },
        ],
        content: {
          source: "inline",
          values: {
            hero_image: "https://legacy.invalid/media/foo.webp",
            alert_text: "/shop/xyz",
            tags: ["/shop/tag-path"],
            primary_link: "https://legacy.invalid/missing-link",
            menu: [
              { label: "Good", href: `/${TARGET_SLUG}` },
              { label: "Bad", href: "https://legacy.invalid/missing-link-list" },
            ],
            body: `<p>See <a href="https://legacy.invalid/missing-richtext">this</a> and <a href="/${TARGET_SLUG}">that</a>.</p>`,
            cards: [{ $ref: "card" }],
          },
        },
      },
    ],
  });
  if (!kinds.ok) throw new Error(`kinds seed failed: ${JSON.stringify(kinds.error)}`);

  // A stored value with no declared field is never rendered, so it is not
  // a link (no "any path-shaped string" fallback, CLAUDE.md §2). The op
  // layer won't write an undeclared key, so plant it directly — this is
  // the shape legacy / drifted rows can carry.
  const placementCi = (kinds.value as { placements: { contentInstanceId: string }[] }).placements[0]
    ?.contentInstanceId;
  if (!placementCi) throw new Error("kinds placement missing");
  const db = new SQL(ADMIN_URL!);
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`UPDATE content_instances SET "values" = "values" || jsonb_build_object('stray_path', ${"/missing-undeclared"}::text) WHERE id = ${placementCi}::uuid`;
      await tx`UPDATE modules
               SET html = replace(html, 'https://legacy.invalid/', '/'),
                   fields = replace(fields::text, 'https://legacy.invalid/', '/')::jsonb
               WHERE display_name LIKE 'LINT Kinds %'`;
      await tx`UPDATE content_instances
               SET "values" = replace("values"::text, 'https://legacy.invalid/', '/')::jsonb
               WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE 'LINT Kinds %')`;
    });
  } finally {
    await db.end();
  }
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

/** The legacy literals the check reports: `broken-literal` targets, unquoted. */
async function brokenLiterals(): Promise<string[]> {
  const issues = await adapter.withAdminTransaction(systemCtx, (tx) =>
    checkReferences(tx, { branchId: null, env: "staging" }),
  );
  return issues.filter((i) => i.problem === "broken-literal").map((i) => i.target.slice(1, -1));
}

describe("reference integrity over legacy literal links (#846 field kinds)", () => {
  it("flags internal links (HTML + content values) that resolve to no page, and NOT valid ones", async () => {
    const broken = await brokenLiterals();
    // Broken: the hardcoded /does-not-exist and the /also-missing content value.
    expect(broken).toContain("/does-not-exist");
    expect(broken).toContain("/also-missing");
    // Not broken: the link to the existing target page.
    expect(broken).not.toContain(`/${TARGET_SLUG}`);
    // Fragments + absolute URLs are not internal-page links — never flagged.
    expect(broken).not.toContain("#top");
    expect(broken).not.toContain("https://example.com");
  });

  it("a working legacy literal is a warning that names its conversion, never a block", async () => {
    const issues = await adapter.withAdminTransaction(systemCtx, (tx) =>
      checkReferences(tx, { branchId: null, env: "production" }),
    );
    const literal = issues.find(
      (i) => i.problem === "literal-link" && i.target === `"/${TARGET_SLUG}"`,
    );
    expect(literal?.severity).toBe("warning");
    expect(literal?.message).toContain("get_link_migration_report");
    // Legacy literals never block: the staged-build check owns broken ones.
    expect(
      issues.filter((i) => i.problem === "broken-literal" || i.problem === "literal-link"),
    ).not.toContainEqual(expect.objectContaining({ severity: "block" }));
  });

  it("#846: scans content values by declared field kind — text paths are never links", async () => {
    const broken = await brokenLiterals();
    // Not links: plain text / text-list copy that starts with `/`, and a
    // stored value with no declared field.
    for (const notALink of [
      "/shop/xyz",
      "/shop/tag-path",
      "/shop/nested-text",
      "/missing-undeclared",
    ]) {
      expect(broken).not.toContain(notALink);
    }
    // An image value is a file reference since rollout C (the write path
    // refuses a file nothing serves, `unknown-file`), so a legacy image
    // path nothing serves is reported as the broken file link it is —
    // never as a page link.
    for (const deadFile of ["/media/foo.webp", "/media/nested.webp"]) {
      expect(broken).toContain(deadFile);
    }
    // Still links, still reported when they point at no page: link value,
    // url field default (what renders when no value is set), link-list
    // href, richtext <a href>, and a nested sub-module's link value + its
    // hardcoded HTML href (nested modules have no placement of their own).
    for (const deadLink of [
      "/missing-link",
      "/missing-default-url",
      "/missing-link-list",
      "/missing-richtext",
      "/missing-nested-link",
      "/missing-nested-html",
    ]) {
      expect(broken).toContain(deadLink);
    }
    // Valid targets reached through link-list + richtext are not flagged.
    expect(broken).not.toContain(`/${TARGET_SLUG}`);
  });
});
