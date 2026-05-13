// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.3 — branched pages.update.
 *
 * Pre-v0.5.3 `pages.update` wrote live unconditionally even when
 * ctx.chatBranchId was set, meaning slug/title edits from one chat
 * were visible to every other chat immediately. v0.5.3 routes
 * branched writes through page_snapshots and leaves live untouched
 * until publish.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "v053-pg",
};

const PAGE_SLUG = "v053-pg-test";
const TPL_SLUG = "v053-pg-tpl";
const SESSION_TITLE = "v053-pg-session";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'v053-pg-%'`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG} OR slug = ${`${PAGE_SLUG}-renamed`}`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("pages branched writes (v0.5.3)", () => {
  it("branched pages.update skips live UPDATE + lands a branched snapshot; publish merges", async () => {
    // Seed: template + page.
    const tpl = await execute(registry, adapter, HUMAN, "templates.create", {
      slug: TPL_SLUG,
      displayName: "T",
      html: "<main>{{content}}</main>",
      css: "",
    });
    if (!tpl.ok) throw new Error("tpl");
    const templateId = (tpl.value as { templateId: string }).templateId;

    const page = await execute(registry, adapter, HUMAN, "pages.create", {
      slug: PAGE_SLUG,
      locale: "en",
      title: "Original Title",
      templateId,
      status: "draft",
    });
    if (!page.ok) throw new Error("page");
    const pageId = (page.value as { pageId: string }).pageId;

    // Chat session — gives us a branch.
    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: SESSION_TITLE,
    });
    if (!session.ok) throw new Error("session");
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    const aiCtx: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "v053-pg-ai",
      chatBranchId,
    };

    // Branched update — rename + retitle.
    const upd = await execute(registry, adapter, aiCtx, "pages.update", {
      pageId,
      slug: `${PAGE_SLUG}-renamed`,
      title: "Branched Title",
    });
    expect(upd.ok).toBe(true);

    // Live row still carries the seed values.
    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const live = (await tx`
          SELECT slug, title FROM pages WHERE id = ${pageId}::uuid
        `) as unknown as { slug: string; title: string }[];
        expect(live[0]?.slug).toBe(PAGE_SLUG);
        expect(live[0]?.title).toBe("Original Title");

        const snap = (await tx`
          SELECT ps.state FROM page_snapshots ps
          JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
          WHERE ps.page_id = ${pageId}::uuid
            AND ss.chat_branch_id = ${chatBranchId}::uuid
          ORDER BY ss.created_at DESC LIMIT 1
        `) as unknown as { state: string | { slug: string; title: string } }[];
        const raw = snap[0]?.state;
        const state =
          typeof raw === "string"
            ? (JSON.parse(raw) as { slug: string; title: string })
            : (raw as { slug: string; title: string });
        expect(state.slug).toBe(`${PAGE_SLUG}-renamed`);
        expect(state.title).toBe("Branched Title");
      });
    } finally {
      await sql.end();
    }

    // Publish merges branched values into live.
    const pub = await execute(registry, adapter, HUMAN, "chat.publish", {
      chatSessionId,
    });
    expect(pub.ok).toBe(true);
  });
});
