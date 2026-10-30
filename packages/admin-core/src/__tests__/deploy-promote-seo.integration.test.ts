// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: "Publish live" (deploy.promote) shipped staging's SEO
 * semantics to production. Staging builds baked the staging target's
 * `noindex` into every page's `<meta name="robots">` and skipped
 * sitemap.xml; promote copies the staging build verbatim and only
 * patched robots.txt — so production dropped out of search engines.
 *
 * Pins, end to end on the self-hosted publisher (real generator, real
 * Postgres):
 *   - a staging build carries no env-level noindex meta, ships a
 *     sitemap.xml, and keeps staging non-indexable via robots.txt
 *     (`Disallow: /`, no `Sitemap:` line) — the staging vhost's
 *     `X-Robots-Tag` is pinned in packages/provisioning tests;
 *   - after promote, production pages carry only their OWN robots
 *     setting (a page-level noindex survives), sitemap.xml is live
 *     and robots.txt allows crawling with a `Sitemap:` line;
 *   - page HTML is byte-identical between staging and production;
 *   - a legacy staging build (manifest without `envNoindexInHtml:
 *     false`) is refused with a "Stage again" next step;
 *   - the Owner's Approve on the AI's Publish live / rollback card
 *     (`deploy.execute_proposal`) runs Publish live and rollback as ops of
 *     their own, holding no transaction across them, under the
 *     nested-checkout guard of #1210 with no allowlist entry (#1225).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DatabaseAdapter,
  execute,
  LONG_TRANSACTION_ALLOWLIST,
  OperationRegistry,
} from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { ensureRoleUser } from "./fixtures/role-user.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prevSkipServeCheck: string | undefined;
let restoreSiteBaseUrl: (() => Promise<void>) | null = null;
let restoreSiteLanguage: (() => Promise<void>) | null = null;

// #551 — site_base_url has no default; promote reads it for the
// production robots.txt `Sitemap:` line, so the test pins it.
const SITE_BASE_URL = "https://example.com";

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "human",
  requestId: "promote-seo-test",
};

const TPL_SLUG = "promote-seo-tpl";
const MOD_SLUG = "promote-seo-mod";
const PAGE_SLUG = "promote-seo-about";
const HIDDEN_SLUG = "promote-seo-hidden";
// issue #302 — staging/production builds need a page at the site root.
const HOME_SLUG = "home";
const SLUGS = [PAGE_SLUG, HIDDEN_SLUG, HOME_SLUG];

const ROBOTS_META = /<meta name="robots"[^>]*>/;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM deploy_pending_actions WHERE payload_hash LIKE 'promote-seo-%'`;
      await tx`DELETE FROM deploy_runs`;
      await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug IN (${PAGE_SLUG}, ${HIDDEN_SLUG}, ${HOME_SLUG}))`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug IN (${PAGE_SLUG}, ${HIDDEN_SLUG}, ${HOME_SLUG}))`;
      await tx`DELETE FROM pages WHERE slug IN (${PAGE_SLUG}, ${HIDDEN_SLUG}, ${HOME_SLUG})`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

/**
 * #553 — Publish live is gated on the staged build's quality audit; this
 * suite is about SEO semantics, so it records a passed audit directly.
 */
async function markAudited(deployRunId: string): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`
        INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, finished_at)
        VALUES (${deployRunId}::uuid, ${HUMAN.actorId}::uuid, 'passed',
                '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now())`;
    });
  } finally {
    await sql.end();
  }
}

