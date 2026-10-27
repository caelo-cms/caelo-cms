// SPDX-License-Identifier: MPL-2.0

/**
 * The international-site plugin's Stage-audit contribution end to end:
 * the real plugin in the sandbox, its language groups in Postgres, and
 * the page facts core extracts from rendered HTML (quality/checks/
 * page-facts.ts) — through the same plugin check the audit worker runs.
 *
 * The case is the one an operator hit: a footer that links "Deutsch" to a
 * fixed `/de/` shows a dead language link on every page without a German
 * version. The audit names it once, at the footer module, with the
 * language_links fix.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  auditFindingContributors,
  bootstrap,
  collectPluginAuditFindings,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { StagedPage } from "../quality/checks/check.js";
import { withPluginAuditChecks } from "../quality/checks/plugin-findings.js";
import { CheckRegistry } from "../quality/checks/registry.js";
import { runFindingChecks } from "../quality/checks/runner.js";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoDefaultPageType } from "./_template-page-type.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "tqa" };
const PFX = "tintlqa";
const FOOTER = "33333333-3333-4333-8333-333333333333";
const BASE = "https://example.com";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
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
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`DELETE FROM layouts WHERE slug LIKE '${PFX}-%'`);
  });
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

async function createPage(templateId: string, slug: string, title: string): Promise<string> {
  const r = await execute(registry, adapter, SYS, "pages.create", { slug, title, templateId });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { pageId: string }).pageId;
}

async function pathOf(pageId: string): Promise<string> {
  const rows = await sqlSystem(
    async (tx) =>
      (await tx.unsafe(`SELECT current_path FROM pages WHERE id = '${pageId}'`)) as {
        current_path: string;
      }[],
  );
  const path = rows[0]?.current_path;
  if (!path) throw new Error(`page ${pageId} has no path`);
  return path;
}

/** The rendered page as staging would serve it: head signals + the footer. */
function rendered(
  pageId: string,
  path: string,
  lang: string,
  alternates: readonly [string, string][],
): StagedPage {
  const head = alternates
    .map(([h, p]) => `<link rel="alternate" hreflang="${h}" href="${BASE}${p}">`)
    .join("");
  return {
    pageId,
    path,
    url: `http://s.test${path}/`,
    html: `<html lang="${lang}"><head><title>${path}</title><link rel="canonical" href="${BASE}${path}">${head}</head>
<body><main><p>${path}</p></main>
<footer data-caelo-module-id="${FOOTER}"><a href="/de/">Deutsch</a></footer></body></html>`,
  };
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("international-site Stage audit", () => {
  it("names the fixed footer language link once, at the module, with the language_links fix", async () => {
    await op("set_locales", {
      locales: [
        { code: "en", displayName: "English", urlStrategy: "subdirectory", isDefault: true },
        { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
      ],
    });
    const templateId = await sqlSystem(async (tx) => {
      const lay = (await tx.unsafe(
        `INSERT INTO layouts (slug, display_name, html, css) VALUES ('${PFX}-lay', 'L', '<html></html>', '') RETURNING id::text AS id`,
      )) as { id: string }[];
      const tpl = (await tx.unsafe(
        `INSERT INTO templates (slug, display_name, html, css, layout_id) VALUES ('${PFX}-tpl', 'T', '<main></main>', '', '${lay[0]?.id}') RETURNING id::text AS id`,
      )) as { id: string }[];
      await adoptTemplateIntoDefaultPageType(tx, tpl[0]?.id ?? "");
      return tpl[0]?.id as string;
    });
    const pricing = await createPage(templateId, `${PFX}-pricing`, "Pricing");
    const team = await createPage(templateId, `${PFX}-team`, "Team");
    const preise = (
      await op<{ pageId: string }>("create_variant", {
        sourcePageId: pricing,
        localeCode: "de",
        slug: `${PFX}-preise`,
      })
    ).pageId;
    const paths = {
      pricing: await pathOf(pricing),
      team: await pathOf(team),
      preise: await pathOf(preise),
    };
    const group: [string, string][] = [
      ["en", paths.pricing],
      ["de", paths.preise],
      ["x-default", paths.pricing],
    ];
    const staged = [
      rendered(pricing, paths.pricing, "en", group),
      rendered(preise, paths.preise, "de", group),
      rendered(team, paths.team, "en", []),
    ];

    expect(auditFindingContributors()).toContain("international-site");
    const checks = withPluginAuditChecks(new CheckRegistry(), {
      contributors: () => ["international-site"],
      findings: collectPluginAuditFindings,
      siteUrls: async () => [BASE],
    });
    const out = await runFindingChecks(checks.findingChecks(), staged, {
      baseUrl: "http://s.test",
      probe: async () => ({ found: true, status: 200 }),
      text: async () => null,
    });
    expect(out.errors).toEqual([]);
    const hardcoded = out.findings.filter(
      (f) => f.ruleId === "plugin.international-site/hardcoded-language-link",
    );
    expect(hardcoded).toHaveLength(1);
    expect(hardcoded[0]?.severity).toBe("error");
    expect(hardcoded[0]?.pageId).toBeUndefined();
    expect(hardcoded[0]?.message).toContain(`module ${FOOTER}`);
    expect(hardcoded[0]?.fix?.hint).toContain("{{#language_links}}");
    // The language group itself is sound.
    expect(out.findings.some((f) => f.ruleId.endsWith("/variant-group-broken"))).toBe(false);
    expect(out.findings.some((f) => f.ruleId.endsWith("/coverage"))).toBe(true);
  }, 60_000);
});
