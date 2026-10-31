// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 PR 2 — the Publish-live quality gate end to end against a
 * real Postgres and real self-hosted builds:
 *
 *   chat edit → Stage (classify, merge, build, enqueue) → audit (the worker,
 *   loopback origin over the real build archive, fake Lighthouse) →
 *   Publish blocked + chat told → fix → Stage again → audit passes →
 *   Publish live ships.
 *
 * Plus: in-chat acceptances (AI proposes, only a human applies; per page),
 * a failed check (blocked, retry, publish anyway with a recorded reason),
 * the 2-round fix cap, and a never-audited staged build.
 *
 * Lighthouse is faked (the CI test job has no browser); the fake fetches
 * every page through the loopback origin, so the origin is exercised for
 * real. scripts/lighthouse-smoke.ts covers the real browser stack.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { setDeployBridge } from "../ops/deploy.js";
import { sampleMetrics } from "../quality/__tests__/fixtures/sample-metrics.js";
import { drainAuditQueue } from "../quality/audit-worker.js";
import { AUTO_FIX_COST_CAP_MICROCENTS } from "../quality/chat-feedback.js";
import { CheckRegistry } from "../quality/checks/registry.js";
import type { AuditJob } from "../quality/lighthouse-protocol.js";
import type { AuditJobResult } from "../quality/lighthouse-runner.js";
import type { FailingAudit, QualityCategory } from "../quality/ratchet.js";
import { localBuildSource } from "../quality/staged-origin.js";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

// Issue #620 — these chats run on ISOLATED branches (experiments): the
// suite covers the per-branch mechanics isolated chats keep (experiments,
// migrations, pre-draft chats). The shared draft has its own suite
// (shared-draft.integration.test.ts).

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
/** The operator: an Owner (content.write + deploy.trigger) clicking. */
const OWNER_ID = crypto.randomUUID();
/** A reviewer: no content.write, no deploy.trigger. */
const REVIEWER_ID = crypto.randomUUID();
const HUMAN: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "qg-553" };
const REVIEWER: ExecutionContext = {
  actorId: REVIEWER_ID,
  actorKind: "human",
  requestId: "qg-553",
};
const AI: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "ai", requestId: "qg-553" };
const PFX = "qg553-";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prevSkip: string | undefined;
let prevOutputRoot: string | undefined;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLang: (() => Promise<void>) | null = null;
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
    await tx`DELETE FROM quality_pending_actions`;
    await tx`DELETE FROM quality_acceptances`;
    await tx`DELETE FROM quality_audit_runs`;
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM chat_entity_locks WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home')`;
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home')`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home'`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM user_roles WHERE user_id IN (${OWNER_ID}::uuid, ${REVIEWER_ID}::uuid)`;
    await tx`DELETE FROM users WHERE id IN (${OWNER_ID}::uuid, ${REVIEWER_ID}::uuid)`;
  });
}

async function seedUser(id: string, role: "owner" | "reviewer"): Promise<void> {
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${id}::uuid, 'human', ${`qg ${role}`})
             ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${id}::uuid, ${`${id}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${id}::uuid, id FROM roles WHERE name = ${role}`;
  });
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function opErr(ctx: ExecutionContext, name: string, input: unknown): Promise<string> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (r.ok) throw new Error(`${name} unexpectedly succeeded`);
  return JSON.stringify(r.error);
}

/** The /edit Stage flow, op for op (classify → merge → build → finalize → enqueue). */
async function stage(
  chatSessionId: string,
  stagedBy: "operator" | "live_edit_ai" = "operator",
): Promise<{ runId: string; status: string }> {
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
  const q = await op<{ status: string }>(HUMAN, "quality_audits.enqueue", {
    deployRunId: built.runId,
    chatSessionId,
    branch,
    stagedBy,
  });
  return { runId: built.runId, status: q.status };
}

const ALL_100: Record<QualityCategory, number> = {
  performance: 100,
  accessibility: 100,
  "best-practices": 100,
  seo: 100,
};

/** A fake Lighthouse: fetches each page through the loopback origin (so it
 *  must really serve the staged build) and reports what `findings` says. */
function fakeLighthouse(
  findings: (path: string) => {
    scores?: Partial<Record<QualityCategory, number>>;
    failing?: FailingAudit[];
  },
  fetched: string[] = [],
): (job: AuditJob) => Promise<AuditJobResult> {
  return async (job) => {
    const pages = [];
    for (const p of job.pages) {
      const res = await fetch(p.url);
      if (res.status !== 200)
        throw new Error(`loopback origin answered ${res.status} for ${p.url}`);
      const path = new URL(p.url).pathname;
      fetched.push(path);
      const f = findings(path);
      const scores = { ...ALL_100, ...(f.scores ?? {}) };
      pages.push({
        pageId: p.pageId,
        url: p.url,
        measurement: { scores, failingAudits: f.failing ?? [], metrics: sampleMetrics() },
        performanceRuns: [scores.performance, scores.performance, scores.performance],
      });
    }
    return { ok: true, pages, pageErrors: [] };
  };
}

/** These tests are about Lighthouse's gate; the page checks (#727) have
 *  their own suite (quality-checks.integration.test.ts). */
const LIGHTHOUSE_ONLY = new CheckRegistry();
LIGHTHOUSE_ONLY.registerLighthouse(async () => {
  throw new Error("the test's runJob replaces the Lighthouse runner");
});

async function audit(runJob: (job: AuditJob) => Promise<AuditJobResult>): Promise<void> {
  await drainAuditQueue({
    adapter,
    registry,
    checks: LIGHTHOUSE_ONLY,
    runJob,
    // aws: no staging URL → the loopback origin over this process's build.
    env: {
      provider: "aws",
      loopbackSource: (run) =>
        localBuildSource(join(testRoot, "output", "staging", "builds", run.deployRunId)),
    },
  });
}