async function ok<T>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, HUMAN, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function seedSite(): Promise<void> {
  const { templateId } = await ok<{ templateId: string }>("templates.create", {
    slug: TPL_SLUG,
    displayName: "T",
    html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  await ok("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { moduleId } = await ok<{ moduleId: string }>("modules.create", {
    slug: MOD_SLUG,
    displayName: "M",
    html: "<p>promote seo</p>",
    fields: [{ name: "body", kind: "text", label: "Body" } as never],
  });
  for (const slug of SLUGS) {
    const { pageId } = await ok<{ pageId: string }>("pages.create", {
      slug,
      title: slug,
      templateId,
    });
    await ok("pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    await ok("pages.update", { pageId, status: "published" });
    // Builds refuse published pages without a meta description.
    await ok("pages_seo.autofill", { pageId, metaDescription: `The ${slug} page.` });
    // The operator's own per-page choice — must survive promote.
    if (slug === HIDDEN_SLUG) await ok("pages_seo.set", { pageId, noindex: true });
  }
}

beforeAll(async () => {
  await wipe();
  restoreSiteBaseUrl = await pinSiteBaseUrl(ADMIN_URL!, SITE_BASE_URL);
  restoreSiteLanguage = await pinSiteLanguage(ADMIN_URL!, "en");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-promote-seo-"));
  // No staging vhost in this harness — see deploy.trigger's serve check.
  prevSkipServeCheck = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  await seedSite();
});

afterAll(async () => {
  if (prevSkipServeCheck === undefined) delete process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  else process.env.CAELO_SKIP_STAGING_SERVE_CHECK = prevSkipServeCheck;
  await wipe();
  await restoreSiteBaseUrl?.();
  await restoreSiteLanguage?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("deploy.promote ships production SEO semantics", () => {
  it("staging build → Publish live: no env noindex, sitemap + Sitemap line, per-page noindex kept", async () => {
    const staged = await ok<{ buildId: string; runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    await markAudited(staged.runId);
    const staging = join(testRoot, "output", "staging", "current");
    const production = join(testRoot, "output", "production", "current");

    // Staging: content renders env-independently; staging stays
    // non-indexable through robots.txt (and the serving-layer header).
    const stagedAbout = await readFile(join(staging, PAGE_SLUG, "index.html"), "utf8");
    expect(stagedAbout).not.toMatch(ROBOTS_META);
    expect(existsSync(join(staging, "sitemap.xml"))).toBe(true);
    const stagingRobots = await readFile(join(staging, "robots.txt"), "utf8");
    expect(stagingRobots).toContain("Disallow: /");
    expect(stagingRobots).not.toContain("Sitemap:");

    await ok("deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });

    const liveAbout = await readFile(join(production, PAGE_SLUG, "index.html"), "utf8");
    expect(liveAbout).not.toMatch(ROBOTS_META);
    // What staging shows is what production gets.
    expect(liveAbout).toBe(stagedAbout);
    const liveHome = await readFile(join(production, "index.html"), "utf8");
    expect(liveHome).not.toMatch(ROBOTS_META);
    // Page-level noindex is the operator's choice, not the env's.
    const liveHidden = await readFile(join(production, HIDDEN_SLUG, "index.html"), "utf8");
    expect(liveHidden).toContain('<meta name="robots" content="noindex" />');

    const sitemap = await readFile(join(production, "sitemap.xml"), "utf8");
    expect(sitemap).toContain(PAGE_SLUG);
    expect(sitemap).not.toContain(HIDDEN_SLUG);

    const liveRobots = await readFile(join(production, "robots.txt"), "utf8");
    expect(liveRobots).toContain("Allow: /");
    expect(liveRobots).not.toContain("Disallow: /");
    expect(liveRobots).toContain(`Sitemap: ${SITE_BASE_URL}/sitemap.xml`);

    const manifest = JSON.parse(
      await readFile(join(production, "routing-manifest.json"), "utf8"),
    ) as { env: string; runId: string };
    expect(manifest.env).toBe("production");
    expect(manifest.runId).toBe(staged.buildId);
  });

  it("refuses to promote a legacy staging build whose pages carry staging's noindex", async () => {
    const staged = await ok<{ buildId: string; runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    await markAudited(staged.runId);
    // Simulate a build from before the env-independent SEO pass: its
    // manifest lacks the `envNoindexInHtml: false` flag.
    const manifestPath = join(
      testRoot,
      "output",
      "staging",
      "builds",
      staged.buildId,
      "routing-manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.envNoindexInHtml;
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const r = await execute(registry, adapter, HUMAN, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.error)).toContain("run Stage again");
  });
});

/** A human holding the Owner role — the approver `deploy.execute_proposal` requires (#589). */
async function makeOwner(): Promise<ExecutionContext> {
  const id = crypto.randomUUID();
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${id}::uuid, 'human', 'promote-seo owner')`;
      await tx`INSERT INTO users (id, email, password_hash) VALUES (${id}::uuid, ${`${id}@promote-seo.test`}, 'test-only')`;
      await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${id}::uuid, id FROM roles WHERE name = 'owner'`;
    });
  } finally {
    await sql.end();
  }
  return { actorId: id, actorKind: "human", requestId: "promote-seo-owner" };
}

/** A pending AI proposal as `propose_deploy_promote` / `_rollback` leave it. */
async function insertProposal(
  kind: "promote" | "rollback",
  payload: Record<string, unknown>,
  preview: Record<string, unknown>,
): Promise<string> {
  const sql = new SQL(ADMIN_URL!);
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx`
        INSERT INTO deploy_pending_actions (kind, proposed_by, payload, preview, status, payload_hash)
        VALUES (${kind}, '00000000-0000-0000-0000-000000000a1a'::uuid, ${payload}::jsonb,
                ${preview}::jsonb, 'pending', ${`promote-seo-${kind}-${crypto.randomUUID()}`})
        RETURNING id::text AS id`) as { id: string }[];
    });
    const id = rows[0]?.id;
    if (!id) throw new Error("proposal insert returned no id");
    return id;
  } finally {
    await sql.end();
  }
}

