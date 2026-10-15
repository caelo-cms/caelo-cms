// SPDX-License-Identifier: MPL-2.0

/**
 * Lighthouse Performance metrics per audited page against a real
 * Postgres: `quality_audits.record_result` stores them in
 * `quality_audit_pages.metrics` (0274), `quality_audits.get` and
 * `get_quality_audit` return them, `quality_audits.classify_stage`
 * (`includeLastMetrics`) and `check_stage_audit` return the newest ones of
 * the pages a Stage touches. Metrics are data: they never change the gate.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ToolContext } from "../ai/tools/dispatch.js";
import {
  AUDIT_FIX_LOOP_NEXT_STEP,
  checkStageAuditTool,
  getQualityAuditTool,
} from "../ai/tools/quality-audit-tools.js";
import { sampleMetrics } from "../quality/__tests__/fixtures/sample-metrics.js";
import type { PerformanceMetrics } from "../quality/lighthouse-metrics.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "qa-lhm" };
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "qa-lhm",
};
const PFX = "qalhm-";
const ALL_100 = { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 };
const NO_CHECKS = { ran: [], pages: [], findings: [], errors: [] };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId: string;
let homeId: string;
let aboutId: string;
let blogId: string;
let moduleId: string;
let firstRunId: string;
let droppedRunId: string;

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    let out: T | undefined;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      out = await fn(tx as unknown as SQL);
    });
    return out as T;
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    await tx`DELETE FROM quality_acceptances`;
    await tx`DELETE FROM quality_baselines`;
    await tx`DELETE FROM quality_audit_runs`;
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM chat_entity_locks WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home')`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home'`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
  });
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** A succeeded staging deploy run; `minutes` orders runs in time. */
async function deployRun(minutes: number): Promise<string> {
  return withSql(async (tx) => {
    const rows = (await tx`
      INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at)
      SELECT id, ${SYSTEM_ID}::uuid, 'succeeded',
             now() - interval '1 day' + make_interval(mins => ${minutes}), now()
      FROM deploy_targets WHERE name = 'staging'
      RETURNING id::text AS id
    `) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) throw new Error("deploy run seed");
    return id;
  });
}

/** Enqueue a chat-less staging audit of the homepage + `pageIds` and claim it. */
async function claimedRun(minutes: number, pageIds: string[]): Promise<string> {
  const deployRunId = await deployRun(minutes);
  await op(SYS, "quality_audits.enqueue", {
    deployRunId,
    chatSessionId: null,
    branch: null,
    pageIds,
  });
  const run = (
    await op<{ run: { auditRunId: string } | null }>(SYS, "quality_audits.claim_next", {})
  ).run;
  if (!run) throw new Error("nothing to claim");
  return run.auditRunId;
}

/** The recorded metrics with LCP replaced by `ms` (one run). */
function metricsWithLcp(ms: number, score: number): PerformanceMetrics {
  const m = sampleMetrics();
  return {
    ...m,
    metrics: m.metrics.map((x) =>
      x.label === "LCP"
        ? {
            ...x,
            numericValue: ms,
            displayValue: `${(ms / 1000).toFixed(1)} s`,
            score,
            runValues: [ms],
          }
        : x,
    ),
  };
}

