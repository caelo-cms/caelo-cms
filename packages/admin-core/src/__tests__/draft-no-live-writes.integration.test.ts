// SPDX-License-Identifier: MPL-2.0

/**
 * #1517 — adversarial: no draft page write reaches the live redirects.
 *
 * Redirects are live state (pushed to the hosting on commit, #1157), so a
 * write to a page only a chat's branch holds must leave the table, its change
 * rows (what the provider sync folds) and every target's wanted revision
 * exactly as they were. Every page op that can move a URL is driven against
 * pages the chat created, each onto or off a URL that holds a live rule:
 * create, rename + refresh, duplicate, a parent's move dragging a child,
 * and a delete asking for a dead-URL redirect. The plugin path
 * (create_variant) is covered in international-site-urls.integration.test.ts;
 * the static pin of every live-redirect writer is
 * scripts/no-draft-live-writes.test.ts.
 *
 * Real Postgres (§6).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "draft-no-live-writes",
};
const PFX = "dnlw1517";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";

async function q<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function run<T>(ctx: ExecutionContext, op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** Everything a live redirect write would change. */
async function liveRedirectState() {
  return q(async (tx) => ({
    rows: (await tx`
      SELECT from_path, to_path, status_code, created_at FROM redirects ORDER BY from_path
    `) as unknown[],
    changes: ((await tx`SELECT count(*)::int AS n FROM redirect_changes`) as { n: number }[])[0]?.n,
    wanted: (await tx`
      SELECT target_id::text AS target, wanted_revision FROM redirect_sync_state ORDER BY target_id
    `) as unknown[],
  }));
}

async function wipe(): Promise<void> {
  await q(async (tx) => {
    await tx`DELETE FROM redirects WHERE from_path LIKE ${`%${PFX}%`}`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
  });
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  templateId = (
    await run<{ templateId: string }>(SYSTEM, "templates.create", {
      pageType: "home",
      slug: `${PFX}-tpl`,
      displayName: "T",
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
    })
  ).templateId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("a chat's draft pages never change live redirects (#1517)", () => {
  it("create, rename, duplicate, a parent move and a redirecting delete leave the table alone", async () => {
    const live = `/${PFX}-live-target`;
    await run(SYSTEM, "redirects.create_many", {
      redirects: [
        `/${PFX}-created/`,
        `/${PFX}-renamed`,
        `/${PFX}-copy/`,
        `/${PFX}-parent-after/${PFX}-kid`,
        `/${PFX}-deleted`,
        `/${PFX}-old-path`,
      ].map((fromPath) => ({ fromPath, toPath: live })),
    });
    const { chatSessionId, chatBranchId } = await run<{
      chatSessionId: string;
      chatBranchId: string;
    }>(SYSTEM, "chat.create_session", { title: `${PFX}-chat` });
    const chat: ExecutionContext = { ...SYSTEM, chatBranchId, chatTaskId: chatSessionId };
    const create = async (slug: string, parentPageId?: string) =>
      (
        await run<{ pageId: string }>(chat, "pages.create", {
          slug,
          title: slug,
          templateId,
          status: "draft",
          ...(parentPageId ? { parentPageId } : {}),
        })
      ).pageId;
    const before = await liveRedirectState();

    // A new page on a live rule's URL.
    const created = await create(`${PFX}-created`);
    // A rename onto a rule, then the refresh a plugin runs.
    const renamed = await create(`${PFX}-before-rename`);
    await run(chat, "pages.update", { pageId: renamed, slug: `${PFX}-renamed` });
    await run(chat, "pages.refresh_current_path", { pageId: renamed, redirectFromOld: "auto" });
    // A copy landing on a rule.
    await run(chat, "pages.duplicate", { sourcePageId: created, newSlug: `${PFX}-copy` });
    // A parent's move dragging its child onto a rule.
    const parent = await create(`${PFX}-parent-before`);
    await create(`${PFX}-kid`, parent);
    await run(chat, "pages.move_many", {
      moves: [{ pageId: parent, parentPageId: null, newSlug: `${PFX}-parent-after` }],
    });
    await run(chat, "pages.refresh_current_path", { pageId: parent });
    // A delete that asks for a dead-URL redirect from a path holding a rule.
    const deleted = await create(`${PFX}-deleted`);
    await run(chat, "pages.delete", {
      pageId: deleted,
      disposition: "redirect",
      redirectTo: `/${PFX}-elsewhere`,
    });
    // A page leaving a path whose rule points elsewhere.
    const leaving = await create(`${PFX}-old-path-page`);
    await run(chat, "pages.update", { pageId: leaving, slug: `${PFX}-old-path` });
    await run(chat, "pages.refresh_current_path", { pageId: leaving });

    expect(await liveRedirectState()).toEqual(before);
  });
});
