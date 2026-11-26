// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1721 — measure the plugin checks of a Stage audit on the
 * scale-gate fixture (docs/dev/scale-gate.md, "The audit's plugin check").
 *
 * After `fixture.ts` seeded its throwaway database, this runs what the
 * audit's job runs for each active plugin that contributes findings
 * (international-site at 50,000 pages: 1 call plus 250 batch calls),
 * through the real reporting-job path: a job attempt with a token, every
 * call a `plugin-findings` report to the admin's handler in this process
 * (the transport a self-hosted admin uses, optionally with a simulated
 * round trip per report: `--rtt-ms`, the job → IAP → admin leg on Google
 * Cloud), payloads over the inline limit in upload parts. The staged
 * pages are rendered here, shaped like a real build (header menu, hreflang
 * of the page's language group, body copy with links, footer), because
 * the fixture builds no Stage.
 *
 *   CAELO_SCALE_GATE_THROWAWAY_DB=1 PG_SUPERUSER_URL=postgres://… \
 *     bun scripts/scale-gate/audit-check.ts --concurrency 1,4 --rtt-ms 0,100 --out audit.json
 *
 * Per run it reports the check's time, the reports sent (upload parts
 * included) and their size, and per call the database statements
 * (`pg_stat_statements`, admin_role's, read between calls of a run at
 * concurrency 1). `--legacy-call` calls `collectPluginFindings` without
 * options, for a tree from before #1721 (the before half of a comparison).
 */

import { writeFileSync } from "node:fs";
import { bootstrap } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import type { StagedPage } from "../../packages/admin-core/src/quality/checks/check.ts";
import { siteHostsOf } from "../../packages/admin-core/src/quality/checks/links-analysis.ts";
import {
  extractPageFacts,
  parseSitemapAlternates,
} from "../../packages/admin-core/src/quality/checks/page-facts.ts";
import {
  collectPluginFindings,
  type PluginAuditAnswer,
  type PluginAuditCall,
} from "../../packages/admin-core/src/quality/checks/plugin-findings.ts";
import { registerAdminOps } from "../../packages/admin-core/src/register.ts";
import { inProcessReportTransport } from "../../packages/admin-core/src/reporting-jobs/in-process.ts";
import {
  createJobReporter,
  type ReportTransport,
} from "../../packages/admin-core/src/reporting-jobs/job-reporter.ts";
import { startReportingJob } from "../../packages/admin-core/src/reporting-jobs/launcher.ts";
import type { JobOrder } from "../../packages/admin-core/src/reporting-jobs/protocol.ts";
import { SHIPPED_PLUGINS } from "./plugins.ts";

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SITE = "https://scale-gate.example";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** One report the job sent. */
interface Sent {
  readonly action: string;
  readonly chars: number;
}

/** The transport of the attempt, counting what it sends and waiting `rttMs` per report. */
function measured(inner: ReportTransport, sent: Sent[], rtt: { ms: number }): ReportTransport {
  return {
    label: inner.label,
    async send(envelope) {
      sent.push({ action: envelope.action, chars: JSON.stringify(envelope).length });
      if (rtt.ms > 0) await new Promise((r) => setTimeout(r, rtt.ms));
      return inner.send(envelope);
    },
  };
}

interface PageRow {
  readonly id: string;
  readonly path: string;
  readonly locale: string | null;
  readonly group: string | null;
}

/** The build's pages, each with its variant group (international-site's table). */
async function readPages(admin: SQL): Promise<PageRow[]> {
  return (await admin.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    // The plugin's own table answers its own plugin id only (RLS).
    const plugin = await tx`SELECT id::text AS id FROM plugins WHERE slug = 'international-site'`;
    await tx`SELECT set_config('caelo.plugin_id', ${plugin[0]?.id as string}, true)`;
    return tx.unsafe(`
      SELECT p.id::text AS id, p.current_path AS path, v.locale_code AS locale, v.group_id::text AS "group"
      FROM pages p
      LEFT JOIN plugin_international_site.page_variants v ON v.page_id = p.id
      WHERE p.status = 'published' AND p.deleted_at IS NULL AND p.chat_branch_id IS NULL
      ORDER BY (p.current_path = '/') DESC, p.current_path`);
  })) as PageRow[];
}

