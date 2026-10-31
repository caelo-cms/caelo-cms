// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — quality gate data path against a real Postgres:
 *
 *   - classification of a chat branch (content-only vs. module code,
 *     templates, new pages) via `quality_audits.classify_stage`;
 *   - enqueue rules (first Stage, previous audit not clean, chat-less
 *     deploys, skipped runs, non-staging runs refused);
 *   - the claim → record lifecycle incl. supersession and the stale sweep;
 *   - #727 "optimum": every value below 100 is a problem, acceptances
 *     apply live at the value accepted and only ratchet up;
 *   - read ops + the AI read tools; actor scopes.
 *
 * Lighthouse itself is not run here (the worker's runner is replaced by a
 * fake); `scripts/lighthouse-smoke.ts` covers the real browser stack.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ToolContext } from "../ai/tools/dispatch.js";
import {
  checkStageAuditTool,
  getQualityAuditTool,
  listQualityAcceptancesTool,
  listQualityAuditsTool,
} from "../ai/tools/quality-audit-tools.js";
import { sampleMetrics } from "../quality/__tests__/fixtures/sample-metrics.js";
import { drainAuditQueue } from "../quality/audit-worker.js";
import { testCheckRegistry } from "../quality/checks/__tests__/fixtures/test-checks.js";
import type { AuditJob } from "../quality/lighthouse-protocol.js";
import type { AuditJobResult } from "../quality/lighthouse-runner.js";
import type { FailingAudit, QualityCategory } from "../quality/ratchet.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "qa-553" };
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "qa-553",
};
const PFX = "qa553-";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId: string;
let homeId: string;
let aboutId: string;
let moduleId: string;

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

/** Insert a deploy run on a seeded target; minutes orders runs in time. */
async function deployRun(
  target: "staging" | "production",
  minutes: number,
  status: "succeeded" | "failed" = "succeeded",
): Promise<string> {
  return withSql(async (tx) => {
    const rows = (await tx`
      INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at)
      SELECT id, ${SYSTEM_ID}::uuid, ${status},
             now() - interval '1 day' + make_interval(mins => ${minutes}), now()
      FROM deploy_targets WHERE name = ${target}
      RETURNING id::text AS id
    `) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) throw new Error("deploy run seed");
    return id;
  });
}

/** Give a deploy run a build, so it is what staging serves and Publish
 *  would ship (the gate reads the newest succeeded run with a build). */