const imageAlt: FailingAudit = {
  id: "image-alt",
  title: "Image elements do not have [alt] attributes",
  score: 0,
  categories: ["accessibility", "seo"],
};
const contrast: FailingAudit = {
  id: "color-contrast",
  title: "Background and foreground colors do not have a sufficient contrast ratio",
  score: 0,
  categories: ["accessibility"],
  elements: [
    {
      selector: "header > a.cta",
      snippet: '<a class="cta" href="/signup">',
      explanation:
        "Element has insufficient color contrast of 2.9 (foreground color: #ffffff, background color: #8b8bf5)",
    },
  ],
};

async function promote(): Promise<{ ok: boolean; message: string }> {
  const r = await execute(registry, adapter, HUMAN, "deploy.promote", {
    fromTarget: "staging",
    toTarget: "production",
    repoRoot: testRoot,
  });
  return { ok: r.ok, message: r.ok ? "" : JSON.stringify(r.error) };
}

async function gate(): Promise<{ open: boolean; state: string; auditRunId: string | null }> {
  return (
    await op<{ gate: { open: boolean; state: string; auditRunId: string | null } }>(
      AI,
      "quality_audits.gate_status",
      {},
    )
  ).gate;
}

async function editModule(branch: ExecutionContext, html: string): Promise<void> {
  await op(branch, "modules.update", { moduleId, html });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  await wipe();
  await seedUser(OWNER_ID, "owner");
  await seedUser(REVIEWER_ID, "reviewer");
  restoreBase = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreLang = await pinSiteLanguage(ADMIN_URL as string, "en");
  testRoot = await mkdtemp(join(tmpdir(), "caelo-quality-gate-"));
  prevSkip = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  // publish_anyway runs deploy.promote with the process's output root (no
  // per-call repoRoot), like the admin does in production.
  prevOutputRoot = process.env.CAELO_OUTPUT_ROOT;
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
  moduleId = (
    await op<{ moduleId: string }>(HUMAN, "modules.create", {
      slug: `${PFX}card`,
      displayName: "Card",
      html: "<p>v0</p>",
    })
  ).moduleId;
  for (const slug of ["home", `${PFX}about`]) {
    const { pageId } = await op<{ pageId: string }>(HUMAN, "pages.create", {
      slug,
      title: slug,
      templateId,
      status: "published",
    });
    await op(HUMAN, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    // Builds refuse published pages without a meta description.
    await op(HUMAN, "pages_seo.autofill", { pageId, metaDescription: `The ${slug} page.` });
  }
});

