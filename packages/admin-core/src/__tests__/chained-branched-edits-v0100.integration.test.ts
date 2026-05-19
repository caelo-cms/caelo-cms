// SPDX-License-Identifier: MPL-2.0

/**
 * v0.10.0 — Chained branched edits compose without losing intermediate
 * state.
 *
 * Pre-v0.10.0 the branched-write path of `pages.update` and
 * `modules.update` built each new snapshot's state from the LIVE row +
 * input. Branched writes don't touch the live row, so chained edits
 * silently lost each other's changes:
 *
 *   1. Edit 1 (title='B'): live still 'A'; snapshot 1: state.title='B'.
 *   2. Edit 2 (slug='y'): handler reads `existing.title='A'` from live;
 *      snapshot 2: state.title='A', state.slug='y'. Snapshot 1 lost.
 *   3. Merge applies snapshot 2 → live.title='A'. Edit 1's 'B' is gone.
 *
 * v0.10.0 changes the branched paths to read base state from the LATEST
 * branched snapshot (via `loadPageStateWithBranchOverlay` and
 * `loadModuleStateWithBranchOverlay`), so chained edits compose.
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
  requestId: "v0100-chain",
};

const TPL_SLUG = "v0100-chain-tpl";
const PAGE_SLUG = "v0100-chain-pg";
const MODULE_SLUG = "v0100-chain-mod";
const SESSION_TITLE = "v0100-chain-session";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'v0100-chain-%'`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG} OR slug = ${`${PAGE_SLUG}-renamed`}`;
      await tx`DELETE FROM modules WHERE slug = ${MODULE_SLUG}`;
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

describe("v0.10.0 chained branched edits", () => {
  it("chained pages.update on same branch preserves both edits at merge", async () => {
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
      requestId: "v0100-chain-ai",
      chatBranchId,
    };

    // Edit 1: title='Branched Title' on this branch.
    const edit1 = await execute(registry, adapter, aiCtx, "pages.update", {
      pageId,
      title: "Branched Title",
    });
    expect(edit1.ok).toBe(true);

    // Edit 2: slug='renamed' on the SAME branch. Pre-v0.10.0 this snapshot
    // would carry title='Original Title' (read from live), losing edit 1.
    const edit2 = await execute(registry, adapter, aiCtx, "pages.update", {
      pageId,
      slug: `${PAGE_SLUG}-renamed`,
    });
    expect(edit2.ok).toBe(true);

    // Inspect the LATEST branched snapshot — should carry BOTH edits.
    const sql = new SQL(ADMIN_URL as string);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
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
        // The regression check: title MUST be the value edit 1 set,
        // not the live row's pre-edit value.
        expect(state.title).toBe("Branched Title");
      });
    } finally {
      await sql.end();
    }

    // Merge to main — live row must reflect both edits.
    const merge = await execute(registry, adapter, HUMAN, "chat.merge_to_main", {
      chatSessionId,
    });
    expect(merge.ok).toBe(true);

    const sql2 = new SQL(ADMIN_URL as string);
    try {
      await sql2.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const live = (await tx`
          SELECT slug, title FROM pages WHERE id = ${pageId}::uuid
        `) as unknown as { slug: string; title: string }[];
        expect(live[0]?.slug).toBe(`${PAGE_SLUG}-renamed`);
        expect(live[0]?.title).toBe("Branched Title");
      });
    } finally {
      await sql2.end();
    }
  });

  it("chained modules.update on same branch preserves both edits at merge", async () => {
    const mod = await execute(registry, adapter, HUMAN, "modules.create", {
      slug: MODULE_SLUG,
      displayName: "M",
      html: "<div>orig</div>",
      css: ".a{}",
      js: "",
    });
    if (!mod.ok) throw new Error("mod");
    const moduleId = (mod.value as { moduleId: string }).moduleId;

    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: `${SESSION_TITLE}-mod`,
    });
    if (!session.ok) throw new Error("session");
    const { chatSessionId, chatBranchId } = session.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    const aiCtx: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1b",
      actorKind: "ai",
      requestId: "v0100-chain-mod-ai",
      chatBranchId,
    };

    // Edit 1: html change.
    const e1 = await execute(registry, adapter, aiCtx, "modules.update", {
      moduleId,
      html: "<div>edited-html</div>",
    });
    expect(e1.ok).toBe(true);

    // Edit 2: css change on the SAME branch. Pre-v0.10.0 the snapshot
    // would carry html='<div>orig</div>' (read from live), dropping edit 1.
    const e2 = await execute(registry, adapter, aiCtx, "modules.update", {
      moduleId,
      css: ".b{}",
    });
    expect(e2.ok).toBe(true);

    // Merge — live module must reflect both edits.
    const merge = await execute(registry, adapter, HUMAN, "chat.merge_to_main", {
      chatSessionId,
    });
    expect(merge.ok).toBe(true);

    const sql = new SQL(ADMIN_URL as string);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const live = (await tx`
          SELECT html, css FROM modules WHERE id = ${moduleId}::uuid
        `) as unknown as { html: string; css: string }[];
        expect(live[0]?.html).toBe("<div>edited-html</div>");
        expect(live[0]?.css).toBe(".b{}");
      });
    } finally {
      await sql.end();
    }
  });
});
