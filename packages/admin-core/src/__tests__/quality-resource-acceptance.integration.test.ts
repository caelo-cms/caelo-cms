// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1446 — an accepted Lighthouse audit for a file Caelo or a plugin
 * ships holds on every page, against a real Postgres: the run the issue
 * reports, where the next Stage's audit measures other pages and the same
 * file blocked Publish live again. Audits are seeded directly; what is
 * under test is the path from the recorded problems through the acceptance
 * ops to the gate.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { QualityProblem } from "../quality/ratchet.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const OWNER_ID = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "qr-1446" };
const AI: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "ai", requestId: "qr-1446" };
const PFX = "qr1446-";
const ORIGIN = "http://127.0.0.1:4100";
const RUNTIME = "/_caelo/plugin/consent-manager/runtime.84de0a18c461.js";
const AUDIT_ID = "unminified-javascript";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId: string;
let pageTypeId: string;

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
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
  });
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** A failing audit of the shipped file, optionally with more it flagged. */
function finding(score = 0.5, ...extra: string[]): QualityProblem {
  return {
    kind: "failing_audit",
    auditId: AUDIT_ID,
    title: "Minify JavaScript",
    score,
    categories: ["performance"],
    elements: [{ url: `${ORIGIN}${RUNTIME}` }, ...extra.map((url) => ({ url }))],
  };
}

/**
 * Seed a staged build whose newest audit found these problems.
 *
 * @param problems - per page slug, the problems of that page
 * @returns the audit run's id
 */
async function seedStage(problems: Record<string, readonly QualityProblem[]>): Promise<string> {
  return withSql(async (tx) => {
    const target = (await tx`SELECT id::text AS id FROM deploy_targets WHERE name = 'staging'`) as {
      id: string;
    }[];
    const run = (await tx`
      INSERT INTO deploy_runs (target_id, actor_id, status, build_id, started_at)
      VALUES (${target[0]?.id}::uuid, ${SYSTEM_ID}::uuid, 'succeeded', ${crypto.randomUUID()},
              clock_timestamp())
      RETURNING id::text AS id`) as { id: string }[];
    const audit = (await tx`
      INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification)
      VALUES (${run[0]?.id}::uuid, ${SYSTEM_ID}::uuid, 'problems', '{}'::jsonb)
      RETURNING id::text AS id`) as { id: string }[];
    const auditId = audit[0]?.id as string;
    for (const [slug, found] of Object.entries(problems)) {
      const path = `/${PFX}${slug}`;
      const page = (await tx`
        INSERT INTO pages (slug, title, short_title, template_id, page_type_id, status, current_path)
        VALUES (${`${PFX}${slug}`}, ${slug}, ${slug}, ${templateId}::uuid, ${pageTypeId}::uuid,
                'published', ${path})
        RETURNING id::text AS id`) as { id: string }[];
      await tx`
        INSERT INTO quality_audit_pages (audit_run_id, page_id, url, status, problems)
        VALUES (${auditId}::uuid, ${page[0]?.id}::uuid, ${`${ORIGIN}${path}`}, 'problems',
                ${JSON.stringify(found)}::text::jsonb)`;
    }
    return auditId;
  });
}

/** The AI proposes; the operator's click applies it. */
async function accept(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { proposalId, preview } = await op<{
    proposalId: string;
    preview: Record<string, unknown>;
  }>(AI, "quality_audits.propose_accept", input);
  await op(OWNER, "quality_audits.execute_proposal", { proposalId });
  return preview;
}

type Gate = { gate: { open: boolean; state: string; openProblemCount: number } };
const gate = () => op<Gate>(OWNER, "quality_audits.gate_status", {});

interface Listed {
  acceptances: {
    id: string;
    pageId: string | null;
    pagePath: string;
    resourcePath: string | null;
    acceptedScore: number | null;
  }[];
}
const list = () => op<Listed>(OWNER, "quality_acceptances.list", {});

beforeAll(async () => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_URL,
  });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  const seeded = await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 'qr owner')
             ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
    const template = (await tx`SELECT id::text AS id FROM templates LIMIT 1`) as { id: string }[];
    const pageType = (await tx`SELECT id::text AS id FROM page_types LIMIT 1`) as { id: string }[];
    return { template: template[0]?.id as string, pageType: pageType[0]?.id as string };
  });
  templateId = seeded.template;
  pageTypeId = seeded.pageType;
});

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await withSql(async (tx) => {
    await tx`DELETE FROM user_roles WHERE user_id = ${OWNER_ID}::uuid`;
    await tx`DELETE FROM users WHERE id = ${OWNER_ID}::uuid`;
  });
  await adapter.close();
});