afterAll(async () => {
  if (prevSkip === undefined) delete process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  else process.env.CAELO_SKIP_STAGING_SERVE_CHECK = prevSkip;
  if (prevOutputRoot === undefined) delete process.env.CAELO_OUTPUT_ROOT;
  else process.env.CAELO_OUTPUT_ROOT = prevOutputRoot;
  await wipe();
  await restoreBase?.();
  await restoreLang?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("block → fix → publish", () => {
  let chatSessionId: string;
  let branch: ExecutionContext;

  it("a staged build without a finished audit cannot go live", async () => {
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      {
        isolation: "experiment",
        title: `${PFX}fix-loop`,
      },
    );
    chatSessionId = s.chatSessionId;
    branch = { ...HUMAN, chatBranchId: s.chatBranchId };
    await editModule(branch, `<p>v1 <img src="/x.png"></p>`);
    expect((await stage(chatSessionId)).status).toBe("queued");
    const p = await promote();
    expect(p.ok).toBe(false);
    expect(p.message).toContain("until the quality check of the staged build finishes");
  });

  it("problems block Publish live and OFFER the operator an AI fix (round 1 of 2)", async () => {
    const fetched: string[] = [];
    await audit(
      fakeLighthouse((path) => (path.includes("about") ? { failing: [imageAlt] } : {}), fetched),
    );
    // The loopback origin served the real staged build.
    expect(fetched).toEqual(["/", `/${PFX}about/`]);
    expect(existsSync(join(testRoot, "output", "production", "current", "index.html"))).toBe(false);
    const p = await promote();
    expect(p.ok).toBe(false);
    expect(p.message).toContain("image-alt");
    expect(p.message).toContain("Stage again");

    const st = await op<{
      feedback: {
        kind: string;
        text: string;
        actionLabel: string;
        prompt: string;
        groups: { key: string; pages: { pagePath: string }[] }[];
      };
      audit: { id: string; fixRound: number; stagedBy: string | null };
    }>(HUMAN, "quality_audits.chat_status", { chatSessionId });
    expect(st.audit.fixRound).toBe(0);
    // #685 — problems are an offer the operator answers, never a turn the
    // panel sends by itself; the prompt carries the findings and who staged.
    // #727 — grouped by rule across pages.
    expect(st.audit.stagedBy).toBe("operator");
    expect(st.feedback.kind).toBe("offer");
    expect(st.feedback.actionLabel).toBe("Fix all with AI");
    expect(st.feedback.text).toContain("Image elements do not have [alt] attributes (1 page(s))");
    expect(st.feedback.text).toContain("Staged by you.");
    expect(st.feedback.text).toContain("Let the AI fix them");
    expect(st.feedback.groups).toEqual([
      expect.objectContaining({
        key: "lighthouse/accessibility/image-alt",
        pages: [expect.objectContaining({ pagePath: `/${PFX}about` })],
      }),
    ]);
    expect(st.feedback.prompt).toContain("Fix round 1:");
    expect(st.feedback.prompt).toContain(
      `- lighthouse/accessibility/image-alt — Image elements do not have [alt] attributes: 1 page(s) (/${PFX}about)`,
    );
    expect(st.feedback.prompt).toContain("I staged this build myself");
    // The chat is told exactly once: one tab holds the delivery lease; the
    // ack (after the operator's click sent the turn) marks it delivered.
    const auditRunId = st.audit.id;
    const claim = () =>
      op<{ claimed: boolean }>(HUMAN, "quality_audits.claim_chat_notification", {
        auditRunId,
        fixScope: "all",
      });
    const fixRequested = () =>
      withSql(
        async (tx) =>
          (
            (await tx`SELECT fix_requested_at IS NOT NULL AS r FROM quality_audit_runs
                      WHERE id = ${auditRunId}::uuid`) as unknown as { r: boolean }[]
          )[0]?.r,
      );
    expect(await fixRequested()).toBe(false);
    expect((await claim()).claimed).toBe(true);
    expect((await claim()).claimed).toBe(false);
    // A click whose turn did not start (an external agent works in the
    // chat) gives the claim back: the card can be clicked again at once.
    expect(await fixRequested()).toBe(true);
    await op(HUMAN, "quality_audits.release_chat_notification", { auditRunId });
    expect(await fixRequested()).toBe(false);
    expect((await claim()).claimed).toBe(true);
    expect(await fixRequested()).toBe(true);
    expect(await opErr(AI, "quality_audits.release_chat_notification", { auditRunId })).toContain(
      "ActorScopeRejected",
    );
    // A delivery that never acknowledged (tab closed) is offered again once
    // the lease ran out.
    await withSql(async (tx) => {
      await tx`UPDATE quality_audit_runs SET chat_notify_claimed_at = now() - interval '5 minutes'
               WHERE id = ${auditRunId}::uuid`;
    });
    expect((await claim()).claimed).toBe(true);
    await op(HUMAN, "quality_audits.ack_chat_notification", { auditRunId });
    const after = await op<{ notified: boolean }>(HUMAN, "quality_audits.chat_status", {
      chatSessionId,
    });
    expect(after.notified).toBe(true);
    await withSql(async (tx) => {
      await tx`UPDATE quality_audit_runs SET chat_notify_claimed_at = NULL WHERE id = ${auditRunId}::uuid`;
    });
    expect((await claim()).claimed).toBe(false);
  });

  it("the fix is re-staged (round 1), the audit passes, and Publish live ships", async () => {
    await editModule(branch, `<p>v2 <img src="/x.png" alt="Product photo"></p>`);
    expect((await stage(chatSessionId)).status).toBe("queued");
    await audit(fakeLighthouse(() => ({})));
    const st = await op<{
      audit: { status: string; fixRound: number };
      feedback: { kind: string };
    }>(HUMAN, "quality_audits.chat_status", { chatSessionId });
    expect(st.audit).toMatchObject({ status: "passed", fixRound: 1 });
    expect(st.feedback.kind).toBe("note");
    // A status note is appended and marked delivered in one transaction.
    expect(
      (
        await op<{ claimed: boolean }>(HUMAN, "quality_audits.claim_chat_notification", {
          auditRunId: (st.audit as unknown as { id: string }).id,
          note: { chatSessionId, text: (st.feedback as unknown as { text: string }).text },
        })
      ).claimed,
    ).toBe(true);
    const notes = await withSql(
      async (tx) =>
        (await tx`SELECT content FROM chat_messages WHERE chat_session_id = ${chatSessionId}::uuid
                  AND origin = 'system'`) as unknown as { content: string }[],
    );
    expect(notes.map((n) => n.content)).toContain(
      (st.feedback as unknown as { text: string }).text,
    );
    expect(await gate()).toMatchObject({ open: true, state: "clean" });
    const p = await promote();
    expect(p).toEqual({ ok: true, message: "" });
    expect(existsSync(join(testRoot, "output", "production", "current", "index.html"))).toBe(true);
  });
});

describe("acceptances in the chat", () => {
  let chatSessionId: string;
  let auditRunId: string;

  it("problems the editor accepts stop blocking — only on their page", async () => {
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      {
        isolation: "experiment",
        title: `${PFX}accept`,
      },
    );
    chatSessionId = s.chatSessionId;
    await editModule({ ...HUMAN, chatBranchId: s.chatBranchId }, "<p>brand grey</p>");
    await stage(chatSessionId);
    await audit(
      fakeLighthouse((path) =>
        path.includes("about") ? { scores: { accessibility: 92 }, failing: [contrast] } : {},
      ),
    );
    auditRunId = (await gate()).auditRunId as string;
    expect((await gate()).state).toBe("problems");
    const offered = await op<{ feedback: { kind: string } | null }>(
      HUMAN,
      "quality_audits.chat_status",
      { chatSessionId },
    );
    expect(offered.feedback?.kind).toBe("offer");

    // A finding that is not a problem of the audit is refused with the list.
    expect(
      await opErr(AI, "quality_audits.propose_accept", {
        auditRunId,
        items: [{ pagePath: "/", auditId: "color-contrast" }],
        reason: "brand colour",
      }),
    ).toContain("is not a problem on /");

    const proposal = await op<{ proposalId: string; preview: { accepts: string[] } }>(
      AI,
      "quality_audits.propose_accept",
      {
        auditRunId,
        items: [
          { pagePath: `/${PFX}about`, auditId: "color-contrast" },
          { pagePath: `/${PFX}about`, category: "accessibility" },
        ],
        reason: "brand grey is the approved corporate colour",
      },
    );
    expect(proposal.preview.accepts).toHaveLength(2);
    const pending = await op<{ items: { domain: string }[] }>(AI, "pending_proposals.list", {});
    expect(pending.items.some((i) => i.domain === "quality")).toBe(true);

    // The AI cannot apply its own proposal, nor can a user without
    // content.write (the card applies as the chat's operator, so the op
    // itself checks the permission).
    expect(
      await opErr(AI, "quality_audits.execute_proposal", { proposalId: proposal.proposalId }),
    ).toContain("ActorScopeRejected");
    expect(
      await opErr(REVIEWER, "quality_audits.execute_proposal", {
        proposalId: proposal.proposalId,
      }),
    ).toContain("content.write");
    // The editor's click applies it.
    expect(
      await op<{ accepted: number }>(HUMAN, "quality_audits.execute_proposal", {
        proposalId: proposal.proposalId,
      }),
    ).toMatchObject({ kind: "accept", accepted: 2 });
    expect(await gate()).toMatchObject({ open: true, state: "accepted" });
    // #685 — nothing left to fix: the offer becomes a status note.
    const settled = await op<{ feedback: { kind: string; text: string } | null }>(
      HUMAN,
      "quality_audits.chat_status",
      { chatSessionId },
    );
    expect(settled.feedback).toMatchObject({ kind: "note" });
    expect(settled.feedback?.text).toContain("every remaining finding is accepted");

    // #727 — each acceptance records the value it accepted.
    const acc = await op<{
      acceptances: { kind: string; auditId: string | null; acceptedScore: number | null }[];
    }>(AI, "quality_acceptances.list", {});
    expect(acc.acceptances.map((a) => [a.kind, a.auditId, a.acceptedScore]).sort()).toEqual([
      ["finding", "color-contrast", 0],
      ["score", null, 92],
    ]);
  });

  it("an acceptance proposed for an older audit cannot be applied after a newer one", async () => {
    // Propose against the current audit, then a new Stage replaces it.
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      {
        isolation: "experiment",
        title: `${PFX}stale`,
      },
    );
    await editModule({ ...HUMAN, chatBranchId: s.chatBranchId }, "<p>stale-1</p>");
    await stage(s.chatSessionId);
    await audit(fakeLighthouse(() => ({ failing: [imageAlt] })));
    const old = (await gate()).auditRunId as string;
    const stale = await op<{ proposalId: string }>(AI, "quality_audits.propose_accept", {
      auditRunId: old,
      items: [{ pagePath: "/", auditId: "image-alt" }],
      reason: "decorative",
    });
    await editModule({ ...HUMAN, chatBranchId: s.chatBranchId }, "<p>stale-2</p>");
    await stage(s.chatSessionId);
    await audit(fakeLighthouse(() => ({})));
    expect(
      await opErr(HUMAN, "quality_audits.execute_proposal", { proposalId: stale.proposalId }),
    ).toContain("not the current quality check");
    const rows = await withSql(
      async (tx) =>
        (await tx`SELECT status FROM quality_pending_actions WHERE id = ${stale.proposalId}::uuid`) as unknown as {
          status: string;
        }[],
    );
    expect(rows[0]?.status).toBe("superseded");
    // And proposing against a stale audit is refused up front.
    expect(
      await opErr(AI, "quality_audits.propose_accept", {
        auditRunId: old,
        items: [{ pagePath: "/", auditId: "image-alt" }],
        reason: "decorative",
      }),
    ).toContain("not the current quality check");
  });

  it("the about page scoring 100 again spends its accepted drop (ratchet)", async () => {
    const live = await withSql(
      async (tx) =>
        (await tx`SELECT a.revoked_at FROM quality_acceptances a JOIN pages p ON p.id = a.page_id
                  WHERE p.slug = ${`${PFX}about`} AND a.kind = 'score'`) as unknown as {
          revoked_at: Date | null;
        }[],
    );
    // The clean audit above measured accessibility 100 > accepted 92.
    expect(live.every((r) => r.revoked_at !== null)).toBe(true);
  });

  it("the same finding on another page still blocks", async () => {
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      {
        isolation: "experiment",
        title: `${PFX}accept-2`,
      },
    );
    await editModule({ ...HUMAN, chatBranchId: s.chatBranchId }, "<p>brand grey 2</p>");
    await stage(s.chatSessionId);
    await audit(fakeLighthouse(() => ({ failing: [contrast] })));
    const p = await promote();
    expect(p.ok).toBe(false);
    expect(p.message).toContain("/: color-contrast");
    expect(p.message).not.toContain(`/${PFX}about: color-contrast`);
    // The AI reads WHICH element fails and why, so it can fix the right
    // module instead of guessing (live run: "the audit tool doesn't name the
    // exact failing element/selector").
    const read = await createDefaultToolRegistry().dispatch(
      "get_quality_audit",
      {},
      { ...AI, chatBranchId: s.chatBranchId },
      { adapter, registry, chatSessionId: s.chatSessionId },
    );
    expect(read.ok).toBe(true);
    expect(read.content).toContain("element `header > a.cta`");
    // The staged markup is quoted as code, never live HTML in the chat
    // (a bare <img src="/_assets/…"> made the operator's browser 404).
    expect(read.content).toContain('`<a class="cta" href="/signup">`');
    expect(read.content).toContain("insufficient color contrast of 2.9");
  });
});

