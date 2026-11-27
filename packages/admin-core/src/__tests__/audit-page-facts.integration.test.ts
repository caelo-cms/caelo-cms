// SPDX-License-Identifier: MPL-2.0

/**
 * #1755 — a plugin check receives the headings, images, JSON-LD and Open
 * Graph / Twitter tags of every staged page it asks for, through its
 * `auditFindingsOperation`: the plugin host's real dispatch, each call
 * parsed as the admin parses the audit job's `plugin-findings` report
 * (after a JSON round trip, like the transport), and the facts core
 * extracts from the rendered HTML (quality/checks/page-facts.ts).
 *
 * The test plugin applies objective rules the `seo` plugin will (epic
 * #1751): exactly one H1, alt text unless decorative, JSON-LD that parses,
 * a share image. A malformed JSON-LD block reaches it as a fact and comes
 * back as its finding; the audit does not fail on it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { bootstrap, resetPluginHost } from "@caelo-cms/plugin-host";
import {
  definePlugin,
  type PluginAuditFinding,
  type PluginAuditFindingsArgs,
  type PluginAuditPageFacts,
} from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import type { StagedPage } from "../quality/checks/check.js";
import { collectPluginFindings, withPluginAuditChecks } from "../quality/checks/plugin-findings.js";
import { CheckRegistry } from "../quality/checks/registry.js";
import { runFindingChecks } from "../quality/checks/runner.js";
import { registerAdminOps } from "../register.js";
import { type RunningAudit, startRunningAudit } from "./fixtures/running-audit.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "t1755-facts";
const BASE = "https://example.com";
const HERO = "11111111-1111-4111-8111-111111111755";
const FAQ = "22222222-2222-4222-8222-222222221755";
const HOME = "00000000-0000-4000-8000-000000001755";
const ABOUT = "00000000-0000-4000-8000-000000011755";
const HASH = "0123456789abcdef";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let run: RunningAudit | null = null;

/** Every batch call's facts, as the plugin received them. */
const received: PluginAuditPageFacts[] = [];

function page(pageId: string, path: string, html: string): StagedPage {
  return { pageId, path, url: `http://s.test${path === "/" ? "" : path}/`, html };
}

const STAGED = [
  page(
    HOME,
    "/",
    `<!doctype html><html lang="de"><head>
      <title>Start</title>
      <meta property="og:title" content="Start">
      <meta property="og:image" content="${BASE}/_assets/share.${HASH}.jpg">
      <meta name="twitter:card" content="summary_large_image">
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Caelo"}</script>
    </head><body>
      <section data-caelo-module-id="${HERO}">
        <h1>Willkommen</h1>
        <img src="/_assets/team-photo/webp-800.${HASH}.webp" alt="Das Team" width="800" height="533">
        <img src="/_assets/divider.${HASH}.png" alt="">
      </section>
      <h2>Angebot</h2>
    </body></html>`,
  ),
  page(
    ABOUT,
    "/about",
    `<!doctype html><html lang="de"><head><title>Über uns</title></head><body>
      <h1>Über uns</h1>
      <div data-caelo-module-id="${FAQ}">
        <h1>Fragen</h1>
        <img src="/_assets/office.${HASH}.jpg">
        <script type="application/ld+json">{"@type": "FAQPage", "mainEntity": [],}</script>
      </div>
    </body></html>`,
  ),
];

/** Objective rules on the facts, the way a plugin check reads them. */
function rulesOn(f: PluginAuditPageFacts): PluginAuditFinding[] {
  const out: PluginAuditFinding[] = [];
  const h1 = f.headings.filter((h) => h.level === 1);
  if (h1.length !== 1 && !f.truncatedFacts.includes("headings")) {
    out.push({
      rule: "h1-count",
      severity: "error",
      pageId: f.pageId,
      message: `H1 count: the page has ${h1.length} H1 headings (${h1.map((h) => `"${h.text}"`).join(", ")}); keep exactly one.`,
    });
  }
  for (const img of f.images) {
    if (img.alt === null && !img.decorative) {
      out.push({
        rule: "image-alt-missing",
        severity: "error",
        pageId: f.pageId,
        message: `Alt text missing: image ${img.media?.ref ?? img.src?.href} in module ${img.moduleId} has no alt.`,
      });
    }
  }
  for (const block of f.jsonLd) {
    if (block.kind === "invalid") {
      out.push({
        rule: "json-ld-invalid",
        severity: "error",
        pageId: f.pageId,
        message: `JSON-LD invalid: the block in module ${block.moduleId} is not JSON (${block.error}).`,
      });
    }
  }
  if (!f.socialMeta.some((m) => m.key === "og:image")) {
    out.push({
      rule: "share-image-missing",
      severity: "warning",
      pageId: f.pageId,
      message: "Share image missing: the page has no og:image.",
    });
  }
  return out;
}

