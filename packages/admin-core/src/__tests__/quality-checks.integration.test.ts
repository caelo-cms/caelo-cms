// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 PR A — the check framework end to end, against a real Postgres
 * and real self-hosted staging builds (served to the worker on a loopback
 * port, provider "aws"). Lighthouse is faked; the page checks are real.
 *
 *   - a findings check registered as a plugin would (the test-only
 *     placeholder-description check; core ships none) reads EVERY page of
 *     the staged build; its error blocks Publish live and reaches the
 *     chat's fix offer;
 *   - an SEO-only Stage runs the page checks (not Lighthouse) and the fixed
 *     description opens the gate;
 *   - the per-rule ratchet: acceptances (page and site-wide) cover the
 *     errors measured, a new error blocks again, fewer errors tighten the
 *     accepted count, none revokes it;
 *   - a check contributed to the registry that throws fails the audit
 *     loudly (publish anyway on offer), and leaves acceptances alone.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { setDeployBridge } from "../ops/deploy.js";
import { sampleMetrics } from "../quality/__tests__/fixtures/sample-metrics.js";
import { drainAuditQueue } from "../quality/audit-worker.js";
import {
  PLACEHOLDER_RULE,
  testCheckRegistry,
} from "../quality/checks/__tests__/fixtures/test-checks.js";
import { linkSourcesFromOps, referenceSourcesFromOps } from "../quality/checks/links-sources.js";
import { type CheckRegistry, createCoreCheckRegistry } from "../quality/checks/registry.js";
import { structureSourcesFromOps } from "../quality/checks/structure-sources.js";
import type { AuditJob } from "../quality/lighthouse-protocol.js";
import type { AuditJobResult } from "../quality/lighthouse-runner.js";
import { localBuildSource } from "../quality/staged-origin.js";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const OWNER_ID = crypto.randomUUID();
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "qc-727" };
const HUMAN: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "qc-727" };
const AI: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "ai", requestId: "qc-727" };
const PFX = "qc727-";
const RULE = PLACEHOLDER_RULE;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prev: Record<string, string | undefined> = {};
let restoreBase: (() => Promise<void>) | null = null;
let restoreLang: (() => Promise<void>) | null = null;
let homeId: string;
let aboutId: string;

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
    await tx`DELETE FROM quality_pending_actions`;
    await tx`DELETE FROM quality_acceptances`;
    await tx`DELETE FROM quality_baselines`;
    await tx`DELETE FROM quality_audit_runs`;
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM chat_entity_locks WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home')`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home')`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home'`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM user_roles WHERE user_id = ${OWNER_ID}::uuid`;
    await tx`DELETE FROM users WHERE id = ${OWNER_ID}::uuid`;
  });
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

const cleanLighthouse = async (job: AuditJob): Promise<AuditJobResult> => ({
  ok: true,
  pages: job.pages.map((p) => ({
    pageId: p.pageId,
    url: p.url,
    measurement: {
      scores: { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 },
      failingAudits: [],
      metrics: sampleMetrics(),
    },
    performanceRuns: [100, 100, 100],
  })),
  pageErrors: [],
});

const noLighthouse = async (): Promise<AuditJobResult> => {
  throw new Error("this Stage must not run Lighthouse");
};

/** Run the worker over the queue (the real audit-worker path). */
async function audit(
  runJob: (job: AuditJob) => Promise<AuditJobResult>,
  checks?: CheckRegistry,
): Promise<void> {
  await drainAuditQueue({
    adapter,
    registry,
    runJob,
    checks: checks ?? testCheckRegistry(runJob),
    env: {
      provider: "aws",
      loopbackSource: (run) =>
        localBuildSource(join(testRoot, "output", "staging", "builds", run.deployRunId)),
    },
  });
}

/** The Stage flow of a chat: classify → merge → build → finalize → enqueue. */
async function stage(chatSessionId: string): Promise<{ runId: string; auditNeeded: boolean }> {
  const { headerIds, ...branch } = await op<{ headerIds: string[] }>(
    HUMAN,
    "quality_audits.classify_stage",
    { chatSessionId },
  );
  const merged = await op<{ mergedAt: string; mergedHeaderIds: string[] }>(
    HUMAN,
    "chat.merge_to_main",
    { chatSessionId, deferConsume: true, headerIds },
  );
  const built = await op<{ runId: string }>(HUMAN, "deploy.trigger", {
    targetName: "staging",
    repoRoot: testRoot,
  });
  await op(HUMAN, "chat.finalize_stage", {
    chatSessionId,
    stagedAt: merged.mergedAt,
    headerIds: merged.mergedHeaderIds,
  });
  const q = await op<{ classification: { auditNeeded: boolean } }>(
    HUMAN,
    "quality_audits.enqueue",
    { deployRunId: built.runId, chatSessionId, branch, stagedBy: "operator" },
  );
  return { runId: built.runId, auditNeeded: q.classification.auditNeeded };
}

interface AuditRead {
  run: {
    id: string;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
    problemCount: number;
    checkSummary: { pagesChecked: number; checkIds: string[] } | null;
  };
  pages: {
    pageId: string;
    problems: { kind: string; ruleId?: string; count?: number }[];
    checkFindings: { ruleId: string; severity: string }[];
  }[];
  checks: { siteProblems: { ruleId: string }[]; errors: { checkId: string | null }[] } | null;
}

async function gate(): Promise<{
  open: boolean;
  state: string;
  message: string;
  canPublishAnyway: boolean;
}> {
  const g = await op<{
    gate: { open: boolean; state: string; message: string; canPublishAnyway: boolean };
  }>(HUMAN, "quality_audits.gate_status", {});
  return g.gate;
}

async function newChat(title: string): Promise<string> {
  return (
    await op<{ chatSessionId: string }>(HUMAN, "chat.create_session", {
      isolation: "experiment",
      title: `${PFX}${title}`,
    })
  ).chatSessionId;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  await wipe();
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 'qc owner')
             ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
  });
  restoreBase = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreLang = await pinSiteLanguage(ADMIN_URL as string, "en");
  testRoot = await mkdtemp(join(tmpdir(), "caelo-quality-checks-"));
  prev = {
    CAELO_SKIP_STAGING_SERVE_CHECK: process.env.CAELO_SKIP_STAGING_SERVE_CHECK,
    CAELO_OUTPUT_ROOT: process.env.CAELO_OUTPUT_ROOT,
  };
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  process.env.CAELO_OUTPUT_ROOT = testRoot;

  const { templateId } = await op<{ templateId: string }>(HUMAN, "templates.create", {
    pageType: "home",
    slug: `${PFX}tpl`,
    displayName: "T",
    html: `<!doctype html><html lang="en"><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  await op(HUMAN, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  homeId = (
    await op<{ pageId: string }>(HUMAN, "pages.create", {
      slug: "home",
      title: "Home",
      templateId,
      status: "published",
    })
  ).pageId;
  aboutId = (
    await op<{ pageId: string }>(HUMAN, "pages.create", {
      slug: `${PFX}about`,
      title: "About",
      templateId,
      status: "published",
    })
  ).pageId;
  // Builds refuse pages without a description (#730). /about has a real
  // one; the homepage still carries a placeholder the test check flags.
  await op(HUMAN, "pages_seo.set", {
    pageId: aboutId,
    metaDescription: "Who we are and what we do.",
  });
  await op(HUMAN, "pages_seo.set", { pageId: homeId, metaDescription: "TODO: write this" });
});