describe("a failed quality check", () => {
  let chatSessionId: string;

  it("blocks by default, tells the chat, and can be retried", async () => {
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      {
        isolation: "experiment",
        title: `${PFX}errored`,
      },
    );
    chatSessionId = s.chatSessionId;
    await editModule({ ...HUMAN, chatBranchId: s.chatBranchId }, "<p>v-err</p>");
    await stage(chatSessionId);
    const timeout = async (): Promise<AuditJobResult> => ({
      ok: false,
      failure: { code: "timeout", message: "Lighthouse audit exceeded 210 s and was stopped" },
    });
    await audit(timeout);
    const g = await op<{ gate: { state: string; canPublishAnyway: boolean; message: string } }>(
      HUMAN,
      "quality_audits.gate_status",
      {},
    );
    expect(g.gate).toMatchObject({ state: "errored", canPublishAnyway: true });
    expect((await promote()).message).toContain("the quality check failed (timeout");
    const st = await op<{ feedback: { kind: string; text: string } }>(
      HUMAN,
      "quality_audits.chat_status",
      { chatSessionId },
    );
    expect(st.feedback).toMatchObject({ kind: "note" });
    expect(st.feedback.text).toContain("Quality check failed: Lighthouse audit exceeded");

    // Retry re-runs the same audit (also routine for the AI).
    const retry = await op<{ auditRunId: string; status: string }>(AI, "quality_audits.retry", {});
    expect(retry.status).toBe("queued");
    expect(await opErr(AI, "quality_audits.retry", {})).toContain("still running");
    await audit(timeout);
    expect((await gate()).state).toBe("errored");
  });

  it("only a human may publish anyway — recorded with actor and reason", async () => {
    const auditRunId = (await gate()).auditRunId as string;
    expect(
      await opErr(AI, "quality_audits.publish_anyway", { auditRunId, reason: "deadline" }),
    ).toContain("ActorScopeRejected");
    expect(
      await opErr(REVIEWER, "quality_audits.publish_anyway", { auditRunId, reason: "deadline" }),
    ).toContain("deploy.trigger");
    // The AI proposes; the editor's click on the card publishes.
    const proposal = await op<{ proposalId: string }>(AI, "quality_audits.propose_publish_anyway", {
      auditRunId,
      reason: "launch deadline, the checker is down",
    });
    // #1225 — a publish that fails after its run started records no
    // override and no audit event, and leaves the card approvable: the
    // decision is written in the transaction that records the published run.
    const overrideTrail = async () =>
      (
        (await withSql(
          async (tx) =>
            (await tx`SELECT count(*)::int AS n FROM audit_events
                      WHERE operation = 'quality_audits.publish_anyway' AND entity_id = ${auditRunId}`) as unknown as {
              n: number;
            }[],
        )) as { n: number }[]
      )[0]?.n;
    const prevProvider = process.env.CAELO_PROVIDER;
    process.env.CAELO_PROVIDER = "no-such-provider";
    try {
      expect(
        await opErr(HUMAN, "quality_audits.publish_anyway", { auditRunId, reason: "deadline" }),
      ).toContain("promotion failed");
      expect(
        await opErr(HUMAN, "quality_audits.execute_proposal", { proposalId: proposal.proposalId }),
      ).toContain("promotion failed");
    } finally {
      if (prevProvider === undefined) delete process.env.CAELO_PROVIDER;
      else process.env.CAELO_PROVIDER = prevProvider;
    }
    expect(await gate()).toMatchObject({ open: false, state: "errored" });
    expect(
      (await op<{ run: { publishOverride: unknown } }>(AI, "quality_audits.get", { auditRunId }))
        .run.publishOverride,
    ).toBeNull();
    expect(await overrideTrail()).toBe(0);
    const pendingRow = (await withSql(
      async (tx) =>
        (await tx`SELECT status, claimed_at FROM quality_pending_actions
                  WHERE id = ${proposal.proposalId}::uuid`) as unknown as {
          status: string;
          claimed_at: string | null;
        }[],
    )) as { status: string; claimed_at: string | null }[];
    expect(pendingRow[0]).toMatchObject({ status: "pending", claimed_at: null });
    // The decision is re-checked right before the release: a check that is
    // no longer the failed one of the staged build releases nothing.
    const staged = (await withSql(
      async (tx) =>
        (await tx`SELECT deploy_run_id::text AS id FROM quality_audit_runs
                  WHERE id = ${auditRunId}::uuid`) as unknown as { id: string }[],
    )) as { id: string }[];
    expect(
      await opErr(HUMAN, "deploy.recheck_publish_anyway", {
        fromRunId: staged[0]?.id,
        auditRunId: crypto.randomUUID(),
      }),
    ).toContain("no longer the failed check");
    expect(
      await op(HUMAN, "deploy.recheck_publish_anyway", { fromRunId: staged[0]?.id, auditRunId }),
    ).toEqual({});
    const applied = await op<{ kind: string; toRunId: string }>(
      HUMAN,
      "quality_audits.execute_proposal",
      { proposalId: proposal.proposalId },
    );
    expect(applied.kind).toBe("publish_anyway");
    expect(await gate()).toMatchObject({ open: true, state: "overridden" });
    const run = await op<{ run: { publishOverride: { by: string; reason: string } | null } }>(
      AI,
      "quality_audits.get",
      { auditRunId },
    );
    expect(run.run.publishOverride).toMatchObject({
      by: OWNER_ID,
      reason: "launch deadline, the checker is down",
    });
    const trail = await withSql(
      async (tx) =>
        (await tx`SELECT count(*)::int AS n FROM audit_events
                  WHERE operation = 'quality_audits.publish_anyway' AND entity_id = ${auditRunId}`) as unknown as {
          n: number;
        }[],
    );
    expect(trail[0]?.n).toBe(1);
  });

  it("publish anyway never applies to real problems", async () => {
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      {
        isolation: "experiment",
        title: `${PFX}not-errored`,
      },
    );
    await editModule({ ...HUMAN, chatBranchId: s.chatBranchId }, "<p>v-prob</p>");
    await stage(s.chatSessionId);
    await audit(fakeLighthouse(() => ({ failing: [imageAlt] })));
    const auditRunId = (await gate()).auditRunId as string;
    expect(
      await opErr(AI, "quality_audits.propose_publish_anyway", { auditRunId, reason: "please" }),
    ).toContain("only for a failed quality check");
    expect(
      await opErr(HUMAN, "quality_audits.publish_anyway", { auditRunId, reason: "please" }),
    ).toContain("only applies to a FAILED quality check");
  });
});