async function proposalStatus(proposalId: string): Promise<string | undefined> {
  const sql = new SQL(ADMIN_URL!);
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx`SELECT status FROM deploy_pending_actions WHERE id = ${proposalId}::uuid`) as {
        status: string;
      }[];
    });
    return rows[0]?.status;
  } finally {
    await sql.end();
  }
}

describe("#1225 — the Owner approves the AI's Publish live / rollback card", () => {
  it("is not on the long-transaction allowlist, nor is anything it runs", () => {
    // #1225 — the approve, Publish live and publish anyway hold no
    // transaction across the live build + upload, so none of them needs to
    // take a second connection from inside one or outlast the 0392 timeouts.
    for (const holder of [
      "deploy.execute_proposal",
      "deploy.promote",
      "quality_audits.publish_anyway",
      "quality_audits.execute_proposal",
      "deploy.build_plugin_data",
    ]) {
      expect(LONG_TRANSACTION_ALLOWLIST.has(holder)).toBe(false);
    }
  });

  it("an approved promote publishes live and an approved rollback restores, through the guarded adapter", async () => {
    const owner = await makeOwner();
    const staged = await ok<{ buildId: string; runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    await markAudited(staged.runId);

    const promoteId = await insertProposal(
      "promote",
      { fromTarget: "staging", toTarget: "production", repoRoot: testRoot },
      {},
    );
    const promoted = await execute(registry, adapter, owner, "deploy.execute_proposal", {
      proposalId: promoteId,
    });
    if (!promoted.ok) throw new Error(`promote approve failed: ${JSON.stringify(promoted.error)}`);
    const liveRunId = (promoted.value as { runId: string | null }).runId;
    expect(liveRunId).not.toBeNull();
    expect(await proposalStatus(promoteId)).toBe("applied");
    const production = join(testRoot, "output", "production", "current");
    const manifest = JSON.parse(
      await readFile(join(production, "routing-manifest.json"), "utf8"),
    ) as { runId: string };
    expect(manifest.runId).toBe(staged.buildId);

    const rollbackId = await insertProposal(
      "rollback",
      { target: "production", repoRoot: testRoot },
      { restoreRunId: liveRunId },
    );
    const rolledBack = await execute(registry, adapter, owner, "deploy.execute_proposal", {
      proposalId: rollbackId,
    });
    if (!rolledBack.ok) {
      throw new Error(`rollback approve failed: ${JSON.stringify(rolledBack.error)}`);
    }
    expect(await proposalStatus(rollbackId)).toBe("applied");
  });

  it("an approved rollback that went live but was never marked applied is recorded, not released again", async () => {
    const owner = await makeOwner();
    const runs = await productionRunCount();
    const sql = new SQL(ADMIN_URL!);
    let liveRunId = "";
    try {
      liveRunId = (
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          return (await tx`SELECT r.id::text AS id FROM deploy_runs r JOIN deploy_targets t
                            ON t.id = r.target_id WHERE t.env = 'production' AND r.status = 'succeeded'
                            ORDER BY r.finished_at DESC LIMIT 1`) as { id: string }[];
        })
      )[0]?.id as string;
    } finally {
      await sql.end();
    }
    const rollbackId = await insertProposal(
      "rollback",
      { target: "production", repoRoot: testRoot },
      { restoreRunId: liveRunId },
    );
    const first = await execute(registry, adapter, owner, "deploy.execute_proposal", {
      proposalId: rollbackId,
    });
    if (!first.ok) throw new Error(`rollback approve failed: ${JSON.stringify(first.error)}`);
    const rolledBackRun = (first.value as { runId: string }).runId;
    // The rollback's run carries the claimed id, committed with the rollback.
    expect(await proposalClaimRun(rollbackId)).toBe(rolledBackRun);
    expect(await productionRunCount()).toBe(runs + 1);
    // As if the apply died after the rollback but before marking it applied.
    await setProposalPending(rollbackId);
    const retry = await execute(registry, adapter, owner, "deploy.execute_proposal", {
      proposalId: rollbackId,
    });
    if (!retry.ok) throw new Error(`retry failed: ${JSON.stringify(retry.error)}`);
    expect((retry.value as { runId: string }).runId).toBe(rolledBackRun);
    expect(await proposalStatus(rollbackId)).toBe("applied");
    expect(await productionRunCount()).toBe(runs + 1);
  });

  it("the approval's and Publish live's own steps authorise nothing on their own", async () => {
    const reviewer: ExecutionContext = {
      actorId: crypto.randomUUID(),
      actorKind: "human",
      requestId: "promote-seo-reviewer",
    };
    await ensureRoleUser(ADMIN_URL!, reviewer.actorId, "reviewer");
    const proposalId = await insertProposal(
      "promote",
      { fromTarget: "staging", toTarget: "production", repoRoot: testRoot },
      {},
    );
    // Marking a card applied, or claiming it, needs the approver's permission.
    const ended = await execute(registry, adapter, reviewer, "deploy.end_execute_proposal", {
      proposalId,
      claimedRunId: crypto.randomUUID(),
      outcome: { ok: true, runId: null },
    });
    expect(JSON.stringify(ended)).toContain("permission_denied");
    const begun = await execute(registry, adapter, reviewer, "deploy.begin_execute_proposal", {
      proposalId,
      runId: crypto.randomUUID(),
    });
    expect(JSON.stringify(begun)).toContain("permission_denied");
    expect(await proposalStatus(proposalId)).toBe("pending");
    expect(await proposalClaim(proposalId)).toBeNull();
    // Recording a Publish live: only for the caller that started that run.
    const staged = await ok<{ runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    await markAudited(staged.runId);
    const owner = await makeOwner();
    const published = await execute(registry, adapter, owner, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });
    if (!published.ok) throw new Error(JSON.stringify(published.error));
    const { toRunId } = published.value as { toRunId: string };
    const targetId = await productionTargetId();
    const forged = await execute(registry, adapter, HUMAN, "deploy.finish_promote", {
      runId: toRunId,
      fromRunId: staged.runId,
      targetId,
      env: "production",
      pageCount: 1,
      fileCount: 1,
      buildId: "forged",
      publishSummary: {},
      siteUrl: null,
      caeloVersion: null,
      override: null,
      phaseTimings: [],
    });
    expect(forged.ok).toBe(false);
    expect(JSON.stringify(forged)).toMatch(/not a Publish live of this caller|already recorded/);
  });

  it("a card being applied cannot be rejected or cancelled under it", async () => {
    const owner = await makeOwner();
    const proposalId = await insertProposal(
      "promote",
      { fromTarget: "staging", toTarget: "production", repoRoot: testRoot },
      {},
    );
    // Claimed by an Approve whose Publish live has not committed its run yet.
    await claimProposal(proposalId);
    const rejected = await execute(registry, adapter, owner, "deploy.reject_proposal", {
      proposalId,
      reason: "changed my mind",
    });
    expect(JSON.stringify(rejected)).toContain("being applied right now");
    expect(await proposalStatus(proposalId)).toBe("pending");
  });

  it("a failed attempt releases only its own claim, never a later Approve's", async () => {
    const owner = await makeOwner();
    const proposalId = await insertProposal(
      "promote",
      { fromTarget: "staging", toTarget: "production", repoRoot: testRoot },
      {},
    );
    // A later Approve took the proposal over after the first attempt failed.
    await claimProposal(proposalId);
    const later = await proposalClaimRun(proposalId);
    const ended = await execute(registry, adapter, owner, "deploy.end_execute_proposal", {
      proposalId,
      claimedRunId: crypto.randomUUID(),
      outcome: { ok: false, message: "the first attempt failed" },
    });
    expect(ended.ok).toBe(true);
    expect(await proposalClaimRun(proposalId)).toBe(later);
    expect(await proposalStatus(proposalId)).toBe("pending");
  });

  it("a double click on one card publishes once; the other click is refused", async () => {
    const owner = await makeOwner();
    const staged = await ok<{ runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    await markAudited(staged.runId);
    const before = await productionRunCount();
    const proposalId = await insertProposal(
      "promote",
      { fromTarget: "staging", toTarget: "production", repoRoot: testRoot },
      {},
    );
    const clicks = await Promise.all(
      [0, 1].map(() =>
        execute(registry, adapter, owner, "deploy.execute_proposal", { proposalId }),
      ),
    );
    const applied = clicks.filter((c) => c.ok);
    const refused = clicks.filter((c) => !c.ok);
    expect(applied).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(JSON.stringify(refused[0])).toMatch(/being applied right now|already applied/);
    expect(await proposalStatus(proposalId)).toBe("applied");
    expect(await productionRunCount()).toBe(before + 1);
    // A later click finds it applied and publishes nothing.
    const late = await execute(registry, adapter, owner, "deploy.execute_proposal", { proposalId });
    expect(late.ok).toBe(false);
    expect(await productionRunCount()).toBe(before + 1);
  });

  it("an approve whose Publish live fails leaves the card pending and approvable again", async () => {
    const owner = await makeOwner();
    // Staged but never checked: the quality gate refuses Publish live.
    const staged = await ok<{ runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    const proposalId = await insertProposal(
      "promote",
      { fromTarget: "staging", toTarget: "production", repoRoot: testRoot },
      {},
    );
    const refused = await execute(registry, adapter, owner, "deploy.execute_proposal", {
      proposalId,
    });
    expect(refused.ok).toBe(false);
    expect(await proposalStatus(proposalId)).toBe("pending");
    expect(await proposalClaim(proposalId)).toBeNull();
    await markAudited(staged.runId);
    const approved = await execute(registry, adapter, owner, "deploy.execute_proposal", {
      proposalId,
    });
    if (!approved.ok) throw new Error(`retry failed: ${JSON.stringify(approved.error)}`);
    expect(await proposalStatus(proposalId)).toBe("applied");
  });
});

async function claimProposal(proposalId: string): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`UPDATE deploy_pending_actions
               SET claimed_by_run_id = ${crypto.randomUUID()}::uuid, claimed_at = clock_timestamp()
               WHERE id = ${proposalId}::uuid`;
    });
  } finally {
    await sql.end();
  }
}

