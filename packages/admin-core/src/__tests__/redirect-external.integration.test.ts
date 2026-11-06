// SPDX-License-Identifier: MPL-2.0

/**
 * #1358 — redirects to another domain: AI-proposable, Owner-approved
 * (CLAUDE.md §11.A), never through a routine op, never to a host of this
 * install. Real Postgres per §6.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { buildRedirectPlan, type ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1358-system",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000aaaa",
  actorKind: "ai",
  requestId: "t1358-ai",
};
/** A human without any role: may click, may not decide. */
const NO_ROLE: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000bbbb",
  actorKind: "human",
  requestId: "t1358-human",
};

const SITE = "https://site.example";
const BOOKING = "https://calendar.example/book/ab12";
const PFX = "/t1358";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let restoreBase: (() => Promise<void>) | null = null;
const envBefore = { ...process.env };

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

const run = (ctx: ExecutionContext, op: string, input: unknown) =>
  execute(registry, adapter, ctx, op, input as Record<string, unknown>);

function message(r: Awaited<ReturnType<typeof run>>): string {
  if (r.ok) throw new Error("expected a refusal");
  return "message" in r.error ? String(r.error.message) : JSON.stringify(r.error);
}

async function propose(fromPath: string, url = BOOKING, statusCode?: number): Promise<string> {
  const r = await run(AI, "redirects.propose_external", {
    redirects: [{ fromPath, url, ...(statusCode ? { statusCode } : {}) }],
  });
  if (!r.ok) throw new Error(`propose: ${JSON.stringify(r.error)}`);
  return (r.value as { proposalId: string }).proposalId;
}

const rowsAt = (fromPath: string) =>
  asSystem(
    (tx) => tx`
      SELECT from_path, to_path, status_code FROM redirects
      WHERE from_path IN (${fromPath}, ${`${fromPath}/`})`,
  ) as Promise<{ from_path: string; to_path: string; status_code: number }[]>;