describe("fix-all loop (#771)", () => {
  it("one 'Fix all with AI' continues while each round gets closer, then asks again", async () => {
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      { isolation: "experiment", title: `${PFX}loop` },
    );
    const branch = { ...HUMAN, chatBranchId: s.chatBranchId };
    // Round by round: what the AI's re-Stage measures (and who staged it).
    const rounds: { by: "operator" | "live_edit_ai"; performance: number }[] = [
      { by: "operator", performance: 80 },
      { by: "live_edit_ai", performance: 90 }, // closer: continues on its own
      { by: "live_edit_ai", performance: 90 }, // no closer: stops and asks
    ];
    const offers: { autoContinue: boolean; actionLabel: string; text: string; prompt: string }[] =
      [];
    for (const [i, round] of rounds.entries()) {
      await editModule(branch, `<p>try ${i}</p>`);
      await stage(s.chatSessionId, round.by);
      await audit(fakeLighthouse(() => ({ scores: { performance: round.performance } })));
      const st = await op<{
        audit: { id: string; fixRound: number };
        feedback: {
          kind: string;
          prompt: string;
          actionLabel: string;
          text: string;
          autoContinue: boolean;
        };
      }>(HUMAN, "quality_audits.chat_status", { chatSessionId: s.chatSessionId });
      expect(st.audit.fixRound).toBe(i);
      expect(st.feedback.kind).toBe("offer");
      offers.push(st.feedback);
      // The operator's click on the first card; the panel's own send after.
      await op(HUMAN, "quality_audits.claim_chat_notification", {
        auditRunId: st.audit.id,
        fixScope: "all",
      });
    }
    expect(offers.map((o) => o.autoContinue)).toEqual([false, true, false]);
    expect(offers.map((o) => o.actionLabel)).toEqual([
      "Fix all with AI",
      "Fix all with AI",
      "Keep fixing with AI",
    ]);
    expect(offers[1]?.text).toContain("keeps fixing on its own");
    expect(offers[2]?.text).toContain("got no closer to the target");
    expect(offers[0]?.prompt).toContain("Fix round 1:");
    expect(offers[1]?.prompt).toContain("Fix round 2:");
    expect(offers[2]?.prompt).toContain("Fix round 3:");
    for (const o of offers) {
      expect(o.prompt).toContain("a score like 90 is NOT good enough on its own");
      expect(o.prompt).toContain("The chat sends you the next round on its own");
    }
  });

  it("a picked fix, or a Stage the AI did not make, never continues on its own", async () => {
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      { isolation: "experiment", title: `${PFX}loop-picked` },
    );
    const branch = { ...HUMAN, chatBranchId: s.chatBranchId };
    const status = () =>
      op<{ audit: { id: string }; feedback: { autoContinue: boolean } }>(
        HUMAN,
        "quality_audits.chat_status",
        { chatSessionId: s.chatSessionId },
      );
    const roundWith = async (performance: number, by: "operator" | "live_edit_ai") => {
      await editModule(branch, `<p>perf ${performance} ${by}</p>`);
      await stage(s.chatSessionId, by);
      await audit(fakeLighthouse(() => ({ scores: { performance } })));
      return status();
    };
    const first = await roundWith(70, "operator");
    await op(HUMAN, "quality_audits.claim_chat_notification", {
      auditRunId: first.audit.id,
      fixScope: "picked",
    });
    // Closer, but the operator asked only for some groups.
    const afterPicked = await roundWith(80, "live_edit_ai");
    expect(afterPicked.feedback.autoContinue).toBe(false);
    await op(HUMAN, "quality_audits.claim_chat_notification", {
      auditRunId: afterPicked.audit.id,
      fixScope: "all",
    });
    // Closer, but the operator staged it themselves: their Stage, their call.
    expect((await roundWith(90, "operator")).feedback.autoContinue).toBe(false);
  });

  it("stops continuing on its own once the chain's AI spend reaches the cap", async () => {
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      { isolation: "experiment", title: `${PFX}loop-spend` },
    );
    const branch = { ...HUMAN, chatBranchId: s.chatBranchId };
    // `at` null: now, on the DATABASE clock. The fix chain starts at the
    // claim's `now()` (microseconds); a JS timestamp is truncated to the
    // millisecond and can sort before it within the same millisecond, so
    // the spend would silently fall outside the chain.
    const spend = (microcents: number, at: string | null) =>
      withSql(async (tx) => {
        await tx`INSERT INTO ai_calls (chat_session_id, actor_id, provider, model, input_tokens,
                                       output_tokens, cost_estimate_microcents, created_at)
                 VALUES (${s.chatSessionId}::uuid, ${SYSTEM_ID}::uuid, 'anthropic', 'test-model',
                         1, 1, ${microcents}, coalesce(${at}::timestamptz, clock_timestamp()))`;
      });
    const roundWith = async (performance: number, by: "operator" | "live_edit_ai") => {
      await editModule(branch, `<p>spend ${performance} ${by}</p>`);
      await stage(s.chatSessionId, by);
      await audit(fakeLighthouse(() => ({ scores: { performance } })));
      return op<{
        audit: { id: string };
        feedback: { autoContinue: boolean; actionLabel: string; text: string };
      }>(HUMAN, "quality_audits.chat_status", { chatSessionId: s.chatSessionId });
    };
    // Spend from before the operator's click is not the fix loop's.
    await spend(AUTO_FIX_COST_CAP_MICROCENTS * 2, "2000-01-01T00:00:00Z");
    const first = await roundWith(60, "operator");
    await op(HUMAN, "quality_audits.claim_chat_notification", {
      auditRunId: first.audit.id,
      fixScope: "all",
    });
    await spend(AUTO_FIX_COST_CAP_MICROCENTS / 2, null);
    const second = await roundWith(70, "live_edit_ai");
    expect(second.feedback.autoContinue).toBe(true);
    // The panel's own send of round 2; that round spends up to the cap.
    await op(HUMAN, "quality_audits.claim_chat_notification", {
      auditRunId: second.audit.id,
      fixScope: "all",
    });
    await spend(AUTO_FIX_COST_CAP_MICROCENTS / 2, null);
    const third = await roundWith(80, "live_edit_ai");
    expect(third.feedback.autoContinue).toBe(false);
    expect(third.feedback.actionLabel).toBe("Keep fixing with AI");
    expect(third.feedback.text).toContain("used $5.00 of AI spend");
    // Every fix request that starts AI spend is on the audit record.
    const audited = await withSql(
      (tx) => tx`SELECT result_summary FROM audit_events
                 WHERE operation = 'quality_audits.claim_chat_notification'
                   AND entity_id IN (${first.audit.id}, ${second.audit.id})`,
    );
    expect((audited as { result_summary: string }[]).map((r) => r.result_summary)).toEqual([
      "fix requested (all)",
      "fix requested (all)",
    ]);
  });

  // #685 — accepting (or revoking) on the card while the AI fixes is the
  // operator taking over: the next round waits for their click.
  it("a round during which the operator accepted a finding does not continue on its own", async () => {
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      { isolation: "experiment", title: `${PFX}loop-decided` },
    );
    const branch = { ...HUMAN, chatBranchId: s.chatBranchId };
    const roundWith = async (performance: number, by: "operator" | "live_edit_ai") => {
      await editModule(branch, `<p>decided ${performance} ${by}</p>`);
      await stage(s.chatSessionId, by);
      await audit(fakeLighthouse(() => ({ scores: { performance, accessibility: 90 } })));
      return op<{
        audit: { id: string };
        feedback: { autoContinue: boolean; actionLabel: string; text: string; groups: unknown[] };
      }>(HUMAN, "quality_audits.chat_status", { chatSessionId: s.chatSessionId });
    };
    const first = await roundWith(60, "operator");
    await op(HUMAN, "quality_audits.claim_chat_notification", {
      auditRunId: first.audit.id,
      fixScope: "all",
    });
    // While the AI fixes, the operator accepts the Accessibility group.
    const proposal = await op<{ proposalId: string }>(HUMAN, "quality_audits.propose_accept", {
      auditRunId: first.audit.id,
      groups: [{ category: "accessibility" }],
      reason: "brand colours chosen on purpose",
    });
    await op(HUMAN, "quality_audits.execute_proposal", { proposalId: proposal.proposalId });
    // The AI's re-Stage got closer, but the operator has decided: ask.
    const second = await roundWith(70, "live_edit_ai");
    expect(second.feedback.autoContinue).toBe(false);
    expect(second.feedback.actionLabel).toBe("Keep fixing with AI");
    expect(second.feedback.text).toContain("You decided on findings while the AI was fixing");
    expect(second.feedback.groups).toHaveLength(1);
    // Their click after the decision starts a fresh chain that continues again.
    await op(HUMAN, "quality_audits.claim_chat_notification", {
      auditRunId: second.audit.id,
      fixScope: "all",
    });
    expect((await roundWith(80, "live_edit_ai")).feedback.autoContinue).toBe(true);
  });

  it("a Stage after 'Not now' uses up no fix round (#685)", async () => {
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      { isolation: "experiment", title: `${PFX}not-now` },
    );
    const branch = { ...HUMAN, chatBranchId: s.chatBranchId };
    const stubborn = fakeLighthouse(() => ({ failing: [imageAlt] }));
    for (let i = 0; i < 3; i += 1) {
      await editModule(branch, `<p>operator edit ${i}</p>`);
      await stage(s.chatSessionId);
      await audit(stubborn);
      const st = await op<{
        audit: { id: string; fixRound: number };
        feedback: { kind: string; actionLabel: string };
      }>(HUMAN, "quality_audits.chat_status", { chatSessionId: s.chatSessionId });
      expect(st.audit.fixRound).toBe(0);
      expect(st.feedback).toMatchObject({ kind: "offer", actionLabel: "Fix all with AI" });
      if (i === 1) {
        // A click whose tab closed before the turn ran: the claim (with its
        // fix request) is left behind and its lease runs out.
        await op(HUMAN, "quality_audits.claim_chat_notification", {
          auditRunId: st.audit.id,
          fixScope: "all",
        });
        await withSql(async (tx) => {
          await tx`UPDATE quality_audit_runs SET chat_notify_claimed_at = now() - interval '5 minutes'
                   WHERE id = ${st.audit.id}::uuid`;
        });
      }
      // "Not now": the endpoint settles the offer with a status note (and
      // drops any abandoned fix request).
      expect(
        (
          await op<{ claimed: boolean }>(HUMAN, "quality_audits.claim_chat_notification", {
            auditRunId: st.audit.id,
            note: { chatSessionId: s.chatSessionId, text: "Not now" },
          })
        ).claimed,
      ).toBe(true);
    }
  });
});

