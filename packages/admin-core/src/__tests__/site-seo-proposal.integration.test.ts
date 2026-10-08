// SPDX-License-Identifier: MPL-2.0
/**
 * The agent's path to the site SEO settings (CLAUDE.md §11.A).
 *
 * #551 made the static generator refuse to build without a site base URL,
 * but the only write path was the Owner's Security → SEO form: the agent
 * saw the blocker and could not clear it. `propose_set_site_seo` routes
 * the AI through `site_defaults.propose_set_seo` → the Owner's
 * `site_defaults.execute_proposal`. This file locks:
 *   - the in-chat gated path (attachGatedExecute: propose as AI, apply as
 *     the approving Owner) sets the base URL, and the next build passes;
 *   - the Power-MCP path (no in-chat card) leaves a pending row that the
 *     Owner approves later, and names where;
 *   - the AI cannot approve itself, and URL validation runs at propose time;
 *   - omitted fields keep the values stored at approve time.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBuildPluginServices } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { generateSite, pageOutputPath } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import type { FilteredTool } from "../ai/chat-runner/tool-catalogue.js";
import { attachGatedExecute } from "../ai/tools/gated-tools.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { registerAdminOps } from "../register.js";
import { ensureRoleUser } from "./fixtures/role-user.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "site-seo-proposal",
};
const OWNER: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000005e0001",
  actorKind: "human",
  requestId: "site-seo-proposal-owner",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "site-seo-proposal-ai",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let restoreBase: () => Promise<void>;
let restoreLanguage: () => Promise<void>;
let seoBefore: { sitemapEnabled: boolean; organizationJson: Record<string, unknown> };
let repoRoot = "";
let pagePath = "";
let pageId = "";
let previousActiveTheme: string | null = null;
const PREFIX = "sseoprop";
const THEME_SLUG = `${PREFIX}-theme`;

async function run(name: string, input: unknown): Promise<unknown> {
  const r = await execute(registry, adapter, SYSTEM, name, input);
  if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

async function cleanupFixtures(): Promise<void> {
  await asSystem(async (tx) => {
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PREFIX}-%'`);
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PREFIX}-%'`);
    await tx.unsafe(
      `DELETE FROM theme_snapshots WHERE theme_id IN (SELECT id FROM themes WHERE slug = '${THEME_SLUG}')`,
    );
    await tx.unsafe(`DELETE FROM themes WHERE slug = '${THEME_SLUG}' AND is_active = false`);
  });
}

/**
 * One published page on an active theme with a system font stack, so a
 * build needs no network (the seeded theme's web font would be fetched).
 */