async function productionTargetId(): Promise<string> {
  const sql = new SQL(ADMIN_URL!);
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx`SELECT id::text AS id FROM deploy_targets WHERE env = 'production' LIMIT 1`) as {
        id: string;
      }[];
    });
    return rows[0]?.id ?? "";
  } finally {
    await sql.end();
  }
}

async function productionRunCount(): Promise<number> {
  const sql = new SQL(ADMIN_URL!);
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx`
        SELECT count(*)::int AS n FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
        WHERE t.env = 'production' AND r.status = 'succeeded'`) as { n: number }[];
    });
    return rows[0]?.n ?? 0;
  } finally {
    await sql.end();
  }
}

async function proposalClaimRun(proposalId: string): Promise<string | null> {
  const sql = new SQL(ADMIN_URL!);
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx`SELECT claimed_by_run_id::text AS id FROM deploy_pending_actions
                       WHERE id = ${proposalId}::uuid`) as { id: string | null }[];
    });
    return rows[0]?.id ?? null;
  } finally {
    await sql.end();
  }
}

async function setProposalPending(proposalId: string): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`UPDATE deploy_pending_actions
               SET status = 'pending', decided_at = NULL, decided_by = NULL, applied_run_id = NULL
               WHERE id = ${proposalId}::uuid`;
    });
  } finally {
    await sql.end();
  }
}

async function proposalClaim(proposalId: string): Promise<string | null> {
  const sql = new SQL(ADMIN_URL!);
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx`SELECT claimed_at FROM deploy_pending_actions WHERE id = ${proposalId}::uuid`) as {
        claimed_at: string | null;
      }[];
    });
    return rows[0]?.claimed_at ?? null;
  } finally {
    await sql.end();
  }
}