async function markBuilt(deployRunId: string): Promise<void> {
  await withSql(async (tx) => {
    await tx`UPDATE deploy_runs SET build_id = ${`build-${deployRunId}`} WHERE id = ${deployRunId}::uuid`;
  });
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function newChat(
  title: string,
): Promise<{ chatSessionId: string; branch: ExecutionContext }> {
  const s = await op<{ chatSessionId: string; chatBranchId: string }>(SYS, "chat.create_session", {
    title: `${PFX}${title}`,
  });
  // The chat task attributes each write to its chat (issue #620: on the
  // shared draft the branch alone names no single chat).
  return {
    chatSessionId: s.chatSessionId,
    branch: { ...SYS, chatBranchId: s.chatBranchId, chatTaskId: s.chatSessionId },
  };
}

type Classified = {
  classification: { auditNeeded: boolean; reasons: { rule: string }[]; skipped: string[] };
  touchedPageIds: string[];
};

const CONTENT_ONLY: Classified = {
  classification: { auditNeeded: false, reasons: [], skipped: ["field values: copy"] },
  touchedPageIds: [],
};

const ALL_100: Record<QualityCategory, number> = {
  performance: 100,
  accessibility: 100,
  "best-practices": 100,
  seo: 100,
};

const imageAlt: FailingAudit = {
  id: "image-alt",
  title: "Image elements do not have [alt] attributes",
  score: 0,
  categories: ["accessibility", "seo"],
};

function pageResult(
  pageId: string,
  scores: Partial<Record<QualityCategory, number>>,
  failing: FailingAudit[] = [],
) {
  const merged = { ...ALL_100, ...scores };
  return {
    pageId,
    url: `http://staging.test/${pageId}/`,
    measurement: { scores: merged, failingAudits: failing, metrics: sampleMetrics() },
    performanceRuns: [merged.performance, merged.performance, merged.performance],
  };
}

async function claim(): Promise<{
  auditRunId: string;
  deployRunId: string;
  performanceRuns: number;
  pages: { pageId: string }[];
} | null> {
  const v = await op<{
    run: {
      auditRunId: string;
      deployRunId: string;
      performanceRuns: number;
      pages: { pageId: string }[];
    } | null;
  }>(SYS, "quality_audits.claim_next", {});
  return v.run;
}

/** #727 — a completed audit whose page checks found nothing to report. */
const NO_CHECKS = { ran: [], pages: [], findings: [], errors: [] };

async function record(auditRunId: string, pages: ReturnType<typeof pageResult>[]) {
  return op<{ status: string; problemCount: number }>(SYS, "quality_audits.record_result", {
    auditRunId,
    baseUrl: "http://staging.test",
    outcome: { kind: "completed", pages, pageErrors: [], checks: NO_CHECKS },
  });
}

/** A staged origin serving the routing manifest of `runId` and, for every
 *  other path, a page with a meta description (the page checks pass). */
function stagedServer(runId: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/routing-manifest.json"
        ? Response.json({ runId })
        : new Response(
            '<!doctype html><html><head><meta name="description" content="A page."></head><body></body></html>',
            { headers: { "content-type": "text/html" } },
          ),
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  templateId = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      pageType: "home",
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
  homeId = (
    await op<{ pageId: string }>(SYS, "pages.create", {
      slug: "home",
      title: "Home",
      templateId,
      status: "published",
    })
  ).pageId;
  aboutId = (
    await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}about`,
      title: "About",
      templateId,
      status: "published",
    })
  ).pageId;
  moduleId = (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `${PFX}card`,
      displayName: "Card",
      html: "<div class='card'>{{title}}</div>",
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

describe("quality_audits.classify_stage", () => {
  it("placing an existing module and editing metadata needs no audit", async () => {
    const { chatSessionId, branch } = await newChat("placement");
    await op(branch, "pages.set_modules", {
      pageId: homeId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    await op(branch, "modules.update", { moduleId, displayName: "Card (renamed)" });
    const c = await op<Classified>(SYS, "quality_audits.classify_stage", { chatSessionId });
    expect(c.classification.auditNeeded).toBe(false);
    expect(c.classification.skipped).toContain("placements: Home");
    expect(c.classification.skipped.some((s) => s.startsWith("module fields/metadata only"))).toBe(
      true,
    );
    await op(SYS, "chat.discard_branch", { chatSessionId });
  });

  it("a module code change audits and touches every page placing the module", async () => {
    const { chatSessionId, branch } = await newChat("module-code");
    await op(branch, "modules.update", { moduleId, css: ".card{color:#777}" });
    const c = await op<Classified>(SYS, "quality_audits.classify_stage", { chatSessionId });
    expect(c.classification.auditNeeded).toBe(true);
    expect(c.classification.reasons.map((r) => r.rule)).toEqual(["module_code"]);
    expect(c.touchedPageIds).toEqual([aboutId]);
    // The AI asks the same question through check_stage_audit.
    const told = await checkStageAuditTool.handler(AI, {}, {
      adapter,
      registry,
      chatSessionId,
    } as ToolContext);
    expect(told.content).toContain("will be quality-checked");
    expect(told.content).toContain("module_code");
    await op(SYS, "chat.discard_branch", { chatSessionId });
  });

  it("a template change and a new published page audit", async () => {
    const { chatSessionId, branch } = await newChat("template-page");
    await op(branch, "templates.update", { templateId, css: "body{margin:0}" });
    const created = await op<{ pageId: string }>(branch, "pages.create", {
      slug: `${PFX}pricing`,
      title: "Pricing",
      templateId,
      status: "published",
    });
    const c = await op<Classified>(SYS, "quality_audits.classify_stage", { chatSessionId });
    expect(c.classification.reasons.map((r) => r.rule).sort()).toEqual(["new_page", "template"]);
    expect(c.touchedPageIds).toContain(created.pageId);
    expect(c.touchedPageIds).toContain(homeId);
    await op(SYS, "chat.discard_branch", { chatSessionId });
  });

  it("an unknown chat is an actionable error", async () => {
    const r = await execute(registry, adapter, SYS, "quality_audits.classify_stage", {
      chatSessionId: "00000000-0000-4000-8000-000000000999",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain("not found");
  });
});

describe("quality audit lifecycle + ratchet", () => {
  let chatSessionId: string;

  it("refuses non-staging and failed deploy runs", async () => {
    chatSessionId = (await newChat("lifecycle")).chatSessionId;
    for (const deployRunId of [
      await deployRun("production", 1),
      await deployRun("staging", 2, "failed"),
    ]) {
      const r = await execute(registry, adapter, SYS, "quality_audits.enqueue", {
        deployRunId,
        chatSessionId: null,
        branch: null,
      });
      expect(r.ok).toBe(false);
    }
  });

  it("the first Stage audits even when only content changed; homepage first", async () => {
    const deployRunId = await deployRun("staging", 10);
    const v = await op<{
      status: string;
      classification: Classified["classification"];
      targetPageIds: string[];
    }>(SYS, "quality_audits.enqueue", {
      deployRunId,
      chatSessionId,
      branch: { ...CONTENT_ONLY, touchedPageIds: [aboutId] },
    });
    expect(v.status).toBe("queued");
    expect(v.classification.reasons.map((r) => r.rule)).toEqual(["first_stage"]);
    expect(v.targetPageIds).toEqual([homeId, aboutId]);
  });

  it("a newer Stage supersedes the queued older audit and inherits it (previous not clean)", async () => {
    const deployRunId = await deployRun("staging", 20);
    const v = await op<{
      status: string;
      classification: Classified["classification"];
      targetPageIds: string[];
    }>(SYS, "quality_audits.enqueue", { deployRunId, chatSessionId, branch: CONTENT_ONLY });
    expect(v.status).toBe("queued");
    expect(v.classification.reasons.map((r) => r.rule)).toEqual(["previous_not_clean"]);
    expect(v.targetPageIds).toEqual([homeId, aboutId]);

    const run = await claim();
    expect(run?.deployRunId).toBe(deployRunId);
    // #874: the page is scored by its best of 3 Performance runs (was the
    // median of 5); the job the worker hands the Lighthouse child says so.
    expect(run?.performanceRuns).toBe(3);
    const old = await op<{ runs: { status: string }[] }>(SYS, "quality_audits.list", {
      status: "superseded",
    });
    expect(old.runs).toHaveLength(1);

    // #727 "optimum": about — missing alt text + Accessibility 92; home —
    // Performance 97. Every value below 100 is a problem; no noise guard
    // holds the first Performance drop back, no baseline grandfathers it.
    const r = await record(run?.auditRunId as string, [
      pageResult(homeId, { performance: 97 }),
      pageResult(aboutId, { accessibility: 92 }, [imageAlt]),
    ]);
    expect(r).toEqual({ status: "problems", problemCount: 3 });

    const audit = await op<{
      run: { status: string; problemCount: number };
      pages: {
        pageId: string;
        problems: { kind: string; category?: string }[];
        problemAccepted: boolean[];
      }[];
    }>(SYS, "quality_audits.get", { deployRunId });
    expect(audit.run.status).toBe("problems");
    const home = audit.pages.find((p) => p.pageId === homeId);
    const about = audit.pages.find((p) => p.pageId === aboutId);
    expect(home?.problems).toEqual([
      { kind: "score_below_baseline", category: "performance", score: 97, baseline: 100 },
    ]);
    expect(home?.problemAccepted).toEqual([false]);
    expect(about?.problems.map((p) => p.kind).sort()).toEqual([
      "failing_audit",
      "score_below_baseline",
    ]);
  });

  it("acceptances apply live, per page, at the value accepted", async () => {
    const lastRun = (
      await op<{ runs: { id: string }[] }>(SYS, "quality_audits.list", { status: "problems" })
    ).runs[0]?.id;
    // What the in-chat accept card writes: the finding at its audit score
    // and the category at the score measured.
    await withSql(async (tx) => {
      await tx`
        INSERT INTO quality_acceptances (page_id, kind, audit_id, accepted_score, reason, accepted_by, audit_run_id)
        VALUES (${aboutId}::uuid, 'finding', 'image-alt', 0, 'decorative image, alt intentionally empty', ${SYSTEM_ID}::uuid, ${lastRun}::uuid)`;
      await tx`
        INSERT INTO quality_acceptances (page_id, kind, category, accepted_score, reason, accepted_by, audit_run_id)
        VALUES (${aboutId}::uuid, 'score', 'accessibility', 92, 'same image', ${SYSTEM_ID}::uuid, ${lastRun}::uuid)`;
    });

    const deployRunId = await deployRun("staging", 30);
    await markBuilt(deployRunId);
    const v = await op<{ status: string; classification: Classified["classification"] }>(
      SYS,
      "quality_audits.enqueue",
      { deployRunId, chatSessionId, branch: CONTENT_ONLY },
    );
    // The previous audit ended with problems → audit again.
    expect(v.classification.reasons.map((r) => r.rule)).toEqual(["previous_not_clean"]);
    const run = await claim();
    const r = await record(run?.auditRunId as string, [
      // The same image-alt finding on home is NOT covered by about's acceptance.
      pageResult(homeId, { performance: 96 }, [imageAlt]),
      pageResult(aboutId, { accessibility: 92 }, [imageAlt]),
    ]);
    // Recorded as measured — accepted or not.
    expect(r).toEqual({ status: "problems", problemCount: 4 });
    const audit = await op<{
      pages: {
        pageId: string;
        problems: { kind: string; category?: string; auditId?: string }[];
        problemAccepted: boolean[];
      }[];
    }>(SYS, "quality_audits.get", { auditRunId: run?.auditRunId });
    expect(audit.pages.find((p) => p.pageId === aboutId)?.problemAccepted).toEqual([true, true]);
    const home = audit.pages.find((p) => p.pageId === homeId);
    expect(home?.problems.map((p) => p.auditId ?? p.category).sort()).toEqual([
      "image-alt",
      "performance",
    ]);
    expect(home?.problemAccepted).toEqual([false, false]);
    const gate = await op<{ gate: { open: boolean; openProblemCount: number } }>(
      SYS,
      "quality_audits.gate_status",
      {},
    );
    expect(gate.gate).toMatchObject({ open: false, openProblemCount: 2 });
  });

  it("a better deterministic score tightens the acceptance, a worse one blocks, 100 spends it", async () => {
    const auditOnce = async (minutes: number, pages: ReturnType<typeof pageResult>[]) => {
      const deployRunId = await deployRun("staging", minutes);
      await markBuilt(deployRunId);
      await op(SYS, "quality_audits.enqueue", { deployRunId, chatSessionId, branch: CONTENT_ONLY });
      const run = await claim();
      return record(run?.auditRunId as string, pages);
    };
    const accessibilityAcceptance = async () =>
      withSql(
        async (tx) =>
          (await tx`SELECT accepted_score, revoked_at FROM quality_acceptances
                    WHERE page_id = ${aboutId}::uuid AND kind = 'score' AND category = 'accessibility'
                    ORDER BY accepted_at DESC LIMIT 1`) as unknown as {
            accepted_score: number;
            revoked_at: Date | null;
          }[],
      );
    const gateOpen = async () =>
      (await op<{ gate: { open: boolean } }>(SYS, "quality_audits.gate_status", {})).gate.open;

    // 95 is better than the accepted 92: the acceptance tightens to 95.
    await auditOnce(40, [
      pageResult(homeId, {}),
      pageResult(aboutId, { accessibility: 95 }, [imageAlt]),
    ]);
    expect((await accessibilityAcceptance())[0]?.accepted_score).toBe(95);
    expect(await gateOpen()).toBe(true);
    // 94 is worse than the (tightened) accepted 95: blocks again.
    await auditOnce(43, [
      pageResult(homeId, {}),
      pageResult(aboutId, { accessibility: 94 }, [imageAlt]),
    ]);
    expect(await gateOpen()).toBe(false);
    // Back at 100: the score acceptance is spent (revoked by the worker).
    expect((await auditOnce(46, [pageResult(homeId, {}), pageResult(aboutId, {})])).status).toBe(
      "passed",
    );
    expect((await accessibilityAcceptance())[0]?.revoked_at).not.toBeNull();
  });

  it("a content-only Stage after a clean audit runs the page checks only, on every page (#727)", async () => {
    const deployRunId = await deployRun("staging", 50);
    const v = await op<{
      status: string;
      targetPageIds: string[];
      classification: Classified["classification"];
    }>(SYS, "quality_audits.enqueue", { deployRunId, chatSessionId, branch: CONTENT_ONLY });
    expect(v.status).toBe("queued");
    // No Lighthouse: its classification and target pages are unchanged.
    expect(v.classification.auditNeeded).toBe(false);
    expect(v.targetPageIds).toEqual([]);
    expect(v.classification.skipped).toEqual(["field values: copy"]);
    // #802 — the designated 404 page is flagged so the worker loads it
    // from /404.html (its own path answers 404 by design).
    const prevNotFound = (await withSql(
      (tx) => tx`SELECT not_found_page_id::text AS id FROM site_defaults WHERE id = 1`,
    )) as unknown as { id: string | null }[];
    await withSql(
      (tx) => tx`UPDATE site_defaults SET not_found_page_id = ${aboutId}::uuid WHERE id = 1`,
    );
    let run: {
      auditRunId: string;
      pages: unknown[];
      checkPages: { pageId: string; isNotFoundPage: boolean }[];
    } | null;
    try {
      run = (
        await op<{
          run: {
            auditRunId: string;
            pages: unknown[];
            checkPages: { pageId: string; isNotFoundPage: boolean }[];
          };
        }>(SYS, "quality_audits.claim_next", {})
      ).run;
    } finally {
      await withSql(
        (tx) =>
          tx`UPDATE site_defaults SET not_found_page_id = ${prevNotFound[0]?.id ?? null}::uuid WHERE id = 1`,
      );
    }
    expect(run?.pages).toEqual([]);
    expect(run?.checkPages.map((p) => [p.pageId, p.isNotFoundPage])).toEqual([
      [homeId, false],
      [aboutId, true],
    ]);
    expect((await record(run?.auditRunId as string, [])).status).toBe("passed");
  });

  it("a staging deploy outside a chat always audits, plus the pages it staged", async () => {
    const deployRunId = await deployRun("staging", 60);
    const v = await op<{
      status: string;
      classification: Classified["classification"];
      targetPageIds: string[];
    }>(SYS, "quality_audits.enqueue", {
      deployRunId,
      chatSessionId: null,
      branch: null,
      pageIds: [aboutId],
    });
    expect(v.status).toBe("queued");
    expect(v.classification.reasons.map((r) => r.rule)).toEqual(["no_chat_context"]);
    expect(v.targetPageIds).toEqual([homeId, aboutId]);
  });

  it("a chat Stage must hand in its pre-merge classification", async () => {
    const r = await execute(registry, adapter, SYS, "quality_audits.enqueue", {
      // Zod rejects the shape before any row is read.
      deployRunId: "00000000-0000-4000-8000-000000000065",
      chatSessionId,
      branch: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("ValidationFailed");
  });

  it("an infrastructure failure is recorded loudly and the next Stage audits again", async () => {
    const run = await claim();
    const r = await op<{ status: string }>(SYS, "quality_audits.record_result", {
      auditRunId: run?.auditRunId,
      baseUrl: null,
      outcome: {
        kind: "failed",
        code: "timeout",
        message: "Lighthouse audit exceeded 210 s and was stopped",
      },
    });
    expect(r.status).toBe("errored");
    const got = await op<{ run: { status: string; errorCode: string; errorMessage: string } }>(
      SYS,
      "quality_audits.get",
      { auditRunId: run?.auditRunId },
    );
    expect(got.run).toMatchObject({ status: "errored", errorCode: "timeout" });
    // Results are recorded once.
    const again = await execute(registry, adapter, SYS, "quality_audits.record_result", {
      auditRunId: run?.auditRunId,
      baseUrl: null,
      outcome: { kind: "failed", code: "timeout", message: "x" },
    });
    expect(again.ok).toBe(false);

    const next = await op<{ classification: Classified["classification"] }>(
      SYS,
      "quality_audits.enqueue",
      {
        deployRunId: await deployRun("staging", 70),
        chatSessionId,
        branch: CONTENT_ONLY,
      },
    );
    expect(next.classification.reasons.map((r) => r.rule)).toEqual(["previous_not_clean"]);
  });

  it("a page error fails the run with the page's reason", async () => {
    const run = await claim();
    const r = await op<{ status: string }>(SYS, "quality_audits.record_result", {
      auditRunId: run?.auditRunId,
      baseUrl: "http://staging.test",
      outcome: {
        kind: "completed",
        checks: NO_CHECKS,
        pages: [pageResult(homeId, {})],
        pageErrors: [
          {
            pageId: aboutId,
            url: "http://staging.test/about/",
            code: "ERRORED_DOCUMENT_REQUEST",
            message: "status 404",
          },
        ],
      },
    });
    expect(r.status).toBe("errored");
    const got = await op<{ run: { errorMessage: string } }>(SYS, "quality_audits.get", {
      auditRunId: run?.auditRunId,
    });
    expect(got.run.errorMessage).toContain("status 404");
  });

  it("a run left running by a dead process is closed as interrupted", async () => {
    await op(SYS, "quality_audits.enqueue", {
      deployRunId: await deployRun("staging", 80),
      chatSessionId: null,
      branch: null,
    });
    const run = await claim();
    await withSql(async (tx) => {
      await tx`UPDATE quality_audit_runs SET started_at = now() - interval '2 hours' WHERE id = ${run?.auditRunId}::uuid`;
    });
    expect(await claim()).toBeNull();
    const got = await op<{ run: { status: string; errorCode: string } }>(
      SYS,
      "quality_audits.get",
      {
        auditRunId: run?.auditRunId,
      },
    );
    expect(got.run).toMatchObject({ status: "errored", errorCode: "interrupted" });
  });
  it("a Stage whose audit was never recorded makes the next Stage audit", async () => {
    await deployRun("staging", 85); // its enqueue "failed": no audit row
    const v = await op<{ status: string; classification: Classified["classification"] }>(
      SYS,
      "quality_audits.enqueue",
      { deployRunId: await deployRun("staging", 86), chatSessionId, branch: CONTENT_ONLY },
    );
    expect(v.status).toBe("queued");
    expect(v.classification.reasons.map((r) => r.label)).toEqual([
      "previous Stage was never audited",
    ]);
    const run = await claim();
    expect((await record(run?.auditRunId as string, [pageResult(homeId, {})])).status).toBe(
      "passed",
    );
  });
});

describe("worker drain", () => {
  it("resolves the staged origin, runs the job and records the result", async () => {
    const deployRunId = await deployRun("staging", 90);
    await op(SYS, "quality_audits.enqueue", { deployRunId, chatSessionId: null, branch: null });
    const server = stagedServer(deployRunId);
    const port = server.port;
    const jobs: AuditJob[] = [];
    try {
      const processed = await drainAuditQueue({
        adapter,
        registry,
        // #727 — a plugin-style findings check, so the page checks run.
        checks: testCheckRegistry(async () => {
          throw new Error("runJob replaces the Lighthouse runner");
        }),
        env: { provider: "self-hosted", stagingBaseUrl: `http://127.0.0.1:${port}` },
        runJob: async (job): Promise<AuditJobResult> => {
          jobs.push(job);
          return {
            ok: true,
            pages: job.pages.map((p) => ({ ...pageResult(p.pageId, {}), url: p.url })),
            pageErrors: [],
          };
        },
      });
      expect(processed).toBe(1);
    } finally {
      server.stop(true);
    }
    // Outside a chat, after a clean audit: just the homepage.
    expect(jobs[0]?.pages.map((p) => p.url)).toEqual([`http://127.0.0.1:${port}/`]);
    const got = await op<{
      run: { status: string; checkSummary: { pagesChecked: number; checkIds: string[] } };
    }>(SYS, "quality_audits.get", { deployRunId });
    expect(got.run.status).toBe("passed");
    // #727 — the page checks read every published page.
    expect(got.run.checkSummary).toMatchObject({ pagesChecked: 2, checkIds: ["test-meta"] });
  });

  it("records an unreachable staging origin as a failed audit", async () => {
    const deployRunId = await deployRun("staging", 100);
    await op(SYS, "quality_audits.enqueue", { deployRunId, chatSessionId: null, branch: null });
    await drainAuditQueue({
      adapter,
      registry,
      env: { provider: "self-hosted", stagingBaseUrl: "http://127.0.0.1:9" },
      runJob: async () => {
        throw new Error("must not run");
      },
    });
    const got = await op<{ run: { status: string; errorCode: string } }>(
      SYS,
      "quality_audits.get",
      { deployRunId },
    );
    expect(got.run).toMatchObject({ status: "errored", errorCode: "staging-unreachable" });
  });
});