const factsPlugin = definePlugin({
  slug: SLUG,
  version: "0.1.0",
  tier: 1,
  schema: {},
  auditFindingsOperation: "audit_findings",
  operations: {
    audit_findings: async (_ctx: unknown, raw: unknown) => {
      const args = raw as PluginAuditFindingsArgs;
      if (!args.facts) {
        return {
          findings: [],
          factBatches: [args.pages.map((p) => p.pageId)],
          batchPages: "own" as const,
        };
      }
      received.push(...args.facts);
      return { findings: args.facts.flatMap(rulesOn) };
    },
  },
});

async function cleanup(): Promise<void> {
  resetPluginHost();
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${SLUG}')
      )`);
      await tx.unsafe(
        `DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${SLUG}')`,
      );
      await tx.unsafe(`DELETE FROM plugins WHERE slug = '${SLUG}'`);
    });
  } finally {
    await sql.end();
  }
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
    testPlugins: [{ definition: factsPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
});

afterEach(async () => {
  await run?.remove();
  run = null;
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("#1755 audit page facts through auditFindingsOperation", () => {
  it("hands a plugin check headings, images, JSON-LD and social tags, and files its findings", async () => {
    run = await startRunningAudit(ADMIN_URL as string, { adapter, registry }, SLUG);
    const checks = withPluginAuditChecks(new CheckRegistry(), {
      contributors: () => [SLUG],
      findings: (slug, pages, facts) =>
        collectPluginFindings((run as RunningAudit).call(slug), slug, pages, facts),
      siteUrls: async () => [BASE],
    });
    const out = await runFindingChecks(checks.findingChecks(), STAGED, {
      baseUrl: "http://s.test",
      probe: async () => ({ found: true, status: 200 }),
      text: async () => null,
    });

    // The malformed JSON-LD is a finding of the plugin, not a failed audit.
    expect(out.errors).toEqual([]);
    expect(run.reports.map((r) => r.label)).toEqual(["pages", "facts batch 1"]);

    const home = received.find((f) => f.pageId === HOME);
    const about = received.find((f) => f.pageId === ABOUT);
    expect(home?.headings).toEqual([
      { level: 1, text: "Willkommen", moduleId: HERO, listItem: null, pluginSlug: null },
      { level: 2, text: "Angebot", moduleId: null, listItem: null, pluginSlug: null },
    ]);
    expect(home?.images.map((i) => [i.media, i.alt, i.width, i.height, i.decorative])).toEqual([
      [{ ref: "team-photo", variant: "webp-800" }, "Das Team", 800, 533, false],
      [{ ref: "divider", variant: "orig" }, "", null, null, true],
    ]);
    expect(home?.jsonLd).toEqual([
      {
        kind: "parsed",
        data: { "@context": "https://schema.org", "@type": "Organization", name: "Caelo" },
        moduleId: null,
        listItem: null,
        pluginSlug: null,
      },
    ]);
    expect(home?.socialMeta.map((m) => [m.key, m.attribute])).toEqual([
      ["og:title", "property"],
      ["og:image", "property"],
      ["twitter:card", "name"],
    ]);
    expect(home?.truncatedFacts).toEqual([]);
    expect(about?.jsonLd[0]?.kind).toBe("invalid");
    expect(about?.jsonLd[0]?.moduleId).toBe(FAQ);

    const rules = out.findings.map((f) => [f.ruleId, f.pageId]).sort();
    expect(rules).toEqual(
      [
        [`plugin.${SLUG}/h1-count`, ABOUT],
        [`plugin.${SLUG}/image-alt-missing`, ABOUT],
        [`plugin.${SLUG}/json-ld-invalid`, ABOUT],
        [`plugin.${SLUG}/share-image-missing`, ABOUT],
      ].sort(),
    );
    const altMissing = out.findings.find((f) => f.ruleId.endsWith("/image-alt-missing"));
    expect(altMissing?.message).toContain(`image office in module ${FAQ}`);
  }, 60_000);
});