async function seedPublishedPage(): Promise<void> {
  await run("themes.duplicate", {
    sourceSlug: "site-default",
    newSlug: THEME_SLUG,
    newDisplayName: "Site SEO proposal test",
  });
  await run("themes.update_tokens", { themeSlug: THEME_SLUG, set: { fontBody: "serif" } });
  const active = (await asSystem(
    (tx) => tx`SELECT slug FROM themes WHERE is_active = true LIMIT 1`,
  )) as { slug: string }[];
  previousActiveTheme = active[0]?.slug ?? null;
  await asSystem(async (tx) => {
    await tx`UPDATE themes SET is_active = false WHERE is_active = true`;
    await tx`UPDATE themes SET is_active = true WHERE slug = ${THEME_SLUG}`;
  });
  const tpl = (await run("templates.create", {
    slug: `${PREFIX}-tpl`,
    displayName: "Site SEO proposal",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  })) as { templateId: string };
  await run("template_blocks.set", {
    templateId: tpl.templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const page = (await run("pages.create", {
    slug: `${PREFIX}-page`,
    title: "Site SEO proposal",
    templateId: tpl.templateId,
  })) as { pageId: string };
  pageId = page.pageId;
  await run("pages.set_status", { pageId, status: "published" });
  const rows = (await asSystem(
    (tx) => tx`SELECT current_path FROM pages WHERE id = ${page.pageId}::uuid`,
  )) as { current_path: string }[];
  pagePath = rows[0]?.current_path ?? "";
}

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
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

async function readSeo(): Promise<{
  siteBaseUrl: string | null;
  sitemapEnabled: boolean;
  organizationJson: Record<string, unknown>;
}> {
  const r = await execute(registry, adapter, SYSTEM, "site_defaults.get_seo", {});
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value as Awaited<ReturnType<typeof readSeo>>;
}

function build(runId: string) {
  return adapter.withAdminTransaction(SYSTEM, (tx) =>
    generateSite({
      tx,
      adapter,
      plugins: localBuildPluginServices,
      runId,
      repoRoot,
      // Incremental: the fixture site has no homepage, which a full build
      // (rightly) refuses; the SEO settings gate runs either way.
      changedPageIds: [pageId],
      target: {
        id: crypto.randomUUID(),
        name: "production",
        env: "production",
        outDir: "out",
        baseUrl: "https://ignored-target.example",
        robotsDefault: "index",
      },
    }),
  );
}

function gatedTool(): FilteredTool {
  const tool = createDefaultToolRegistry()
    .catalogue()
    .find((t) => t.name === "propose_set_site_seo");
  if (!tool) throw new Error("propose_set_site_seo is not registered");
  return attachGatedExecute(tool as FilteredTool, registry, adapter, AI, OWNER);
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  // #589 — the approver must be a real user holding roles.manage.
  await ensureRoleUser(ADMIN_URL, OWNER.actorId, "owner");
  await asSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name)
             VALUES (${OWNER.actorId}::uuid, 'human', 'site-seo-proposal-owner')
             ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO actors (id, kind, display_name)
             VALUES (${AI.actorId}::uuid, 'ai', 'Caelo AI') ON CONFLICT DO NOTHING`;
  });
  restoreBase = await pinSiteBaseUrl(ADMIN_URL!, null);
  restoreLanguage = await pinSiteLanguage(ADMIN_URL!, "en");
  const s = await readSeo();
  seoBefore = { sitemapEnabled: s.sitemapEnabled, organizationJson: s.organizationJson };
  repoRoot = mkdtempSync(join(tmpdir(), "caelo-site-seo-proposal-"));
  await cleanupFixtures();
  await seedPublishedPage();
});

beforeEach(async () => {
  await asSystem((tx) => tx`DELETE FROM site_defaults_pending_actions`);
});

afterAll(async () => {
  await asSystem(async (tx) => {
    await tx`DELETE FROM site_defaults_pending_actions`;
    await tx`UPDATE site_defaults
             SET sitemap_enabled = ${seoBefore.sitemapEnabled},
                 organization_json = ${JSON.stringify(seoBefore.organizationJson)}::text::jsonb
             WHERE id = 1`;
  });
  if (previousActiveTheme !== null) {
    const slug = previousActiveTheme;
    await asSystem(async (tx) => {
      await tx`UPDATE themes SET is_active = false WHERE is_active = true`;
      await tx`UPDATE themes SET is_active = true WHERE slug = ${slug}`;
    });
  }
  await cleanupFixtures();
  await restoreBase();
  await restoreLanguage();
  rmSync(repoRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("unset site URL — what the agent is told", () => {
  it("inspect_page_render names the tool for the preview's site-base-url-unset flag", async () => {
    await asSystem((tx) => tx`UPDATE site_defaults SET site_base_url = NULL WHERE id = 1`);
    const tools = createDefaultToolRegistry();
    const r = await tools.dispatch("inspect_page_render", { pageId }, AI, {
      adapter,
      registry,
    });
    expect(r.ok).toBe(true);
    const slots = (
      JSON.parse(r.content) as {
        slots: { missing: string[]; nextSteps?: Record<string, string> };
      }
    ).slots;
    expect(slots.missing).toContain("site-base-url-unset");
    expect(slots.nextSteps?.["site-base-url-unset"]).toContain("propose_set_site_seo");
    // The language is set in this file, so no step is offered for it.
    expect(slots.nextSteps?.["site-language-unset"]).toBeUndefined();
  });
});

describe("propose_set_site_seo — in-chat approval path", () => {
  it("an approved proposal sets the base URL and the next build no longer fails", async () => {
    await asSystem((tx) => tx`UPDATE site_defaults SET site_base_url = NULL WHERE id = 1`);
    await expect(build(crypto.randomUUID())).rejects.toThrow("propose_set_site_seo");

    const execute = gatedTool().execute as (input: unknown) => Promise<unknown>;
    const r = (await execute({ siteBaseUrl: "https://www.seo-proposal.example/" })) as {
      ok: boolean;
      value?: { siteBaseUrl: string };
      error?: string;
    };
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    // Normalised to the bare origin before it is stored.
    expect(r.value?.siteBaseUrl).toBe("https://www.seo-proposal.example");
    expect((await readSeo()).siteBaseUrl).toBe("https://www.seo-proposal.example");

    const applied = await asSystem(
      (tx) => tx`SELECT status, decided_by::text AS decided_by FROM site_defaults_pending_actions`,
    );
    expect(applied).toEqual([{ status: "applied", decided_by: OWNER.actorId }]);

    const result = await build(crypto.randomUUID());
    const html = await readFile(join(result.buildDir, pageOutputPath(pagePath)), "utf8");
    expect(html).toContain(
      `<link rel="canonical" href="https://www.seo-proposal.example${pagePath}/" />`,
    );
  });

  it("omitted fields keep the values stored at approve time", async () => {
    await asSystem(
      (tx) =>
        tx`UPDATE site_defaults SET site_base_url = 'https://keep.example', sitemap_enabled = true WHERE id = 1`,
    );
    const proposed = await execute(registry, adapter, AI, "site_defaults.propose_set_seo", {
      organizationJson: { name: "Acme", sameAs: ["https://social.example/acme"] },
    });
    expect(proposed.ok).toBe(true);
    const { proposalId, preview } = (
      proposed as { ok: true; value: { proposalId: string; preview: { changes: object } } }
    ).value;
    expect(Object.keys(preview.changes)).toEqual(["organizationJson"]);
    // The Owner flips the sitemap while the proposal waits.
    await asSystem((tx) => tx`UPDATE site_defaults SET sitemap_enabled = false WHERE id = 1`);
    const applied = await execute(registry, adapter, OWNER, "site_defaults.execute_proposal", {
      proposalId,
    });
    expect(applied.ok).toBe(true);
    expect(await readSeo()).toEqual({
      siteBaseUrl: "https://keep.example",
      sitemapEnabled: false,
      organizationJson: { name: "Acme", sameAs: ["https://social.example/acme"] },
    });
  });
});

describe("propose_set_site_seo — Power-MCP path (no in-chat card)", () => {
  it("queues a pending row the Owner approves later and names where", async () => {
    await asSystem((tx) => tx`UPDATE site_defaults SET site_base_url = NULL WHERE id = 1`);
    const tools = createDefaultToolRegistry();
    const r = await tools.dispatch(
      "propose_set_site_seo",
      { siteBaseUrl: "https://mcp.example" },
      AI,
      { adapter, registry, tools, humanCtx: OWNER } as Parameters<typeof tools.dispatch>[3],
    );
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/^Queued proposal [0-9a-f-]{36}:/);
    expect(r.content).toContain("/security/seo");
    expect((await readSeo()).siteBaseUrl).toBeNull();

    const listed = await execute(registry, adapter, OWNER, "pending_proposals.list", {});
    expect(listed.ok).toBe(true);
    const items = (listed as { ok: true; value: { items: { domain: string; summary: string }[] } })
      .value.items;
    expect(items).toContainEqual(
      expect.objectContaining({ domain: "site_defaults", summary: "site SEO: siteBaseUrl" }),
    );

    const proposalId = /Queued proposal ([0-9a-f-]{36})/.exec(r.content)?.[1] ?? "";
    const applied = await execute(registry, adapter, OWNER, "site_defaults.execute_proposal", {
      proposalId,
    });
    expect(applied.ok).toBe(true);
    expect((await readSeo()).siteBaseUrl).toBe("https://mcp.example");
  });

  it("the AI can cancel its own pending proposal", async () => {
    const proposed = await execute(registry, adapter, AI, "site_defaults.propose_set_seo", {
      siteBaseUrl: "https://cancel-me.example",
    });
    expect(proposed.ok).toBe(true);
    const { proposalId } = (proposed as { ok: true; value: { proposalId: string } }).value;
    const c = await execute(registry, adapter, AI, "pending_proposals.cancel", { proposalId });
    expect(c.ok).toBe(true);
    expect((c as { ok: true; value: { domain: string } }).value.domain).toBe("site_defaults");
  });
});

describe("site_defaults SEO proposal guards", () => {
  // Field-only proposals need a stored base URL (see the unset-base test).
  beforeEach(async () => {
    await asSystem(
      (tx) => tx`UPDATE site_defaults SET site_base_url = 'https://guards.example' WHERE id = 1`,
    );
  });

  it("refuses a sitemap- or organization-only proposal while no base URL is stored", async () => {
    await asSystem((tx) => tx`UPDATE site_defaults SET site_base_url = NULL WHERE id = 1`);
    for (const input of [
      { sitemapEnabled: !(await readSeo()).sitemapEnabled },
      { organizationJson: { name: "Unset Base Co" } },
    ]) {
      const r = await execute(registry, adapter, AI, "site_defaults.propose_set_seo", input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(JSON.stringify(r.error)).toContain("siteBaseUrl");
    }
    const rows = await asSystem((tx) => tx`SELECT id FROM site_defaults_pending_actions`);
    expect(rows).toEqual([]);
  });

  it("rejecting a proposal that is not pending fails instead of reporting success", async () => {
    const missing = await execute(registry, adapter, OWNER, "site_defaults.reject_proposal", {
      proposalId: crypto.randomUUID(),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(JSON.stringify(missing.error)).toContain("no longer pending");

    const proposed = await execute(registry, adapter, AI, "site_defaults.propose_set_seo", {
      siteBaseUrl: "https://twice-rejected.example",
    });
    const { proposalId } = (proposed as { ok: true; value: { proposalId: string } }).value;
    const first = await execute(registry, adapter, OWNER, "site_defaults.reject_proposal", {
      proposalId,
    });
    expect(first.ok).toBe(true);
    const second = await execute(registry, adapter, OWNER, "site_defaults.reject_proposal", {
      proposalId,
    });
    expect(second.ok).toBe(false);
  });

  it("the AI cannot approve its own proposal", async () => {
    const proposed = await execute(registry, adapter, AI, "site_defaults.propose_set_seo", {
      sitemapEnabled: !(await readSeo()).sitemapEnabled,
    });
    expect(proposed.ok).toBe(true);
    const { proposalId } = (proposed as { ok: true; value: { proposalId: string } }).value;
    const r = await execute(registry, adapter, AI, "site_defaults.execute_proposal", {
      proposalId,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("ActorScopeRejected");
  });

  it("rejects an invalid base URL at propose time with the corrected origin", async () => {
    const r = await execute(registry, adapter, AI, "site_defaults.propose_set_seo", {
      siteBaseUrl: "https://www.example.com/de/start",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain("use https://www.example.com");
  });

  it("rejects a localhost base URL on a cloud install", async () => {
    const before = process.env.CAELO_PROVIDER;
    process.env.CAELO_PROVIDER = "gcp";
    try {
      const r = await execute(registry, adapter, AI, "site_defaults.propose_set_seo", {
        siteBaseUrl: "http://localhost:8082",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(JSON.stringify(r.error)).toContain("public domain");
    } finally {
      if (before === undefined) delete process.env.CAELO_PROVIDER;
      else process.env.CAELO_PROVIDER = before;
    }
  });

  it("refuses a no-op and a duplicate pending proposal", async () => {
    const current = await readSeo();
    const noop = await execute(registry, adapter, AI, "site_defaults.propose_set_seo", {
      sitemapEnabled: current.sitemapEnabled,
    });
    expect(noop.ok).toBe(false);
    if (!noop.ok) expect(JSON.stringify(noop.error)).toContain("nothing to change");

    const input = { siteBaseUrl: "https://dup.example" };
    expect((await execute(registry, adapter, AI, "site_defaults.propose_set_seo", input)).ok).toBe(
      true,
    );
    const dup = await execute(registry, adapter, AI, "site_defaults.propose_set_seo", input);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(JSON.stringify(dup.error)).toContain("already pending");
  });

  it("a rejected proposal cannot be applied", async () => {
    const proposed = await execute(registry, adapter, AI, "site_defaults.propose_set_seo", {
      siteBaseUrl: "https://rejected.example",
    });
    const { proposalId } = (proposed as { ok: true; value: { proposalId: string } }).value;
    expect(
      (
        await execute(registry, adapter, OWNER, "site_defaults.reject_proposal", {
          proposalId,
          reason: "wrong domain",
        })
      ).ok,
    ).toBe(true);
    const r = await execute(registry, adapter, OWNER, "site_defaults.execute_proposal", {
      proposalId,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain("already rejected");
  });
});