beforeAll(async () => {
  await asSystem(async (tx) => {
    for (const [c, kind] of [
      [SYSTEM, "human"],
      [AI, "ai"],
      [NO_ROLE, "human"],
    ] as const) {
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${c.actorId}::uuid, ${kind}, ${c.requestId}) ON CONFLICT DO NOTHING`;
    }
  });
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  restoreBase = await pinSiteBaseUrl(ADMIN_URL, SITE);
});

beforeEach(async () => {
  process.env.CAELO_PROVIDER = "gcp-firebase";
  process.env.CAELO_ADMIN_URL = "https://admin.site.example";
  await asSystem(async (tx) => {
    await tx`DELETE FROM redirect_pending_actions`;
    await tx`DELETE FROM redirects WHERE from_path LIKE '/t1358%'`;
  });
});

afterAll(async () => {
  process.env.CAELO_PROVIDER = envBefore.CAELO_PROVIDER;
  process.env.CAELO_ADMIN_URL = envBefore.CAELO_ADMIN_URL;
  if (envBefore.CAELO_PROVIDER === undefined) delete process.env.CAELO_PROVIDER;
  if (envBefore.CAELO_ADMIN_URL === undefined) delete process.env.CAELO_ADMIN_URL;
  await asSystem(async (tx) => {
    await tx`DELETE FROM redirect_pending_actions`;
    await tx`DELETE FROM redirects WHERE from_path LIKE '/t1358%'`;
  });
  await restoreBase?.();
  await adapter.close();
});

describe("the gate", () => {
  it("no routine op takes an external target, for any actor", async () => {
    for (const ctx of [AI, SYSTEM]) {
      const one = await run(ctx, "redirects.create", { fromPath: `${PFX}-a`, toPath: BOOKING });
      expect(one.ok).toBe(false);
      const many = await run(ctx, "redirects.create_many", {
        redirects: [{ fromPath: `${PFX}-a`, toPath: BOOKING }],
      });
      expect(many.ok).toBe(false);
    }
    expect(await rowsAt(`${PFX}-a`)).toHaveLength(0);
  });

  it("the AI proposes, cannot approve; nothing is written until the approval", async () => {
    const proposalId = await propose(`${PFX}-termin`);
    expect((await run(AI, "redirects.execute_proposal", { proposalId })).ok).toBe(false);
    expect(await rowsAt(`${PFX}-termin`)).toHaveLength(0);

    const applied = await run(SYSTEM, "redirects.execute_proposal", { proposalId });
    expect(applied.ok).toBe(true);
    // Temporary by default: browsers keep a 301 after the rule is gone.
    expect(await rowsAt(`${PFX}-termin`)).toEqual([
      { from_path: `${PFX}-termin`, to_path: BOOKING, status_code: 302 },
    ]);
    expect((await run(SYSTEM, "redirects.execute_proposal", { proposalId })).ok).toBe(false);
  });

  it("leaves the proposal pending when the approver lacks settings.write", async () => {
    const proposalId = await propose(`${PFX}-noperm`);
    const r = await run(NO_ROLE, "redirects.execute_proposal", { proposalId });
    expect(message(r)).toContain("permission_denied");
    expect(await rowsAt(`${PFX}-noperm`)).toHaveLength(0);
  });

  it("a rejected proposal stays unapplied; an open one shows in the queue and can be cancelled", async () => {
    const rejected = await propose(`${PFX}-rejected`);
    expect((await run(SYSTEM, "redirects.reject_proposal", { proposalId: rejected })).ok).toBe(
      true,
    );
    expect((await run(SYSTEM, "redirects.execute_proposal", { proposalId: rejected })).ok).toBe(
      false,
    );

    const open = await propose(`${PFX}-open`);
    const again = await run(AI, "redirects.propose_external", {
      redirects: [{ fromPath: `${PFX}-open`, url: BOOKING }],
    });
    expect(again.ok).toBe(false);
    const queue = await run(SYSTEM, "pending_proposals.list", {});
    if (!queue.ok) throw new Error(JSON.stringify(queue.error));
    expect(JSON.stringify(queue.value)).toContain(open);
    expect((await run(AI, "pending_proposals.cancel", { proposalId: open })).ok).toBe(true);
  });

  it("deleting an approved rule stays routine", async () => {
    await run(SYSTEM, "redirects.execute_proposal", { proposalId: await propose(`${PFX}-del`) });
    const r = await run(AI, "redirects.delete_many", { fromPaths: [`${PFX}-del`] });
    expect(r.ok).toBe(true);
    expect(await rowsAt(`${PFX}-del`)).toHaveLength(0);
  });
});

describe("what a proposal may name", () => {
  const refusal = async (url: string, fromPath = `${PFX}-x`) =>
    message(await run(AI, "redirects.propose_external", { redirects: [{ fromPath, url }] }));

  it("refuses this install's own hosts", async () => {
    expect(await refusal(`${SITE}/pricing`)).toContain("is this site");
    expect(await refusal("https://admin.site.example/settings")).toContain("the Caelo admin");
  });

  it("refuses a target hidden behind credentials, a scheme or a dot segment", async () => {
    expect(await refusal("https://site.example@evil.example/")).toContain("credentials");
    expect(await refusal("http://calendar.example/")).toContain("https");
    expect(await refusal("javascript:alert(1)")).toContain("https");
    expect(await refusal("https://calendar.example/a/../b")).toContain("plain form");
  });

  it("refuses a from path no hosting can serve, and one address twice", async () => {
    const r = await run(AI, "redirects.propose_external", {
      redirects: [{ fromPath: `${PFX}?x=1`, url: BOOKING }],
    });
    expect(r.ok).toBe(false);
    expect(
      await run(AI, "redirects.propose_external", {
        redirects: [
          { fromPath: `${PFX}-dup`, url: BOOKING },
          { fromPath: `${PFX}-dup/`, url: BOOKING },
        ],
      }).then(message),
    ).toContain("twice");
  });

  it("refuses honestly where the hosting cannot serve it", async () => {
    for (const provider of ["aws", "azure"]) {
      process.env.CAELO_PROVIDER = provider;
      expect(await refusal(BOOKING)).toContain(`not available on ${provider}`);
    }
    process.env.CAELO_PROVIDER = "gcp";
    expect(await refusal(`${BOOKING}?gv=true`)).toContain("query string");
    await propose(`${PFX}-gcp`, BOOKING);
  });

  it("re-checks at approval: a host that became this install's is refused", async () => {
    const proposalId = await propose(`${PFX}-late`);
    process.env.CAELO_ADMIN_URL = "https://calendar.example";
    const r = await run(SYSTEM, "redirects.execute_proposal", { proposalId });
    expect(message(r)).toContain("the Caelo admin");
    expect(await rowsAt(`${PFX}-late`)).toHaveLength(0);
  });
});

describe("an approved rule among the others", () => {
  it("the card names what it replaces; a rule that changed since refuses the approval", async () => {
    await run(SYSTEM, "redirects.create", { fromPath: `${PFX}-old`, toPath: "/somewhere" });
    const input = { redirects: [{ fromPath: `${PFX}-old`, url: BOOKING, statusCode: 301 }] };
    const card = await run(AI, "redirects.preview_external", input);
    if (!card.ok) throw new Error(JSON.stringify(card.error));
    const text = (card.value as { preview: string }).preview;
    expect(text).toContain(BOOKING);
    expect(text).toContain("Replaces the redirect to /somewhere");
    expect(text).toContain("browsers remember");

    const proposalId = await propose(`${PFX}-old`, BOOKING, 301);
    await run(SYSTEM, "redirects.create", { fromPath: `${PFX}-old`, toPath: "/changed" });
    const stale = await run(SYSTEM, "redirects.execute_proposal", { proposalId });
    expect(message(stale)).toContain("changed after this proposal");
    expect((await rowsAt(`${PFX}-old`))[0]?.to_path).toBe("/changed");
  });

  it("two approvals at once apply once", async () => {
    const proposalId = await propose(`${PFX}-race`);
    const results = await Promise.all([
      run(SYSTEM, "redirects.execute_proposal", { proposalId }),
      run(SYSTEM, "redirects.execute_proposal", { proposalId }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await rowsAt(`${PFX}-race`)).toHaveLength(1);
  });

  it("a changed status alone also refuses the approval", async () => {
    await run(SYSTEM, "redirects.create", { fromPath: `${PFX}-st`, toPath: "/a", statusCode: 301 });
    const proposalId = await propose(`${PFX}-st`);
    await run(SYSTEM, "redirects.create", { fromPath: `${PFX}-st`, toPath: "/a", statusCode: 302 });
    const stale = await run(SYSTEM, "redirects.execute_proposal", { proposalId });
    expect(message(stale)).toContain("changed after this proposal");
  });

  it("replaces the other spelling of the address, so the plan stays buildable", async () => {
    await run(SYSTEM, "redirects.create", { fromPath: `${PFX}-slash/`, toPath: "/x" });
    await run(SYSTEM, "redirects.execute_proposal", { proposalId: await propose(`${PFX}-slash`) });
    expect(await rowsAt(`${PFX}-slash`)).toEqual([
      { from_path: `${PFX}-slash`, to_path: BOOKING, status_code: 302 },
    ]);
  });

  it("serves from the stored table through the plan, and a same-site row collapses onto it", async () => {
    await run(SYSTEM, "redirects.execute_proposal", { proposalId: await propose(`${PFX}-ext`) });
    await run(SYSTEM, "redirects.create", { fromPath: `${PFX}-short`, toPath: `${PFX}-ext` });
    const rows = (await asSystem(
      (tx) => tx`SELECT from_path, to_path, status_code FROM redirects
                 WHERE from_path LIKE '/t1358%'`,
    )) as { from_path: string; to_path: string; status_code: number }[];
    const plan = buildRedirectPlan({
      rows: rows.map((r) => ({
        fromPath: r.from_path,
        toPath: r.to_path,
        statusCode: r.status_code,
      })),
      pageUrlStyle: "directory",
      servedFiles: new Set(),
    });
    expect(plan.redirects.find((r) => r.fromPath === `${PFX}-short`)?.location).toBe(BOOKING);
    expect(plan.redirects.find((r) => r.fromPath === `${PFX}-ext`)?.location).toBe(BOOKING);
  });

  it("redirects.page_conflicts still names a page on an approved rule's path", async () => {
    const tpl = await asSystem(
      (tx) => tx`SELECT id::text AS id FROM templates WHERE deleted_at IS NULL LIMIT 1`,
    );
    const templateId = (tpl as { id: string }[])[0]?.id;
    const slug = `t1358-page-${Date.now().toString(36)}`;
    const created = await run(SYSTEM, "pages.create", { slug, title: "On it", templateId });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const proposed = await run(AI, "redirects.propose_external", {
      redirects: [{ fromPath: `/${slug}`, url: BOOKING }],
    });
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const { proposalId, preview } = proposed.value as {
      proposalId: string;
      preview: { pageConflicts: unknown[] };
    };
    expect(preview.pageConflicts).toHaveLength(1);
    const applied = await run(SYSTEM, "redirects.execute_proposal", { proposalId });
    if (!applied.ok) throw new Error(JSON.stringify(applied.error));
    expect((applied.value as { nextStep: string }).nextStep).toContain("visitors see the page");
    const conflicts = await run(AI, "redirects.page_conflicts", { paths: [`/${slug}`] });
    if (!conflicts.ok) throw new Error(JSON.stringify(conflicts.error));
    expect((conflicts.value as { conflicts: { toPath: string }[] }).conflicts[0]?.toPath).toBe(
      BOOKING,
    );
    await asSystem((tx) => tx`DELETE FROM redirects WHERE from_path = ${`/${slug}`}`);
  });
});