function lighthousePage(pageId: string, metrics: PerformanceMetrics) {
  return {
    pageId,
    url: `http://staging.test/${pageId}/`,
    measurement: { scores: ALL_100, failingAudits: [], metrics },
    performanceRuns: [100],
  };
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  templateId = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      slug: `${PFX}tpl`,
      displayName: "QA template",
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
    })
  ).templateId;
  await op(SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const page = async (slug: string, title: string) =>
    (
      await op<{ pageId: string }>(SYS, "pages.create", {
        slug,
        title,
        templateId,
        status: "published",
      })
    ).pageId;
  homeId = await page("home", "Home");
  aboutId = await page(`${PFX}about`, "About");
  blogId = await page(`${PFX}blog`, "Blog");
  moduleId = (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `${PFX}hero`,
      displayName: "Hero",
      html: "<div class='hero'>{{title}}</div>",
      fields: [{ name: "title", kind: "text", label: "Title" } as never],
    })
  ).moduleId;
  await op(SYS, "pages.set_modules", {
    pageId: aboutId,
    blocks: [{ blockName: "content", moduleIds: [moduleId] }],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("Lighthouse metrics per audited page", () => {
  it("record_result stores them and quality_audits.get returns them; a check-only row has none", async () => {
    firstRunId = await claimedRun(10, [aboutId]);
    const recorded = await op<{ status: string }>(SYS, "quality_audits.record_result", {
      auditRunId: firstRunId,
      baseUrl: "http://staging.test",
      outcome: {
        kind: "completed",
        pages: [
          lighthousePage(homeId, sampleMetrics()),
          lighthousePage(aboutId, metricsWithLcp(4100, 0.21)),
        ],
        pageErrors: [],
        checks: {
          ran: [
            { id: "qa-check", title: "QA", scope: "page", source: { kind: "plugin", slug: "qa" } },
          ],
          pages: [homeId, aboutId, blogId].map((pageId) => ({
            pageId,
            url: "http://staging.test/",
          })),
          findings: [
            { ruleId: "qa-check/hint", severity: "warning", pageId: blogId, message: "A hint." },
          ],
          errors: [],
        },
      },
    });
    // A POOR LCP is data, not a problem: the run passes.
    expect(recorded.status).toBe("passed");

    const stored = await withSql(
      async (tx) =>
        (await tx`
          SELECT page_id::text AS page_id, metrics FROM quality_audit_pages
          WHERE audit_run_id = ${firstRunId}::uuid
        `) as unknown as { page_id: string; metrics: unknown }[],
    );
    const byPage = new Map(stored.map((r) => [r.page_id, r.metrics]));
    expect(byPage.get(blogId)).toBeNull();
    expect(byPage.get(homeId)).not.toBeNull();

    const got = await op<{
      pages: { pageId: string; metrics: PerformanceMetrics | null }[];
    }>(AI, "quality_audits.get", { auditRunId: firstRunId });
    const pages = new Map(got.pages.map((p) => [p.pageId, p.metrics]));
    expect(pages.get(homeId)).toEqual(sampleMetrics());
    expect(pages.get(aboutId)?.metrics.find((x) => x.label === "LCP")?.displayValue).toBe("4.1 s");
    expect(pages.get(blogId)).toBeNull();
  });

  it("get_quality_audit shows the metrics, the LCP element and the layout shifts", async () => {
    const r = await getQualityAuditTool.handler(AI, { auditRunId: firstRunId }, {
      adapter,
      registry,
    } as ToolContext);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Performance metrics (median of 1 Lighthouse run(s)");
    expect(r.content).toContain("- LCP 4.1 s (Largest Contentful Paint) — score 0.21, POOR");
    expect(r.content).toContain("- LCP element: `body > h1` `<h1>` (Hello)");
    expect(r.content).toContain("Media element lacking an explicit size: body > img.hero");
  });

  it("record_result refuses a Lighthouse page without metrics, naming the field", async () => {
    const auditRunId = await claimedRun(20, []);
    const r = await execute(registry, adapter, SYS, "quality_audits.record_result", {
      auditRunId,
      baseUrl: "http://staging.test",
      outcome: {
        kind: "completed",
        pages: [
          {
            pageId: homeId,
            url: "http://staging.test/",
            measurement: { scores: ALL_100, failingAudits: [] },
            performanceRuns: [100],
          },
        ],
        pageErrors: [],
        checks: NO_CHECKS,
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain("metrics");
    await op(SYS, "quality_audits.record_result", {
      auditRunId,
      baseUrl: "http://staging.test",
      outcome: {
        kind: "completed",
        pages: [lighthousePage(homeId, sampleMetrics())],
        pageErrors: [],
        checks: NO_CHECKS,
      },
    });
  });

  it("classify_stage + check_stage_audit report the newest metrics of the touched pages and the homepage", async () => {
    // A newer audit of /about measured a better LCP: that one is reported.
    const newer = await claimedRun(30, [aboutId]);
    await op(SYS, "quality_audits.record_result", {
      auditRunId: newer,
      baseUrl: "http://staging.test",
      outcome: {
        kind: "completed",
        pages: [
          lighthousePage(homeId, sampleMetrics()),
          lighthousePage(aboutId, metricsWithLcp(3000, 0.5)),
        ],
        pageErrors: [],
        checks: NO_CHECKS,
      },
    });

    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      SYS,
      "chat.create_session",
      {
        title: `${PFX}speed`,
      },
    );
    const branch = { ...SYS, chatBranchId: s.chatBranchId, chatTaskId: s.chatSessionId };
    await op(branch, "modules.update", { moduleId, css: ".hero{min-height:60vh}" });

    const plain = await op<{ lastMetrics?: unknown }>(AI, "quality_audits.classify_stage", {
      chatSessionId: s.chatSessionId,
    });
    expect(plain.lastMetrics).toBeUndefined();

    const v = await op<{
      touchedPageIds: string[];
      lastMetrics: {
        pageId: string;
        pagePath: string;
        auditRunId: string;
        metrics: PerformanceMetrics;
      }[];
    }>(AI, "quality_audits.classify_stage", {
      chatSessionId: s.chatSessionId,
      includeLastMetrics: true,
    });
    expect(v.touchedPageIds).toEqual([aboutId]);
    expect(v.lastMetrics.map((p) => p.pageId)).toEqual([homeId, aboutId]);
    const about = v.lastMetrics[1];
    expect(about?.auditRunId).toBe(newer);
    expect(about?.metrics.metrics.find((x) => x.label === "LCP")?.numericValue).toBe(3000);
    // Pages Lighthouse never measured are absent (blog only had a check row).
    expect(v.lastMetrics.some((p) => p.pageId === blogId)).toBe(false);

    const told = await checkStageAuditTool.handler(AI, {}, {
      adapter,
      registry,
      chatSessionId: s.chatSessionId,
    } as ToolContext);
    expect(told.ok).toBe(true);
    expect(told.content).toContain("will be quality-checked");
    expect(told.content).toContain("Last measured on the staged build");
    expect(told.content).toContain(`## About (/${PFX}about) — audit ${newer}`);
    expect(told.content).toContain(
      "- LCP 3.0 s (Largest Contentful Paint) — score 0.5, needs improvement",
    );
    await op(SYS, "chat.discard_branch", { chatSessionId: s.chatSessionId });
  });

  it("quality_audits.get names each page's previous scores, and get_quality_audit points out a drop", async () => {
    // An external agent read 92–97 and reported them instead of fixing: a
    // drop against the page's previous audit is pointed out as the place to
    // look first, and the result must end with the fix loop.
    const dropped = await claimedRun(40, [aboutId]);
    await op(SYS, "quality_audits.record_result", {
      auditRunId: dropped,
      baseUrl: "http://staging.test",
      outcome: {
        kind: "completed",
        pages: [
          {
            ...lighthousePage(homeId, sampleMetrics()),
            measurement: {
              scores: { ...ALL_100, performance: 92 },
              failingAudits: [],
              metrics: sampleMetrics(),
            },
            performanceRuns: [92],
          },
          lighthousePage(aboutId, sampleMetrics()),
        ],
        pageErrors: [],
        checks: NO_CHECKS,
      },
    });
    const got = await op<{
      pages: { pageId: string; previousScores: Record<string, number> | null }[];
    }>(AI, "quality_audits.get", { auditRunId: dropped });
    const previous = new Map(got.pages.map((p) => [p.pageId, p.previousScores]));
    expect(previous.get(homeId)).toEqual(ALL_100);

    const first = await op<{ pages: { pageId: string; previousScores: unknown }[] }>(
      AI,
      "quality_audits.get",
      { auditRunId: firstRunId },
    );
    expect(first.pages.every((p) => p.previousScores === null)).toBe(true);

    const r = await getQualityAuditTool.handler(AI, { auditRunId: dropped }, {
      adapter,
      registry,
    } as ToolContext);
    expect(r.content).toContain(
      "DROPPED since this page's previous audit (100 → 92): check the changes since then first",
    );
    expect(r.content.endsWith(AUDIT_FIX_LOOP_NEXT_STEP)).toBe(true);
    droppedRunId = dropped;
  });

  it("compares only with an earlier audit on the same branch lineage and, for Performance, the same CPU calibration", async () => {
    // A chat's audit: the chat-less (main) audits before it measured other
    // changes, so it has nothing to compare with.
    const s = await op<{ chatSessionId: string }>(SYS, "chat.create_session", {
      title: `${PFX}lineage`,
    });
    await op(SYS, "quality_audits.enqueue", {
      deployRunId: await deployRun(50),
      chatSessionId: s.chatSessionId,
      branch: {
        classification: {
          auditNeeded: true,
          reasons: [{ rule: "module_code", entityId: moduleId, label: "Hero CSS changed" }],
          skipped: [],
        },
        touchedPageIds: [],
      },
      stagedBy: "live_edit_ai",
    });
    const chatRun = (
      await op<{ run: { auditRunId: string } | null }>(SYS, "quality_audits.claim_next", {})
    ).run?.auditRunId;
    if (!chatRun) throw new Error("nothing to claim");
    const homeAt = (scores: Record<string, number>) => ({
      ...lighthousePage(homeId, sampleMetrics()),
      measurement: { scores, failingAudits: [], metrics: sampleMetrics() },
      performanceRuns: [scores.performance as number],
    });
    await op(SYS, "quality_audits.record_result", {
      auditRunId: chatRun,
      baseUrl: "http://staging.test",
      outcome: {
        kind: "completed",
        pages: [homeAt({ ...ALL_100, performance: 70 })],
        pageErrors: [],
        checks: NO_CHECKS,
      },
    });
    const previousOf = async (auditRunId: string) =>
      new Map(
        (
          await op<{ pages: { pageId: string; previousScores: Record<string, number> | null }[] }>(
            AI,
            "quality_audits.get",
            { auditRunId },
          )
        ).pages.map((p) => [p.pageId, p.previousScores]),
      ).get(homeId);
    expect(await previousOf(chatRun)).toBeNull();

    // The next main audit compares with the previous MAIN audit (92), not
    // with the chat's 70 recorded in between.
    const mainRun = await claimedRun(60, []);
    await op(SYS, "quality_audits.record_result", {
      auditRunId: mainRun,
      baseUrl: "http://staging.test",
      outcome: {
        kind: "completed",
        pages: [homeAt({ ...ALL_100, performance: 88, accessibility: 99 })],
        pageErrors: [],
        checks: NO_CHECKS,
      },
    });
    expect(await previousOf(mainRun)).toEqual({ ...ALL_100, performance: 92 });

    // Performance measured at another CPU slowdown is another measurement:
    // dropped from the comparison; the CPU-independent categories stay.
    const calibrate = (auditRunId: string, multiplier: number) =>
      withSql(
        (tx) => tx`
          UPDATE quality_audit_pages
          SET metrics = jsonb_set(metrics, '{cpuCalibration}',
                jsonb_build_object('benchmarkIndex', 1500, 'cpuSlowdownMultiplier', ${multiplier}::numeric))
          WHERE audit_run_id = ${auditRunId}::uuid AND page_id = ${homeId}::uuid
        `,
      );
    await calibrate(mainRun, 3.9);
    const { performance: _uncalibrated, ...cpuIndependent } = ALL_100;
    expect(await previousOf(mainRun)).toEqual(cpuIndependent);
    await calibrate(droppedRunId, 3.9);
    expect(await previousOf(mainRun)).toEqual({ ...ALL_100, performance: 92 });

    const r = await getQualityAuditTool.handler(AI, { auditRunId: mainRun }, {
      adapter,
      registry,
    } as ToolContext);
    expect(r.content).toContain("DROPPED since this page's previous audit (92 → 88)");
    expect(r.content).toContain("DROPPED since this page's previous audit (100 → 99)");
    await op(SYS, "chat.discard_branch", { chatSessionId: s.chatSessionId });
  });
});
