// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout F) — reference integrity against real Postgres.
 *
 *   - every covered surface (page content, module HTML, nested module,
 *     field default of layout chrome, layout HTML, template HTML, nav set)
 *     reports a link to a deleted page as blocking, with its place and tool;
 *   - a chat's draft is checked as its preview shows it (branch overlay);
 *   - a missing target refuses the Stage merge and nothing reaches main;
 *     fixing the link in the same chat lets the Stage through;
 *   - a link to an unpublished page is a Stage warning and blocks Publish
 *     live (the `references` quality check reports an error);
 *   - the `check_links` tool output (chat catalogue).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { checkReferences } from "../ops/content/link-integrity.js";
import { referenceSourcesFromOps } from "../quality/checks/links-sources.js";
import { createReferencesCheck } from "../quality/checks/references.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "ref-integrity",
};
const PFX = `rif-${Date.now().toString(36)}`;
let templateId = "";
let layoutId = "";

async function admin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function run<T = unknown>(ctx: ExecutionContext, op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** A page with one "Promo" module whose `cta_href` links to `href`. */
async function promoPage(
  ctx: ExecutionContext,
  slug: string,
  status: "draft" | "published",
  href: string,
): Promise<{ pageId: string; contentInstanceId: string; moduleId: string }> {
  const v = await run<{
    pageId: string;
    placements: { contentInstanceId: string; moduleId: string }[];
  }>(ctx, "pages.build_page", {
    page: { slug, title: slug, templateId, status },
    modules: [
      {
        blockName: "content",
        displayName: `RIF Promo ${slug}`,
        html: `<section><a href="{{cta_href}}">go</a></section>`,
        fields: [{ name: "cta_href", kind: "url", label: "CTA" }],
        content: { source: "inline", values: { cta_href: href } },
      },
    ],
  });
  const p = v.placements[0];
  if (!p) throw new Error("no placement");
  return { pageId: v.pageId, contentInstanceId: p.contentInstanceId, moduleId: p.moduleId };
}

async function experiment(
  title: string,
): Promise<{ chatSessionId: string; ctx: ExecutionContext }> {
  const s = await run<{ chatSessionId: string; chatBranchId: string }>(SYS, "chat.create_session", {
    isolation: "experiment",
    title: `${PFX}-${title}`,
  });
  return {
    chatSessionId: s.chatSessionId,
    ctx: { ...SYS, requestId: `rif-${title}`, chatBranchId: s.chatBranchId },
  };
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  layoutId = await admin(async (tx) => {
    const rows = (await tx`
      INSERT INTO layouts (slug, display_name, html, css)
      VALUES (${`${PFX}-layout`}, 'RIF Layout',
              '<body><caelo-slot name="header"></caelo-slot><caelo-slot name="content"></caelo-slot></body>', '')
      RETURNING id::text AS id
    `) as { id: string }[];
    const id = rows[0]?.id as string;
    await tx`INSERT INTO layout_blocks (layout_id, name, display_name, position)
             VALUES (${id}::uuid, 'header', 'Header', 0), (${id}::uuid, 'content', 'Content', 1)`;
    return id;
  });
  templateId = (
    await run<{ templateId: string }>(SYS, "templates.create", {
      slug: `${PFX}-tpl`,
      displayName: "RIF Template",
      layoutId,
      html: `<main><caelo-slot name="content">_</caelo-slot></main>`,
    })
  ).templateId;
  await run(SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  // Sets, templates and layouts survive the per-file reset: remove ours.
  await admin(async (tx) => {
    await tx`DELETE FROM structured_sets WHERE slug LIKE ${`${PFX}%`}`;
    await tx`UPDATE templates SET deleted_at = now() WHERE slug LIKE ${`${PFX}%`}`;
    await tx`UPDATE layouts SET deleted_at = now() WHERE slug LIKE ${`${PFX}%`}`;
  });
  await adapter.close();
});

describe("reference integrity — covered surfaces", () => {
  it("reports a deleted target on every surface, blocking, with its place and fixing tool — in the chat's draft", async () => {
    const gone = await promoPage(SYS, `${PFX}-gone`, "published", "https://example.com/x");
    const linker = await promoPage(SYS, `${PFX}-linker`, "published", `/${PFX}-gone#top`);
    // Module HTML (a hard-coded link), canonicalised at write.
    await run(SYS, "modules.update", {
      moduleId: linker.moduleId,
      html: `<section><a href="{{cta_href}}">go</a><a href="/${PFX}-gone">again</a></section>`,
    });
    // A nested module's link value, rendered through the parent's module-list.
    await run(SYS, "pages.build_page", {
      page: { slug: `${PFX}-nested`, title: "nested", templateId, status: "published" },
      modules: [
        {
          ref: "card",
          displayName: "RIF Card",
          html: `<a href="{{card_href}}">card</a>`,
          fields: [{ name: "card_href", kind: "link", label: "Card" }],
          content: { source: "inline", values: { card_href: `/${PFX}-gone` } },
        },
        {
          blockName: "content",
          displayName: "RIF Cards",
          html: "<div>{{#cards}}_{{/cards}}</div>",
          fields: [{ name: "cards", kind: "module-list", label: "Cards" }],
          content: { source: "inline", values: { cards: [{ $ref: "card" }] } },
        },
      ],
    });
    // Layout chrome: a header module whose link-list DEFAULT links the page.
    const header = await run<{ moduleId: string }>(SYS, "modules.create", {
      slug: `${PFX}-header`,
      displayName: "RIF Header",
      html: `<nav>{{#nav_links}}<a href="{{href}}">{{label}}</a>{{/nav_links}}</nav>`,
      fields: [
        {
          name: "nav_links",
          kind: "link-list",
          label: "Nav",
          default: [{ label: "Gone", href: `/${PFX}-gone` }],
        },
      ],
    });
    // The menu renders through its nav-menu module (slug convention).
    const menu = await run<{ moduleId: string }>(SYS, "modules.create", {
      slug: `nav-menu-${PFX}-main`,
      displayName: "RIF Menu",
      html: "<nav>menu</nav>",
    });
    await run(SYS, "layout_modules.set", {
      layoutId,
      blockName: "header",
      moduleIds: [header.moduleId, menu.moduleId],
    });
    // Navigation set, canonicalised at write.
    await run(SYS, "structured_sets.set", {
      kind: "nav-menu",
      slug: `${PFX}-main`,
      displayName: "RIF Main menu",
      items: [{ label: "Gone", href: `/${PFX}-gone` }],
    });
    // Layout + template HTML are not write-canonicalised; a stored
    // reference there is what the link migration (rollout E) leaves.
    await admin(async (tx) => {
      await tx`UPDATE layouts SET html = replace(html, '<caelo-slot name="content">',
                 ${`<a href="caelo:page/${gone.pageId}">gone</a><caelo-slot name="content">`})
               WHERE id = ${layoutId}::uuid`;
      await tx`UPDATE templates SET html = ${`<main><a href="caelo:page/${gone.pageId}">x</a><caelo-slot name="content">_</caelo-slot></main>`}
               WHERE id = ${templateId}::uuid`;
    });

    // Main line is clean (the target exists) …
    const clean = await adapter.withAdminTransaction(SYS, (tx) =>
      checkReferences(tx, { branchId: null, env: "production" }),
    );
    expect(clean.filter((i) => i.severity === "block")).toEqual([]);

    // … and a chat that deletes the target sees every link break.
    const chat = await experiment("surfaces");
    await run(chat.ctx, "pages.delete", { pageId: gone.pageId });
    const issues = await adapter.withAdminTransaction(SYS, (tx) =>
      checkReferences(tx, { branchId: chat.ctx.chatBranchId ?? null, env: "staging" }),
    );
    // Shipped places only: preserved tables (sets, templates) keep rows of
    // earlier files whose pages are gone; those render nowhere (warnings).
    const missing = issues.filter((i) => i.problem === "missing-target" && i.shipped);
    for (const i of missing) expect(i.severity).toBe("block");
    const kinds = new Set(missing.map((i) => i.place.kind));
    for (const kind of [
      "content",
      "module-html",
      "module-default",
      "layout-html",
      "template-html",
      "structured-set",
    ]) {
      expect(kinds.has(kind)).toBe(true);
    }
    const byKind = (k: string) =>
      missing.find((i) => i.place.kind === k && !(i.place as { nested?: boolean }).nested);
    expect(byKind("content")?.fix.tool).toBe("set_page_module_content");
    expect(byKind("content")?.message).toContain(`"/${PFX}-linker"`);
    expect(byKind("content")?.message).toContain('field "cta_href"');
    expect(byKind("module-html")?.fix.tool).toBe("edit_content");
    expect(byKind("module-default")?.fix.tool).toBe("edit_module");
    expect(byKind("module-default")?.message).toContain('field "nav_links" of module "RIF Header"');
    expect(byKind("layout-html")?.fix.tool).toBe("propose_update_layout");
    expect(byKind("template-html")?.fix.tool).toBe("edit_content");
    expect(byKind("structured-set")?.fix.tool).toBe("set_structured_set");
    expect(byKind("structured-set")?.message).toContain(`nav-menu/${PFX}-main`);
    expect(
      missing.some(
        (i) =>
          i.place.kind === "content" &&
          (i.place as { nested: boolean }).nested &&
          i.fix.tool === "set_content_instance_values",
      ),
    ).toBe(true);

    // The main line is untouched: the deletion is the chat's draft only.
    const still = await adapter.withAdminTransaction(SYS, (tx) =>
      checkReferences(tx, { branchId: null, env: "staging" }),
    );
    expect(still.filter((i) => i.severity === "block")).toEqual([]);

    // Clean up the shared chrome so later tests start from a clean main.
    await run(SYS, "layout_modules.set", { layoutId, blockName: "header", moduleIds: [] });
    await run(SYS, "structured_sets.set", {
      kind: "nav-menu",
      slug: `${PFX}-main`,
      displayName: "RIF Main menu",
      items: [],
    });
    await admin(async (tx) => {
      await tx`UPDATE layouts SET html = replace(html, ${`<a href="caelo:page/${gone.pageId}">gone</a>`}, '')
               WHERE id = ${layoutId}::uuid`;
      await tx`UPDATE templates SET html = '<main><caelo-slot name="content">_</caelo-slot></main>'
               WHERE id = ${templateId}::uuid`;
    });
    await run(SYS, "pages.delete", { pageId: linker.pageId });
    await admin(async (tx) => {
      await tx`UPDATE pages SET deleted_at = now() WHERE slug = ${`${PFX}-nested`}`;
    });
  });
});

describe("reference integrity — Stage gate", () => {
  it("a missing target refuses the Stage merge, nothing reaches main; fixing the link lets it through", async () => {
    const target = await promoPage(SYS, `${PFX}-t2`, "published", "https://example.com/y");
    const linker = await promoPage(SYS, `${PFX}-l2`, "published", `/${PFX}-t2`);
    const chat = await experiment("stage-block");
    await run(chat.ctx, "pages.delete", { pageId: target.pageId });

    const refused = await execute(registry, adapter, SYS, "chat.merge_to_main", {
      chatSessionId: chat.chatSessionId,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    const message = "message" in refused.error ? String(refused.error.message) : "";
    expect(message).toStartWith("Stage refused");
    expect(message).toContain(`"/${PFX}-l2"`);
    expect(message).toContain("set_page_module_content");

    // Rolled back: the target page is still live on main.
    const live = await admin(
      async (tx) =>
        (await tx`SELECT deleted_at FROM pages WHERE id = ${target.pageId}::uuid`) as {
          deleted_at: Date | null;
        }[],
    );
    expect(live[0]?.deleted_at).toBeNull();

    // The chat removes the link; the same Stage now goes through.
    await run(chat.ctx, "content_instances.set_values", {
      id: linker.contentInstanceId,
      values: { cta_href: "https://example.com/elsewhere" },
    });
    const merged = await execute(registry, adapter, SYS, "chat.merge_to_main", {
      chatSessionId: chat.chatSessionId,
    });
    expect(merged.ok).toBe(true);
  });

  it("an unpublished target warns at Stage and blocks Publish live", async () => {
    const target = await promoPage(SYS, `${PFX}-t3`, "published", "https://example.com/z");
    const linker = await promoPage(SYS, `${PFX}-l3`, "published", `/${PFX}-t3`);
    const chat = await experiment("unpublished");
    await run(chat.ctx, "pages.set_status", { pageId: target.pageId, status: "draft" });
    // Status writes are live at once (dual-write); the chat also edits the
    // link so its Stage has something to merge.
    await run(chat.ctx, "content_instances.set_values", {
      id: linker.contentInstanceId,
      values: { cta_href: `/${PFX}-t3#offer` },
    });

    const merged = await execute(registry, adapter, SYS, "chat.merge_to_main", {
      chatSessionId: chat.chatSessionId,
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const warnings = (merged.value as { linkWarnings: string[] }).linkWarnings;
    expect(
      warnings.some((w) => w.startsWith("Link to an unpublished page") && w.includes(`/${PFX}-t3`)),
    ).toBe(true);

    // The read op: Stage policy warns, Publish policy blocks.
    const stage = await run<{ blocking: number; issues: { problem: string }[] }>(
      SYS,
      "links.check_references",
      { for: "stage", pagePath: `/${PFX}-l3` },
    );
    expect(stage.blocking).toBe(0);
    expect(stage.issues.map((i) => i.problem)).toContain("unpublished-target");
    const publish = await run<{
      blocking: number;
      issues: { problem: string; pageIds: string[] }[];
    }>(SYS, "links.check_references", {
      for: "publish",
      pagePath: `/${PFX}-l3`,
      includeWarnings: false,
    });
    expect(publish.blocking).toBe(1);
    expect(publish.issues[0]?.pageIds).toEqual([linker.pageId]);

    // The Publish-live quality check reports it as an error on the page.
    const check = createReferencesCheck(referenceSourcesFromOps(registry, adapter, SYS));
    if (check.scope !== "site") throw new Error("site check expected");
    const findings = await check.run({
      pages: [
        {
          pageId: linker.pageId,
          path: `/${PFX}-l3`,
          url: `http://staging.invalid/${PFX}-l3/`,
          html: "",
        },
      ],
      build: {
        baseUrl: "http://staging.invalid",
        probe: async () => ({ found: true, status: 200 }),
      },
    });
    const finding = findings.find(
      (f) => f.ruleId === "references/unpublished-target" && f.pageId === linker.pageId,
    );
    expect(finding?.severity).toBe("error");
    expect(finding?.fix?.tool).toBe("set_page_module_content");

    // Publishing the target clears it.
    await run(SYS, "pages.set_status", { pageId: target.pageId, status: "published" });
    const after = await run<{ blocking: number }>(SYS, "links.check_references", {
      for: "publish",
      pagePath: `/${PFX}-l3`,
    });
    expect(after.blocking).toBe(0);
  });
});

describe("check_links tool", () => {
  it("lists blocking problems of the chat's draft with page, place and tool", async () => {
    const target = await promoPage(SYS, `${PFX}-t4`, "published", "https://example.com/w");
    await promoPage(SYS, `${PFX}-l4`, "published", `/${PFX}-t4`);
    const chat = await experiment("tool");
    await run(chat.ctx, "pages.delete", { pageId: target.pageId });

    const tool = createDefaultToolRegistry().get("check_links");
    if (!tool) throw new Error("check_links not registered");
    const aiCtx: ExecutionContext = { ...chat.ctx, actorKind: "ai" };
    const r = await tool.handler(aiCtx, { pagePath: `/${PFX}-l4`, blockingOnly: true }, {
      registry,
      adapter,
    } as never);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("1 blocking");
    expect(r.content).toContain("Link to a deleted target");
    expect(r.content).toContain(`"/${PFX}-l4"`);
    expect(r.content).toContain("set_page_module_content");

    const clean = await tool.handler(SYS, { pagePath: `/${PFX}-l4` }, {
      registry,
      adapter,
    } as never);
    expect(clean.content).toBe("No internal-link problems for Publish live.");
  });
});

describe("reference integrity — active site import (rollout E)", () => {
  it("a link to a page the running import planned never blocks Stage and names the import; afterwards the normal rules apply", async () => {
    const session = await run<{ chatSessionId: string; chatBranchId: string }>(
      SYS,
      "chat.create_session",
      { title: `${PFX}-import` },
    );
    const ai: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "rif-import",
      chatBranchId: session.chatBranchId,
    };
    const source = "https://old.example.org";
    const runId = await admin(async (tx) => {
      const rows = (await tx`
        INSERT INTO import_runs (source_url, proposed_by, status, chat_session_id)
        VALUES (${source}, ${SYS.actorId}::uuid, 'ready_for_review', ${session.chatSessionId}::uuid)
        RETURNING id::text AS id`) as { id: string }[];
      const id = rows[0]?.id as string;
      await tx`INSERT INTO import_pages (run_id, source_url, proposed_slug, proposed_title)
               VALUES (${id}::uuid, ${`${source}/${PFX}-later`}, ${`${PFX}-later`}, 'Later')`;
      return id;
    });
    // The rebuild links a page the import has not built yet: kept literal.
    await promoPage(ai, `${PFX}-imported-home`, "published", `/${PFX}-later`);

    const draft = await execute(registry, adapter, ai, "links.check_references", {
      for: "publish",
      pagePath: `/${PFX}-imported-home`,
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const v = draft.value as {
      blocking: number;
      issues: { problem: string; severity: string; message: string }[];
    };
    expect(v.blocking).toBe(0);
    expect(v.issues).toEqual([
      expect.objectContaining({ problem: "pending-import-link", severity: "warning" }),
    ]);
    expect(v.issues[0]?.message).toContain("resolve_import_links");

    const staged = await execute(registry, adapter, SYS, "chat.merge_draft_to_main", {
      chatSessionIds: [session.chatSessionId],
    });
    expect(staged.ok).toBe(true);

    // The run is over: a link still matching no page is a broken legacy link
    // (the migration report's territory), still not a Stage block.
    await admin(async (tx) => {
      await tx`UPDATE import_runs SET status = 'completed' WHERE id = ${runId}::uuid`;
    });
    const after = await run<{ blocking: number; issues: { problem: string; message: string }[] }>(
      SYS,
      "links.check_references",
      { for: "stage", pagePath: `/${PFX}-imported-home` },
    );
    expect(after.blocking).toBe(0);
    expect(after.issues.map((i) => i.problem)).toEqual(["broken-literal"]);
    expect(after.issues[0]?.message).toContain("get_link_migration_report");
  });
});
