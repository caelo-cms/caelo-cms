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
import { drainAuditQueue } from "../quality/audit-worker.js";
import type { AuditJob } from "../quality/lighthouse-protocol.js";
import type { AuditJobResult } from "../quality/lighthouse-runner.js";
import type { FailingAudit, QualityCategory } from "../quality/ratchet.js";
import { localBuildSource } from "../quality/staged-origin.js";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

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
    await tx`DELETE FROM quality_baselines`;
    await tx`DELETE FROM quality_audit_runs`;
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM chat_entity_locks WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
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
async function stage(chatSessionId: string): Promise<{ runId: string; status: string }> {
  const branch = await op<object>(HUMAN, "quality_audits.classify_stage", { chatSessionId });
  const merged = await op<{ mergedAt: string }>(HUMAN, "chat.merge_to_main", {
    chatSessionId,
    deferConsume: true,
  });
  const built = await op<{ runId: string }>(HUMAN, "deploy.trigger", {
    targetName: "staging",
    repoRoot: testRoot,
  });
  await op(HUMAN, "chat.finalize_stage", { chatSessionId, stagedAt: merged.mergedAt });
  const q = await op<{ status: string }>(HUMAN, "quality_audits.enqueue", {
    deployRunId: built.runId,
    chatSessionId,
    branch,
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
        measurement: { scores, failingAudits: f.failing ?? [] },
        performanceRuns: [scores.performance, scores.performance, scores.performance],
      });
    }
    return { ok: true, pages, pageErrors: [] };
  };
}

async function audit(runJob: (job: AuditJob) => Promise<AuditJobResult>): Promise<void> {
  await drainAuditQueue({
    adapter,
    registry,
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
      { title: `${PFX}fix-loop` },
    );
    chatSessionId = s.chatSessionId;
    branch = { ...HUMAN, chatBranchId: s.chatBranchId };
    await editModule(branch, `<p>v1 <img src="/x.png"></p>`);
    expect((await stage(chatSessionId)).status).toBe("queued");
    const p = await promote();
    expect(p.ok).toBe(false);
    expect(p.message).toContain("until the quality check of the staged build finishes");
  });

  it("problems block Publish live and ask the AI to fix (round 1 of 2)", async () => {
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
      feedback: { kind: string; text: string };
      audit: { id: string; fixRound: number };
    }>(HUMAN, "quality_audits.chat_status", { chatSessionId });
    expect(st.audit.fixRound).toBe(0);
    expect(st.feedback.kind).toBe("ai-turn");
    expect(st.feedback.text).toContain("Fix round 1 of 2");
    // The chat is told exactly once: one tab holds the delivery lease; the
    // ack (after the panel sent the turn) marks it delivered.
    const auditRunId = st.audit.id;
    const claim = () =>
      op<{ claimed: boolean }>(HUMAN, "quality_audits.claim_chat_notification", { auditRunId });
    expect((await claim()).claimed).toBe(true);
    expect((await claim()).claimed).toBe(false);
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
      { title: `${PFX}accept` },
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

    const acc = await op<{ acceptances: { kind: string; acceptedScore: number | null }[] }>(
      AI,
      "quality_acceptances.list",
      {},
    );
    expect(acc.acceptances.map((a) => a.kind).sort()).toEqual(["finding", "score"]);
    const baseline = await withSql(
      async (tx) =>
        (await tx`SELECT b.baseline FROM quality_baselines b JOIN pages p ON p.id = b.page_id
                  WHERE p.slug = ${`${PFX}about`} AND b.category = 'accessibility'`) as unknown as {
          baseline: number;
        }[],
    );
    expect(baseline[0]?.baseline).toBe(92);
  });

  it("an acceptance proposed for an older audit cannot be applied after a newer one", async () => {
    // Propose against the current audit, then a new Stage replaces it.
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      { title: `${PFX}stale` },
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
      { title: `${PFX}accept-2` },
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
    expect(read.content).toContain("insufficient color contrast of 2.9");
  });
});

describe("a failed quality check", () => {
  let chatSessionId: string;

  it("blocks by default, tells the chat, and can be retried", async () => {
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      { title: `${PFX}errored` },
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
      { title: `${PFX}not-errored` },
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

describe("2-round fix cap", () => {
  it("after two fix rounds the AI is told to stop changing the site", async () => {
    const s = await op<{ chatSessionId: string; chatBranchId: string }>(
      HUMAN,
      "chat.create_session",
      { title: `${PFX}cap` },
    );
    const branch = { ...HUMAN, chatBranchId: s.chatBranchId };
    const stubborn = fakeLighthouse(() => ({ failing: [imageAlt] }));
    const texts: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      await editModule(branch, `<p>try ${round}</p>`);
      await stage(s.chatSessionId);
      await audit(stubborn);
      const st = await op<{ audit: { fixRound: number }; feedback: { text: string } }>(
        HUMAN,
        "quality_audits.chat_status",
        { chatSessionId: s.chatSessionId },
      );
      expect(st.audit.fixRound).toBe(round);
      texts.push(st.feedback.text);
    }
    expect(texts[0]).toContain("Fix round 1 of 2");
    expect(texts[1]).toContain("Fix round 2 of 2");
    expect(texts[2]).toContain("after 2 automatic fix rounds");
    expect(texts[2]).toContain("Do not change the site further");
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