describe("#1446 an accepted shipped file across Stages", () => {
  it("does not stop Publish live again when the next Stage samples other pages", async () => {
    const first = await seedStage({ a: [finding()], b: [finding()] });
    const preview = await accept({
      auditRunId: first,
      groups: [{ auditId: AUDIT_ID }],
      reason: "Plugin runtime, reported to Caelo",
    });
    expect(String(preview.note)).toContain("every page that loads it");
    expect((await gate()).gate.state).toBe("accepted");

    const rows = (await list()).acceptances;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pageId: null,
      pagePath: "site-wide",
      resourcePath: RUNTIME,
      acceptedScore: 50,
    });

    await seedStage({ c: [finding()], d: [finding()] });
    expect((await gate()).gate).toMatchObject({ open: true, state: "accepted" });
  });

  it("keeps a worse value and a changed file blocking", async () => {
    const first = await seedStage({ a: [finding()] });
    await accept({ auditRunId: first, groups: [{ auditId: AUDIT_ID }], reason: "Plugin runtime" });

    await seedStage({ c: [{ ...finding(0), categories: ["seo"] } as QualityProblem] });
    expect((await gate()).gate).toMatchObject({ open: false, openProblemCount: 1 });

    const changed: QualityProblem = {
      ...finding(),
      elements: [{ url: `${ORIGIN}/_caelo/plugin/consent-manager/runtime.ffffffffffff.js` }],
    } as QualityProblem;
    await seedStage({ d: [changed] });
    expect((await gate()).gate.open).toBe(false);
  });

  it("does not let the file's acceptance cover a page's own file", async () => {
    const first = await seedStage({ a: [finding()] });
    await accept({ auditRunId: first, groups: [{ auditId: AUDIT_ID }], reason: "Plugin runtime" });

    const own = `${ORIGIN}/_assets/widget.0123456789abcdef.js`;
    const second = await seedStage({ c: [finding(0.5, own)] });
    expect((await gate()).gate.open).toBe(false);

    // Accepting that page's finding stays a decision about that page.
    await accept({ auditRunId: second, groups: [{ auditId: AUDIT_ID }], reason: "Our widget" });
    const rows = (await list()).acceptances;
    expect(rows.filter((r) => r.resourcePath === null).map((r) => r.pagePath)).toEqual([
      `/${PFX}c`,
    ]);
    await seedStage({ d: [finding(0.5, own)] });
    expect((await gate()).gate.open).toBe(false);
  });

  it("records the worst value the decision saw, and never raises it later", async () => {
    const first = await seedStage({ a: [finding(0.5)], b: [finding(0.9)] });
    await accept({ auditRunId: first, groups: [{ auditId: AUDIT_ID }], reason: "Plugin runtime" });
    expect((await list()).acceptances[0]?.acceptedScore).toBe(50);

    const other = `${ORIGIN}/_caelo/plugin/analytics/tracker.0123456789ab.js`;
    const second = await seedStage({ c: [finding(0.9, other)] });
    await accept({ auditRunId: second, groups: [{ auditId: AUDIT_ID }], reason: "Both files" });
    const rows = (await list()).acceptances;
    expect(rows.find((r) => r.resourcePath === RUNTIME)?.acceptedScore).toBe(50);
    expect(rows).toHaveLength(2);
  });

  it("closes the gate at once when the Owner revokes it", async () => {
    const first = await seedStage({ a: [finding()] });
    await accept({ auditRunId: first, groups: [{ auditId: AUDIT_ID }], reason: "Plugin runtime" });
    const acceptanceIds = (await list()).acceptances.map((r) => r.id);
    await op(OWNER, "quality_acceptances.revoke_many", { acceptanceIds });
    expect((await gate()).gate.open).toBe(false);
  });

  it("accepts a named page's finding for the file too", async () => {
    const first = await seedStage({ a: [finding()], b: [finding()] });
    await accept({
      auditRunId: first,
      items: [{ pagePath: `/${PFX}a`, auditId: AUDIT_ID }],
      reason: "Plugin runtime",
    });
    expect((await gate()).gate.state).toBe("accepted");
  });
});