/** A staged page as a build renders one: menu, hreflang, copy with links, footer. */
function render(
  page: PageRow,
  byGroup: ReadonlyMap<string, PageRow[]>,
  sameLanguage: readonly PageRow[],
  n: number,
): string {
  const lang = page.locale ?? "en";
  const group = page.group ? (byGroup.get(page.group) ?? []) : [];
  const alternates = group
    .map((m) => `<link rel="alternate" hreflang="${m.locale}" href="${SITE}${m.path}">`)
    .join("");
  const xDefault = group.find((m) => m.locale === "en");
  const menu = sameLanguage
    .slice(0, 10)
    .map((q, i) => `<a href="${q.path}">${lang === "de" ? "Menü" : "Menu"} ${i}</a>`)
    .join("");
  const footer = sameLanguage
    .slice(10, 20)
    .map((q, i) => `<a href="${q.path}">${lang === "de" ? "Verweis" : "Link"} ${i}</a>`)
    .join("");
  const switcher = group
    .filter((m) => m.id !== page.id)
    .map((m) => `<a href="${m.path}" hreflang="${m.locale}">${m.locale}</a>`)
    .join("");
  const runs: string[] = [];
  for (let i = 0; i < 40; i++) {
    runs.push(
      lang === "de"
        ? `<p>Absatz ${i} der Seite ${n}: unsere Plattform hilft Teams, schneller zu liefern.</p>`
        : `<p>Paragraph ${i} of page ${n}: our platform helps teams ship faster with fewer mistakes.</p>`,
    );
    if (i < 5) {
      const q = sameLanguage[(n * 7 + i * 13) % sameLanguage.length] as PageRow;
      runs.push(`<p><a href="${q.path}">${lang === "de" ? "Lesen" : "Read"} ${i}</a></p>`);
    }
  }
  return `<html lang="${lang}"><head><title>${page.path}</title><link rel="canonical" href="${SITE}${page.path}">${alternates}${xDefault ? `<link rel="alternate" hreflang="x-default" href="${SITE}${xDefault.path}">` : ""}</head>
<body><header data-caelo-module-id="sg-header">${menu}${switcher}</header>
<main><section data-caelo-module-id="sg-body">${runs.join("")}</section></main>
<footer data-caelo-module-id="sg-footer">${footer}<p>All rights reserved</p></footer></body></html>`;
}

