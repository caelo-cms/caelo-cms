// SPDX-License-Identifier: MPL-2.0

/**
 * build_page URL-field resilience — an EMPTY or whitespace-only `kind=url`
 * content value is stored as "" (no link) instead of aborting the WHOLE
 * atomic build_page. It is NOT turned into "#": that made an optional
 * `{{#field}}` section truthy and rendered a dead link (#1095). A genuinely-not-a-URL
 * value (unrecognized non-empty string, or a non-string primitive) still
 * fails loudly with the actionable message. Runs against real Postgres
 * through the op layer so the coercion is exercised end-to-end (write +
 * read-back), not just at the validator return.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, renderTemplate } from "@caelo-cms/shared";
import { SQL } from "bun";
import { buildPageTool } from "../ai/tools/build-page.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "url-coercion-test",
};

const TS = Date.now().toString(36);
const TPL_SLUG = `urlc-tpl-${TS}`;
let templateId = "";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`urlc-%-${TS}`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`urlc-%-${TS}`}`;
      await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${`URLC %`})`;
      await tx`DELETE FROM modules WHERE display_name LIKE ${"URLC %"}`;
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
    displayName: "URLC TPL",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, systemCtx, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

function ctaModule(href: unknown) {
  return {
    blockName: "content",
    displayName: "URLC CTA",
    description: "CTA with a url field",
    kind: "cta" as const,
    html: '<a href="{{cta_href}}">{{cta_label}}</a>',
    fields: [
      { name: "cta_label", kind: "text", label: "Label" },
      { name: "cta_href", kind: "url", label: "Href" },
    ],
    content: { source: "inline" as const, values: { cta_label: "Go", cta_href: href } },
  };
}

describe("build_page url-field resilience", () => {
  it("an EMPTY link_href does NOT abort build_page; the stored value stays empty (#1095)", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: `urlc-empty-${TS}`, title: "URLC Empty", templateId },
      modules: [ctaModule("")],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ciId = (r.value as { placements: { contentInstanceId: string }[] }).placements[0]!
      .contentInstanceId;
    const ci = await execute(registry, adapter, systemCtx, "content_instances.get", { id: ciId });
    if (!ci.ok) throw new Error("ci get failed");
    const values = (ci.value as { instance: { values: Record<string, unknown> } }).instance.values;
    expect(values.cta_href).toBe("");
  });

  it("the stored empty url keeps an optional {{#href}} section hidden (#1095)", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: `urlc-section-${TS}`, title: "URLC Section", templateId },
      modules: [ctaModule("")],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ciId = (r.value as { placements: { contentInstanceId: string }[] }).placements[0]!
      .contentInstanceId;
    const ci = await execute(registry, adapter, systemCtx, "content_instances.get", { id: ciId });
    if (!ci.ok) throw new Error("ci get failed");
    const values = (ci.value as { instance: { values: Record<string, unknown> } }).instance.values;
    const out = renderTemplate({
      html: '<p>{{cta_label}}{{#cta_href}}<a href="{{cta_href}}">more</a>{{/cta_href}}</p>',
      fields: [
        { name: "cta_label", kind: "text" },
        { name: "cta_href", kind: "url" },
      ],
      contentValues: values,
    });
    expect(out.html).toBe("<p>Go</p>");
  });

  it("a WHITESPACE-only link_href is stored as an empty string too", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: `urlc-ws-${TS}`, title: "URLC WS", templateId },
      modules: [ctaModule("   \n\t ")],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ciId = (r.value as { placements: { contentInstanceId: string }[] }).placements[0]!
      .contentInstanceId;
    const ci = await execute(registry, adapter, systemCtx, "content_instances.get", { id: ciId });
    if (!ci.ok) throw new Error("ci get failed");
    const values = (ci.value as { instance: { values: Record<string, unknown> } }).instance.values;
    expect(values.cta_href).toBe("");
  });

  it("a VALID href passes through untouched (not coerced)", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: `urlc-valid-${TS}`, title: "URLC Valid", templateId },
      // External: an internal path must name an existing page (#724).
      modules: [ctaModule("https://example.com/signup")],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ciId = (r.value as { placements: { contentInstanceId: string }[] }).placements[0]!
      .contentInstanceId;
    const ci = await execute(registry, adapter, systemCtx, "content_instances.get", { id: ciId });
    if (!ci.ok) throw new Error("ci get failed");
    const values = (ci.value as { instance: { values: Record<string, unknown> } }).instance.values;
    expect(values.cta_href).toBe("https://example.com/signup");
  });

  it("a genuinely-not-a-URL non-empty string still ABORTS with the actionable kind=url message", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: `urlc-bad-${TS}`, title: "URLC Bad", templateId },
      modules: [ctaModule("not a url")],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msg = (r.error as { message?: string }).message ?? "";
    expect(msg).toContain("kind=url");
    // Atomicity preserved: the page was rolled back.
    const pages = await execute(registry, adapter, systemCtx, "pages.list", {});
    if (!pages.ok) throw new Error("pages.list failed");
    const slugs = (pages.value as { pages: { slug: string }[] }).pages.map((p) => p.slug);
    expect(slugs).not.toContain(`urlc-bad-${TS}`);
  });

  it("a non-string primitive (number) is still rejected", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug: `urlc-num-${TS}`, title: "URLC Num", templateId },
      modules: [ctaModule(123)],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msg = (r.error as { message?: string }).message ?? "";
    expect(msg).toContain("kind=url");
  });

  it("a link to a page that does not exist is a refusal, not a filed bug (#1097)", async () => {
    const page = { slug: `urlc-dead-${TS}`, title: "URLC Dead", templateId };
    const modules = [ctaModule(`/urlc-no-such-page-${TS}/`)];
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", { page, modules });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { refusal?: boolean }).refusal).toBe(true);
    const tool = await buildPageTool.handler(
      systemCtx,
      { page, modules } as never,
      {
        registry,
        adapter,
      } as unknown as ToolContext,
    );
    expect(tool.ok).toBe(false);
    expect(tool.content).toContain("is not the path of any page");
    expect(tool.refusal).toBe(true);
  });
});