describe("read surfaces", () => {
  it("lists acceptances per page and drops them with a deleted page", async () => {
    const all = await op<{ acceptances: { pageId: string; auditId: string | null }[] }>(
      SYS,
      "quality_acceptances.list",
      {},
    );
    // The accepted Accessibility 92 was spent when /about scored 100 again
    // (ratchet): it is revoked, so only the finding acceptance is live.
    expect(all.acceptances.map((a) => a.auditId ?? "score")).toEqual(["image-alt"]);
    const withRevoked = await op<{ acceptances: { revokedAt: string | null }[] }>(
      SYS,
      "quality_acceptances.list",
      { includeRevoked: true },
    );
    expect(withRevoked.acceptances.filter((a) => a.revokedAt !== null)).toHaveLength(1);
    const byQuery = await op<{ acceptances: unknown[] }>(SYS, "quality_acceptances.list", {
      query: "decorative",
    });
    expect(byQuery.acceptances).toHaveLength(1);
    await withSql(async (tx) => {
      await tx`UPDATE pages SET deleted_at = now() WHERE id = ${aboutId}::uuid`;
    });
    const after = await op<{ acceptances: unknown[] }>(SYS, "quality_acceptances.list", {});
    expect(after.acceptances).toEqual([]);
    await withSql(async (tx) => {
      await tx`UPDATE pages SET deleted_at = NULL WHERE id = ${aboutId}::uuid`;
    });
  });

  it("the AI read tools render the findings", async () => {
    const toolCtx = { adapter, registry } as ToolContext;
    const problems = (
      await op<{ runs: { id: string }[] }>(SYS, "quality_audits.list", { status: "problems" })
    ).runs;
    const audit = await getQualityAuditTool.handler(AI, { auditRunId: problems[0]?.id }, toolCtx);
    expect(audit.ok).toBe(true);
    // The newest problems run: /about at Accessibility 94 (worse than the
    // accepted 95, and than its previous audit) with its accepted image-alt
    // finding.
    expect(audit.content).toContain(
      "PROBLEM Accessibility score 94 is below the target 100 — DROPPED since this page's previous audit (95 → 94): check the changes since then first — not good enough",
    );
    expect(audit.content).toContain(
      "ACCEPTED by an editor (does not block; leave it unless asked) failing audit `image-alt`",
    );
    expect(audit.content).toContain("scores (target 100 each)");

    const list = await listQualityAuditsTool.handler(AI, { status: "errored" }, toolCtx);
    // interrupted, timeout, page error, unreachable staging.
    expect(list.content).toMatch(/^quality_audits\[4\]/);

    const acc = await listQualityAcceptancesTool.handler(AI, { filter: "decorative" }, toolCtx);
    expect(acc.content).toContain("image-alt");
  });

  it("the AI may read but not drive the lifecycle", async () => {
    expect((await execute(registry, adapter, AI, "quality_audits.list", {})).ok).toBe(true);
    // quality_audits.enqueue is AI-scoped since issue #620 (the AI's Stage
    // flow enqueues the audit of its own build; no tool exposes its input).
    for (const [name, input] of [
      ["quality_audits.claim_next", {}],
      [
        "quality_audits.record_result",
        {
          auditRunId: "00000000-0000-4000-8000-000000000001",
          baseUrl: null,
          outcome: { kind: "failed", code: "x", message: "y" },
        },
      ],
    ] as const) {
      const r = await execute(registry, adapter, AI, name, input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("ActorScopeRejected");
    }
  });
});

describe("data deleted while an audit runs", () => {
  async function publishedPage(slug: string): Promise<string> {
    return (
      await op<{ pageId: string }>(SYS, "pages.create", {
        slug: `${PFX}${slug}`,
        title: slug,
        templateId,
        status: "published",
      })
    ).pageId;
  }

  async function hardDelete(pageId: string): Promise<void> {
    await withSql(async (tx) => {
      await tx`DELETE FROM pages WHERE id = ${pageId}::uuid`;
    });
  }

  it("drops pages deleted outright and still settles the run", async () => {
    const goneId = await publishedPage("gone");
    await op(SYS, "quality_audits.enqueue", {
      deployRunId: await deployRun("staging", 200),
      chatSessionId: null,
      branch: null,
      pageIds: [goneId],
    });
    const run = await claim();
    expect(run?.pages.map((p) => p.pageId)).toEqual([homeId, goneId]);
    await hardDelete(goneId);
    const r = await record(run?.auditRunId as string, [
      pageResult(homeId, {}),
      pageResult(goneId, { accessibility: 50 }),
    ]);
    expect(r).toEqual({ status: "passed", problemCount: 0 });
  });

  it("every page gone → errored, with a next step", async () => {
    const goneId = await publishedPage("gone2");
    await op(SYS, "quality_audits.enqueue", {
      deployRunId: await deployRun("staging", 210),
      chatSessionId: null,
      branch: null,
      pageIds: [goneId],
    });
    const run = await claim();
    await hardDelete(goneId);
    await hardDelete(homeId);
    const r = await record(run?.auditRunId as string, [
      pageResult(homeId, {}),
      pageResult(goneId, {}),
    ]);
    expect(r.status).toBe("errored");
    const got = await op<{ run: { errorCode: string; errorMessage: string } }>(
      SYS,
      "quality_audits.get",
      { auditRunId: run?.auditRunId },
    );
    expect(got.run.errorCode).toBe("pages-deleted");
    expect(got.run.errorMessage).toContain("Stage again");
  });

  it("a run deleted with its deploy run is discarded, not an error", async () => {
    const deployRunId = await deployRun("staging", 220);
    await op(SYS, "quality_audits.enqueue", {
      deployRunId,
      chatSessionId: null,
      branch: null,
      pageIds: [aboutId],
    });
    const run = await claim();
    await withSql(async (tx) => {
      await tx`DELETE FROM deploy_runs WHERE id = ${deployRunId}::uuid`;
    });
    expect(await record(run?.auditRunId as string, [pageResult(aboutId, {})])).toEqual({
      status: "discarded",
      problemCount: 0,
    });
  });
});