describe("bulk decisions (#727 'optimum, not good enough')", () => {
  const unusedJs: FailingAudit = {
    id: "unused-javascript",
    title: "Reduce unused JavaScript",
    score: 0.5,
    categories: ["performance"],
  };
  const about = `/${PFX}about`;
  let chatSessionId: string;
  let branch: ExecutionContext;

  type Status = {
    feedback: {
      kind: string;
      prompt: string;
      groups: { key: string; pages: { pagePath: string; detail: string }[] }[];
    } | null;
  };
  const openGate = () =>
    op<{
      gate: {
        open: boolean;
        state: string;
        openProblemCount: number;
        message: string;
        topProblems: { key: string; pageCount: number }[];
        problemGroupCount: number;
      };
    }>(AI, "quality_audits.gate_status", {}).then((g) => g.gate);

  it("every value below 100 blocks; the card groups it by rule across pages", async () => {
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      { isolation: "experiment", title: `${PFX}bulk` },
    );
    chatSessionId = s.chatSessionId;
    branch = { ...HUMAN, chatBranchId: s.chatBranchId };
    await editModule(branch, "<p>bulk 1</p>");
    await stage(chatSessionId);
    // A 93 and a 92 are not "good enough": both block.
    await audit(
      fakeLighthouse(() => ({
        scores: { performance: 93, accessibility: 92 },
        failing: [unusedJs],
      })),
    );
    const blocked = await openGate();
    expect(blocked).toMatchObject({ open: false, state: "problems", openProblemCount: 6 });
    const st = await op<Status>(HUMAN, "quality_audits.chat_status", { chatSessionId });
    // #1207 — the gate lists the same groups as the card, for the Staging menu.
    expect(blocked.topProblems.map((g) => [g.key, g.pageCount])).toEqual(
      (st.feedback?.groups ?? []).slice(0, 5).map((g) => [g.key, g.pages.length]),
    );
    expect(blocked.problemGroupCount).toBe(st.feedback?.groups.length);
    expect(st.feedback?.groups.map((g) => [g.key, g.pages.length])).toEqual([
      ["lighthouse/accessibility/score", 2],
      ["lighthouse/performance/score", 2],
      ["lighthouse/performance/unused-javascript", 2],
    ]);
    expect(st.feedback?.groups[1]?.pages[0]).toMatchObject({ pagePath: "/", detail: "score 93" });
    // A picked fix narrows the prompt to that group and page.
    const picked = await op<Status>(HUMAN, "quality_audits.chat_status", {
      chatSessionId,
      fixSelection: [{ key: "lighthouse/performance/unused-javascript", pagePaths: ["/"] }],
    });
    expect(picked.feedback?.prompt).toContain(
      "these quality findings I picked: 1 group(s) on 1 page(s)",
    );
    expect(picked.feedback?.prompt).not.toContain("lighthouse/accessibility/score");
  });

  it("a bulk acceptance covers a whole group in one click — only what is open", async () => {
    const auditRunId = (await gate()).auditRunId as string;
    // A page the group is not open on is refused, naming where it is open.
    expect(
      await opErr(AI, "quality_audits.propose_accept", {
        auditRunId,
        groups: [{ category: "performance", pagePaths: ["/nope"] }],
        reason: "third-party widget",
      }),
    ).toContain("is not open on /nope");
    const proposal = await op<{
      proposalId: string;
      preview: { accepts: string[]; acceptanceCount: number };
    }>(AI, "quality_audits.propose_accept", {
      auditRunId,
      groups: [
        { category: "accessibility" },
        { auditId: "unused-javascript" },
        { category: "performance", pagePaths: ["/"] },
      ],
      reason: "the embedded booking widget ships its own script and colours",
    });
    expect(proposal.preview.acceptanceCount).toBe(5);
    expect(proposal.preview.accepts).toEqual([
      `accessibility score on 2 page(s): /, ${about}`,
      `unused-javascript on 2 page(s): /, ${about}`,
      "performance score on 1 page(s): /",
    ]);
    // The AI proposes; only the editor's click applies (§11.A).
    expect(
      await opErr(AI, "quality_audits.execute_proposal", { proposalId: proposal.proposalId }),
    ).toContain("ActorScopeRejected");
    expect(
      await op(HUMAN, "quality_audits.execute_proposal", { proposalId: proposal.proposalId }),
    ).toMatchObject({ kind: "accept", accepted: 5 });
    expect(await openGate()).toMatchObject({ open: false, openProblemCount: 1 });
    // The rest of the group: only the page still open is accepted.
    const rest = await op<{ proposalId: string; preview: { acceptanceCount: number } }>(
      HUMAN,
      "quality_audits.propose_accept",
      { auditRunId, groups: [{ category: "performance" }], reason: "same widget" },
    );
    expect(rest.preview.acceptanceCount).toBe(1);
    await op(HUMAN, "quality_audits.execute_proposal", { proposalId: rest.proposalId });
    expect(await openGate()).toMatchObject({ open: true, state: "accepted" });
    const values = await op<{
      acceptances: { pagePath: string; kind: string; acceptedScore: number | null }[];
    }>(AI, "quality_acceptances.list", { query: "widget" });
    expect(values.acceptances).toHaveLength(6);
    expect(
      values.acceptances
        .filter((a) => a.kind === "score")
        .map((a) => a.acceptedScore)
        .sort(),
    ).toEqual([92, 92, 93, 93]);
  });

  it("a worse value re-blocks: Performance beyond the noise tolerance, a deterministic score at once", async () => {
    await editModule(branch, "<p>bulk 2</p>");
    await stage(chatSessionId);
    await audit(
      fakeLighthouse((path) =>
        path === "/"
          ? // Performance 92 vs accepted 93: within the tolerance — covered.
            // Accessibility 91 vs accepted 92: deterministic — blocks.
            { scores: { performance: 92, accessibility: 91 }, failing: [unusedJs] }
          : // Performance 90 vs accepted 93: beyond the tolerance — blocks.
            { scores: { performance: 90, accessibility: 92 }, failing: [unusedJs] },
      ),
    );
    const g = await openGate();
    expect(g).toMatchObject({ open: false, state: "problems", openProblemCount: 2 });
    expect(g.message).toContain("/: accessibility 91 < 100");
    expect(g.message).toContain(`${about}: performance 90 < 100`);
  });

  it("the Owner revokes a bulk decision in one call; it blocks again at once", async () => {
    const live = await op<{
      acceptances: { id: string; kind: string; category: string | null }[];
    }>(AI, "quality_acceptances.list", { query: "widget" });
    const a11y = live.acceptances
      .filter((a) => a.kind === "score" && a.category === "accessibility")
      .map((a) => a.id);
    expect(a11y).toHaveLength(2);
    expect(await opErr(AI, "quality_acceptances.revoke_many", { acceptanceIds: a11y })).toContain(
      "ActorScopeRejected",
    );
    expect(
      await opErr(REVIEWER, "quality_acceptances.revoke_many", { acceptanceIds: a11y }),
    ).toContain("Owner decision");
    // All or nothing: one unknown id revokes none.
    expect(
      await opErr(HUMAN, "quality_acceptances.revoke_many", {
        acceptanceIds: [...a11y, crypto.randomUUID()],
      }),
    ).toContain("nothing was revoked");
    expect((await openGate()).openProblemCount).toBe(2);
    expect(
      await op(HUMAN, "quality_acceptances.revoke_many", {
        acceptanceIds: a11y,
        reason: "fix the widget contrast instead",
      }),
    ).toEqual({ revoked: 2 });
    // Without a new audit: /about's Accessibility 92 is open again too.
    const g = await openGate();
    expect(g.openProblemCount).toBe(3);
    expect(g.message).toContain(`${about}: accessibility 92 < 100`);
    const st = await op<Status>(HUMAN, "quality_audits.chat_status", { chatSessionId });
    expect(st.feedback?.groups.map((x) => [x.key, x.pages.length])).toEqual([
      ["lighthouse/accessibility/score", 2],
      ["lighthouse/performance/score", 1],
    ]);
  });
});

describe("a staged build that was never audited", () => {
  it("is blocked as missing until the check runs", async () => {
    await op(HUMAN, "deploy.trigger", { targetName: "staging", repoRoot: testRoot });
    expect(await gate()).toMatchObject({ open: false, state: "missing" });
    expect((await promote()).message).toContain("has not been quality-checked");
    const r = await op<{ status: string }>(AI, "quality_audits.retry", {});
    expect(r.status).toBe("queued");
    await audit(fakeLighthouse(() => ({})));
    expect(await gate()).toMatchObject({ open: true, state: "clean" });
  });
});