async function main(): Promise<void> {
  if (process.env.CAELO_SCALE_GATE_THROWAWAY_DB !== "1") {
    throw new Error("refusing: set CAELO_SCALE_GATE_THROWAWAY_DB=1 (this writes audit rows)");
  }
  const adminUrl = requireEnv("ADMIN_DATABASE_URL");
  const superUrl = requireEnv("PG_SUPERUSER_URL");
  const concurrencies = arg("concurrency", "1").split(",").map(Number);
  const rtts = arg("rtt-ms", "0").split(",").map(Number);
  const legacy = process.argv.includes("--legacy-call");
  const out = arg("out", "audit-check.json");

  const adapter = new DatabaseAdapter({
    adminDatabaseUrl: adminUrl,
    publicDatabaseUrl: requireEnv("PUBLIC_ADMIN_DATABASE_URL"),
  });
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: SHIPPED_PLUGINS.map((definition) => ({ definition })),
  });
  if (report.failed.length > 0)
    throw new Error(`plugin bootstrap: ${JSON.stringify(report.failed)}`);

  const admin = new SQL(adminUrl);
  const superuser = new SQL(superUrl);
  await superuser.unsafe("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
  const rows = await readPages(admin);
  const byGroup = new Map<string, PageRow[]>();
  for (const r of rows) {
    if (!r.group) continue;
    byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);
  }
  const byLanguage = new Map<string, PageRow[]>();
  for (const r of rows) {
    const l = r.locale ?? "en";
    byLanguage.set(l, [...(byLanguage.get(l) ?? []), r]);
  }
  const staged: StagedPage[] = rows.map((r, n) => ({
    pageId: r.id,
    path: r.path,
    url: `http://s.test${r.path}`,
    html: render(r, byGroup, byLanguage.get(r.locale ?? "en") ?? [], n),
  }));
  const hosts = siteHostsOf(["http://s.test", SITE]);
  const sitemap = parseSitemapAlternates(null, hosts);
  const factsOf = new Map(staged.map((p) => [p.pageId, p]));
  console.log(`[audit-check] ${staged.length} pages, ${byGroup.size} language groups`);

  // A queued audit of a staging build of its own, and its job's attempt.
  const ids = (await admin.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    const t = await tx`INSERT INTO deploy_targets (name, env, out_dir)
      VALUES (${`audit-check-${Date.now()}`}, 'staging', '/tmp/audit-check') RETURNING id::text AS id`;
    const r = await tx`INSERT INTO deploy_runs (target_id, actor_id, status)
      VALUES (${t[0].id}::uuid, ${SYSTEM_ACTOR_ID}::uuid, 'succeeded') RETURNING id::text AS id`;
    const a =
      await tx`INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification)
      VALUES (${r[0].id}::uuid, ${SYSTEM_ACTOR_ID}::uuid, 'queued', '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb)
      RETURNING id::text AS id`;
    return { auditRunId: a[0].id as string };
  })) as { auditRunId: string };
  const orders: JobOrder[] = [];
  const started = await startReportingJob({ adapter, registry }, "quality_audit", ids.auditRunId, {
    launcher: {
      label: "audit-check",
      launch: async (order) => {
        orders.push(order);
        return "in-process:audit-check";
      },
    },
  });
  const order = orders[0];
  if (started.outcome !== "started" || !order) throw new Error(JSON.stringify(started));
  const sent: Sent[] = [];
  const rtt = { ms: 0 };
  const reporter = createJobReporter(
    order,
    measured(inProcessReportTransport({ adapter, registry }, order), sent, rtt),
  );
  const start = await reporter.call<{ kind: string }>("start");
  if (start.kind !== "run") throw new Error(`the audit did not start: ${JSON.stringify(start)}`);

  const statementsSoFar = async (): Promise<number> => {
    const r = (await superuser.unsafe(`
      SELECT COALESCE(sum(s.calls), 0)::bigint AS n FROM pg_stat_statements s
      JOIN pg_roles u ON u.oid = s.userid WHERE u.rolname = 'admin_role'`)) as { n: string }[];
    return Number(r[0]?.n ?? 0);
  };

  const results: unknown[] = [];
  for (const rttMs of rtts) {
    for (const concurrency of concurrencies) {
      rtt.ms = rttMs;
      for (const slug of ["international-site"]) {
        sent.length = 0;
        const perCall: { label: string; ms: number; statements: number; chars: number }[] = [];
        let factsMs = 0;
        const call: PluginAuditCall = async (args, label) => {
          const before = concurrency === 1 ? await statementsSoFar() : 0;
          const chars = JSON.stringify({ slug, label, args }).length;
          const t0 = performance.now();
          const answer = await reporter.call<PluginAuditAnswer>("plugin-findings", {
            slug,
            label,
            args,
          });
          perCall.push({
            label,
            chars,
            ms: performance.now() - t0,
            statements: concurrency === 1 ? (await statementsSoFar()) - before : Number.NaN,
          });
          return answer;
        };
        const facts = async (pageIds: readonly string[]) => {
          const t0 = performance.now();
          const f = pageIds.map((id) =>
            extractPageFacts(factsOf.get(id) as StagedPage, hosts, sitemap),
          );
          factsMs += performance.now() - t0;
          return f;
        };
        const pages = staged.map((p) => ({ pageId: p.pageId, path: p.path }));
        const t0 = performance.now();
        const found = legacy
          ? await collectPluginFindings(call, slug, pages, facts)
          : await collectPluginFindings(call, slug, pages, facts, { concurrency });
        const ms = performance.now() - t0;
        const plugin = sent.filter((s) => s.action === "plugin-findings");
        const parts = sent.filter((s) => s.action === "upload-part");
        const batches = perCall.filter((c) => c.label !== "pages");
        const first = perCall.find((c) => c.label === "pages");
        const result = {
          slug,
          legacy,
          rttMs,
          concurrency: legacy ? 1 : concurrency,
          pages: staged.length,
          findings: found.length,
          // The same at every concurrency, or the batch calls depend on each other.
          findingsHash: new Bun.CryptoHasher("sha256")
            .update(JSON.stringify(found))
            .digest("hex")
            .slice(0, 16),
          checkMs: Math.round(ms),
          factsMs: Math.round(factsMs),
          calls: plugin.length,
          reports: sent.length,
          uploadParts: parts.length,
          firstCallChars: first?.chars ?? 0,
          batchCallChars: {
            mean: Math.round(
              batches.reduce((n, c) => n + c.chars, 0) / Math.max(1, batches.length),
            ),
            max: Math.max(0, ...batches.map((c) => c.chars)),
          },
          bytesSent: sent.reduce((n, s) => n + s.chars, 0),
          firstCall: first ? { ms: Math.round(first.ms), statements: first.statements } : null,
          batch: {
            meanMs: Math.round(batches.reduce((n, c) => n + c.ms, 0) / Math.max(1, batches.length)),
            meanStatements:
              concurrency === 1
                ? Math.round(
                    batches.reduce((n, c) => n + c.statements, 0) / Math.max(1, batches.length),
                  )
                : null,
          },
        };
        console.log("[audit-check]", JSON.stringify(result));
        results.push(result);
      }
    }
  }
  writeFileSync(out, JSON.stringify(results, null, 2));
  await admin.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`UPDATE quality_audit_runs SET status = 'passed', finished_at = now() WHERE id = ${ids.auditRunId}::uuid`;
  });
  await admin.end();
  await superuser.end();
  await adapter.close();
  process.exit(0);
}

await main();
