// SPDX-License-Identifier: MPL-2.0

/**
 * Stage readiness (e2e-livedit detected bugs: ~100 refused `stage_changes`
 * in 14 runs — "0 published pages", "no page serves the site root '/'",
 * "N page(s) would go live without a meta description"). The AI met the
 * staging build's preconditions only after a refused Stage, because
 * nothing told it about site state it had not created itself (a homepage
 * left as a draft, an older page published without a description).
 * Pinned here, against a real Postgres:
 *
 *   - `deploy.stage_readiness` reports exactly the refusals of the build:
 *     the draft homepage, and the pages without a description — the draft
 *     homepage included, since publishing it is the named fix;
 *   - the page tools carry the note in their result, naming the fixes,
 *     and stop once the site is ready;
 *   - applying the named fixes makes the build's own SEO gate pass (the
 *     note and the gate agree);
 *   - build_page writes a new page's description in the same call
 *     (fill-once), and refuses it for an existing page;
 *   - autofill repeated with the same text is a no-op, a different text is
 *     refused with the stored description and the tool that changes it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { describeStageReadiness, type StageReadiness } from "../deploy/stage-readiness.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "stage-readiness",
};

const PFX = "stage-ready";
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId: string;

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home')`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home')`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home'`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
    // Readiness is site-wide: other suites' leftovers must not decide it.
    await tx`UPDATE pages SET deleted_at = now() WHERE deleted_at IS NULL`;
  });
}

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

const readiness = () => op<StageReadiness>("deploy.stage_readiness", {});

async function createPage(slug: string, title: string, status: "draft" | "published") {
  const r = await op<{ pageId: string }>("pages.create", { slug, title, templateId, status });
  return r.pageId;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  const t = await op<{ templateId: string }>("templates.create", {
    slug: `${PFX}-tpl`,
    displayName: "Stage readiness",
    html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  templateId = t.templateId;
  await op("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("stage readiness — the consent scenario's site", () => {
  let home: string;
  let kontakt: string;

  it("an empty site: not ready, and the note says not to Stage yet", async () => {
    const r = await readiness();
    expect(r.ready).toBe(false);
    expect(r.nothingPublished).toBe(true);
    expect(describeStageReadiness(r)).toContain(
      "Do not call stage_changes until the homepage exists",
    );
  });

  it("names the draft homepage and every page without a description", async () => {
    // The seeded "onboarded" site: homepage still a draft, a second page
    // published long before descriptions were required.
    home = await createPage("home", "Home", "draft");
    kontakt = await createPage(`${PFX}-kontakt`, "Kontakt", "published");
    const r = await readiness();
    expect(r.ready).toBe(false);
    expect(r.rootMissing).toBe(true);
    expect(r.nothingPublished).toBe(false);
    expect(r.draftRootPage?.id).toBe(home);
    expect(r.missingMetaDescription.pages.map((p) => p.id).sort()).toEqual([home, kontakt].sort());
    const note = describeStageReadiness(r) ?? "";
    expect(note).toContain(`pageId ${home}`);
    expect(note).toContain("set_pages_status_many");
    expect(note).toContain("autofill_page_seo_many");
  });

  it("the page tools carry the note until the site is ready", async () => {
    const tools = createDefaultToolRegistry();
    const published = await tools.dispatch(
      "set_pages_status_many",
      { pageIds: [home], status: "published" },
      SYS,
      { registry, adapter },
    );
    expect(published.ok).toBe(true);
    // Root now served; the descriptions are still missing — say so.
    expect(published.content).toContain("A Stage would be refused right now");
    expect(published.content).toContain(`pageId ${kontakt}`);

    const filled = await tools.dispatch(
      "autofill_page_seo_many",
      {
        items: [
          { pageId: home, metaDescription: "Handmade oak furniture from our own workshop." },
          { pageId: kontakt, metaDescription: "How to reach the workshop by phone and email." },
        ],
      },
      SYS,
      { registry, adapter },
    );
    expect(filled.ok).toBe(true);
    expect(filled.content).not.toContain("A Stage would be refused");
    expect((await readiness()).ready).toBe(true);
  });

  it("agrees with the build: the SEO gate lets the staging build through", async () => {
    const r = await execute(registry, adapter, SYS, "deploy.trigger", { targetName: "staging" });
    const message = r.ok ? "" : ((r.error as { message?: string }).message ?? r.error.kind);
    expect(message).not.toContain("meta description");
  });

  it("set_home_page on a page without a description says it is still missing", async () => {
    const landing = await createPage(`${PFX}-landing`, "Landing", "published");
    const tools = createDefaultToolRegistry();
    const r = await tools.dispatch("set_home_page", { pageId: landing }, SYS, {
      registry,
      adapter,
    });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("A Stage would be refused right now");
    expect(r.content).toContain(`'Landing' (/, pageId ${landing})`);
    await op("pages_seo.autofill", { pageId: landing, metaDescription: "The landing page." });
  });
});

describe("build_page writes the new page's meta description (fill-once)", () => {
  it("create mode: written in the same transaction, stamped as the first fill", async () => {
    const r = await op<{ pageId: string; metaDescription: string | null }>("pages.build_page", {
      page: {
        slug: `${PFX}-pricing`,
        title: "Pricing",
        templateId,
        status: "published",
        metaDescription: "Plans and prices for every team size.",
      },
      modules: [],
    });
    expect(r.metaDescription).toBe("written");
    const seo = await op<{ seo: { metaDescription: string; autofilledAt: string | null } }>(
      "pages_seo.get",
      { pageId: r.pageId },
    );
    expect(seo.seo.metaDescription).toBe("Plans and prices for every team size.");
    expect(seo.seo.autofilledAt).not.toBeNull();
    expect((await readiness()).ready).toBe(true);
  });

  it("pageId: fills an existing page's first description, keeps one it already has", async () => {
    const pageId = await createPage(`${PFX}-existing`, "Existing", "draft");
    const first = await op<{ metaDescription: string | null }>("pages.build_page", {
      page: { pageId, metaDescription: "Our workshop, our tools, our people." },
      modules: [],
    });
    expect(first.metaDescription).toBe("written");
    const again = await op<{ metaDescription: string | null }>("pages.build_page", {
      page: { pageId, metaDescription: "Something else entirely." },
      modules: [],
    });
    expect(again.metaDescription).toBe("kept-existing");
    const seo = await op<{ seo: { metaDescription: string } }>("pages_seo.get", { pageId });
    expect(seo.seo.metaDescription).toBe("Our workshop, our tools, our people.");
  });
});

describe("autofill_page_seo fill-once", () => {
  let pageId: string;

  beforeAll(async () => {
    pageId = await createPage(`${PFX}-about`, "About", "draft");
    await op("pages_seo.autofill", { pageId, metaDescription: "Who we are." });
  });

  it("the same text again is a no-op, not a refusal", async () => {
    const tools = createDefaultToolRegistry();
    const r = await tools.dispatch(
      "autofill_page_seo",
      { pageId, metaDescription: "Who we are." },
      SYS,
      { registry, adapter },
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("nothing changed");
  });

  it("a different text is refused with the stored description and the tool that changes it", async () => {
    const r = await execute(registry, adapter, SYS, "pages_seo.autofill", {
      pageId,
      metaDescription: "Something else entirely.",
    });
    expect(r.ok).toBe(false);
    const message = r.ok ? "" : ((r.error as { message?: string }).message ?? "");
    expect(message).toContain("AlreadyAutofilled");
    expect(message).toContain('"Who we are."');
    expect(message).toContain("optimize_page_seo");
    const seo = await op<{ seo: { metaDescription: string } }>("pages_seo.get", { pageId });
    expect(seo.seo.metaDescription).toBe("Who we are.");
  });
});