afterAll(async () => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await wipe();
  await restoreBase?.();
  await restoreLang?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("the page checks run on every Stage, on every page", () => {
  let chatSessionId: string;

  it("a page-check error blocks Publish live and reaches the fix offer", async () => {
    chatSessionId = await newChat("meta");
    const staged = await stage(chatSessionId);
    // First Stage of the site: Lighthouse runs too.
    expect(staged.auditNeeded).toBe(true);
    await audit(cleanLighthouse);

    const got = await op<AuditRead>(AI, "quality_audits.get", { deployRunId: staged.runId });
    expect(got.run.status).toBe("problems");
    expect(got.run.checkSummary).toMatchObject({ pagesChecked: 2, checkIds: ["test-meta"] });
    const home = got.pages.find((p) => p.pageId === homeId);
    expect(home?.problems).toEqual([
      expect.objectContaining({ kind: "check_rule", ruleId: RULE, count: 1 }),
    ]);
    expect(home?.checkFindings.map((f) => f.ruleId)).toEqual([RULE]);
    // /about: Lighthouse-audited (it is a candidate) but clean.
    expect(got.pages.find((p) => p.pageId === aboutId)?.problems ?? []).toEqual([]);

    const g = await gate();
    expect(g).toMatchObject({ open: false, state: "problems", canPublishAnyway: false });
    expect(g.message).toContain(`/: ${RULE}`);

    const chat = await op<{ feedback: { kind: string; text: string; prompt: string } | null }>(
      HUMAN,
      "quality_audits.chat_status",
      { chatSessionId },
    );
    expect(chat.feedback?.kind).toBe("offer");
    expect(chat.feedback?.text).toContain("Placeholder meta description (1 page(s))");
  });

  it("an SEO-only Stage runs only the page checks, and the fix opens the gate", async () => {
    await op(AI, "pages_seo.set", { pageId: homeId, metaDescription: "Welcome to the site." });
    const staged = await stage(chatSessionId);
    // Nothing renders differently and the previous Lighthouse result was
    // clean: no Lighthouse — the page checks still re-read every page.
    expect(staged.auditNeeded).toBe(false);
    await audit(noLighthouse);
    const got = await op<AuditRead>(AI, "quality_audits.get", { deployRunId: staged.runId });
    expect(got.run).toMatchObject({ status: "passed", problemCount: 0 });
    expect(got.run.checkSummary?.pagesChecked).toBe(2);
    expect(await gate()).toMatchObject({ open: true, state: "clean" });
  });
});

describe("the per-rule ratchet", () => {
  /** Stage outside a chat and record hand-made check findings for it. */
  async function recordFindings(
    findings: { ruleId: string; pageId?: string; severity?: "error" | "warning" }[],
  ): Promise<string> {
    const built = await op<{ runId: string }>(SYS, "deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    await op(SYS, "quality_audits.enqueue", {
      deployRunId: built.runId,
      chatSessionId: null,
      branch: null,
    });
    const claimed = await op<{ run: { auditRunId: string } }>(SYS, "quality_audits.claim_next", {});
    await op(SYS, "quality_audits.record_result", {
      auditRunId: claimed.run.auditRunId,
      baseUrl: "http://staging.test",
      outcome: {
        kind: "completed",
        pages: [],
        pageErrors: [],
        checks: {
          ran: [
            { id: "imgs", title: "Images", scope: "page", source: { kind: "core" } },
            { id: "robots", title: "Robots", scope: "site", source: { kind: "core" } },
          ],
          pages: [
            { pageId: homeId, url: "http://staging.test/" },
            { pageId: aboutId, url: "http://staging.test/about/" },
          ],
          findings: findings.map((f) => ({
            ruleId: f.ruleId,
            severity: f.severity ?? "error",
            ...(f.pageId ? { pageId: f.pageId } : {}),
            message: `Broken: ${f.ruleId}`,
            fix: { tool: "update_modules_many", hint: "fix it" },
          })),
          errors: [],
        },
      },
    });
    return claimed.run.auditRunId;
  }

  const img = (n: number) =>
    Array.from({ length: n }, () => ({ ruleId: "imgs/alt-missing", pageId: homeId }));

  async function acceptances() {
    return (
      await op<{
        acceptances: {
          pagePath: string;
          kind: string;
          auditId: string;
          acceptedCount: number | null;
          revokedAt: string | null;
        }[];
      }>(AI, "quality_acceptances.list", { includeRevoked: true })
    ).acceptances.filter((a) => a.kind === "check");
  }

  it("errors block; warnings never do; site-wide findings are problems of the run", async () => {
    const id = await recordFindings([
      ...img(2),
      { ruleId: "imgs/alt-long", pageId: aboutId, severity: "warning" },
      { ruleId: "robots/blocked" },
    ]);
    const got = await op<AuditRead>(AI, "quality_audits.get", { auditRunId: id });
    expect(got.run).toMatchObject({ status: "problems", problemCount: 2 });
    // The warnings-only page gets a row (findings are reported) but no problem.
    const about = got.pages.find((p) => p.pageId === aboutId);
    expect(about?.problems).toEqual([]);
    expect(about?.checkFindings.map((f) => f.severity)).toEqual(["warning"]);
    expect(got.checks?.siteProblems.map((p) => p.ruleId)).toEqual(["robots/blocked"]);
    expect((await gate()).message).toContain("site-wide: robots/blocked");
  });

  it("an accepted rule covers the errors measured now — on its page, and site-wide", async () => {
    const auditRunId = (await op<{ run: { id: string } }>(AI, "quality_audits.get", {})).run.id;
    const proposal = await op<{ proposalId: string; preview: { accepts: string[] } }>(
      AI,
      "quality_audits.propose_accept",
      {
        auditRunId,
        items: [{ pagePath: "/", ruleId: "imgs/alt-missing" }, { ruleId: "robots/blocked" }],
        reason: "decorative images; robots handled by the CDN",
      },
    );
    expect(proposal.preview.accepts.join(" ")).toContain("2 error(s) accepted");
    // A rule that is not a problem there is refused with what is.
    const wrong = await execute(registry, adapter, AI, "quality_audits.propose_accept", {
      auditRunId,
      items: [{ pagePath: "/", ruleId: "imgs/other" }],
      reason: "typo",
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(JSON.stringify(wrong.error)).toContain("imgs/alt-missing");

    await op(HUMAN, "quality_audits.execute_proposal", { proposalId: proposal.proposalId });
    expect(await gate()).toMatchObject({ open: true, state: "accepted" });
    const rows = await acceptances();
    expect(rows.map((a) => [a.pagePath, a.auditId, a.acceptedCount]).sort()).toEqual([
      ["/", "imgs/alt-missing", 2],
      ["site-wide", "robots/blocked", 1],
    ]);
  });

  it("a NEW error beyond the accepted count blocks again", async () => {
    await recordFindings([...img(3), { ruleId: "robots/blocked" }]);
    const g = await gate();
    expect(g).toMatchObject({ open: false, state: "problems" });
    expect(g.message).toContain("/: imgs/alt-missing (3×)");
    expect(g.message).not.toContain("robots/blocked");
  });

  it("fewer errors tighten the accepted count; none revokes the acceptance", async () => {
    await recordFindings(img(1));
    expect(await gate()).toMatchObject({ open: true });
    const rows = await acceptances();
    const page = rows.find((a) => a.auditId === "imgs/alt-missing" && a.revokedAt === null);
    expect(page?.acceptedCount).toBe(1);
    const site = rows.find((a) => a.auditId === "robots/blocked");
    expect(site?.revokedAt).not.toBeNull();
    // Back to 2: the second error is new again and blocks.
    await recordFindings(img(2));
    expect((await gate()).state).toBe("problems");
  });
});

describe("a broken check", () => {
  it("fails the audit loudly, offers publish anyway, and leaves acceptances alone", async () => {
    const checks = createCoreCheckRegistry({
      lighthouse: noLighthouse,
      structure: structureSourcesFromOps(registry, adapter, SYS),
      links: linkSourcesFromOps(registry, adapter, SYS),
      references: referenceSourcesFromOps(registry, adapter, SYS),
    });
    checks.register(
      {
        id: "flaky",
        title: "A plugin check that throws",
        scope: "site",
        run: () => {
          throw new Error("boom");
        },
      },
      { kind: "plugin", slug: "flaky-plugin" },
    );
    const before = await withSql(
      async (tx) =>
        (await tx`SELECT count(*)::int AS n FROM quality_acceptances WHERE revoked_at IS NULL`) as unknown as {
          n: number;
        }[],
    );
    const built = await op<{ runId: string }>(SYS, "deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    const chatSessionId = await newChat("flaky");
    await op(HUMAN, "quality_audits.enqueue", {
      deployRunId: built.runId,
      chatSessionId,
      branch: {
        classification: { auditNeeded: false, reasons: [], skipped: ["field values: x"] },
        touchedPageIds: [],
      },
    });
    await audit(noLighthouse, checks);
    const got = await op<AuditRead>(AI, "quality_audits.get", { deployRunId: built.runId });
    expect(got.run).toMatchObject({ status: "errored", errorCode: "check-failed" });
    expect(got.run.errorMessage).toContain("check 'flaky' failed: boom");
    expect(got.checks?.errors.map((e) => e.checkId)).toEqual(["flaky"]);
    expect(await gate()).toMatchObject({ open: false, state: "errored", canPublishAnyway: true });
    const after = await withSql(
      async (tx) =>
        (await tx`SELECT count(*)::int AS n FROM quality_acceptances WHERE revoked_at IS NULL`) as unknown as {
          n: number;
        }[],
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});
