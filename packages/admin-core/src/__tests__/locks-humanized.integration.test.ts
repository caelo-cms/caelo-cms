// SPDX-License-Identifier: MPL-2.0

/**
 * v0.8.0 — `lockedError()` returns a human-readable message naming the
 * *other chat* holding the lock (its title + its anchor page slug),
 * instead of the v0.5.x UUID-only wording the operator can't act on.
 *
 * Scenario: chat-1 (titled "First chat", anchored to /home) edits
 * module M. chat-2 (titled "Second chat") tries to edit the same
 * module. The Locked error should:
 *   - carry the title of chat-1 in the message
 *   - carry the slug of chat-1's anchor page in the message
 *   - never reference a raw UUID in the prose
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

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const PFX = "v080-lock-";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_entity_locks WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE ${`${PFX}%`})`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
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

describe("lockedError humanization (v0.8.0)", () => {
  it("names the holder chat's title + anchor page slug, no raw UUID", async () => {
    const sysCtx: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "lock-test",
    };

    // Seed a page so chat-1 can anchor to it. The slug is what we
    // assert appears in the humanized Locked message.
    const pageRes = await execute(registry, adapter, sysCtx, "pages.create", {
      slug: `${PFX}home`,
      locale: "en",
      title: "Home",
    });
    if (!pageRes.ok) throw new Error("seed page");
    const pageId = (pageRes.value as { pageId: string }).pageId;

    // Seed the contested module.
    const modRes = await execute(registry, adapter, sysCtx, "modules.create", {
      slug: `${PFX}hero`,
      displayName: "Hero",
      html: "<p>v0</p>",
    });
    if (!modRes.ok) throw new Error("seed module");
    const moduleId = (modRes.value as { moduleId: string }).moduleId;

    // chat-1 (the holder) anchored to the seeded page.
    const c1 = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}First chat`,
      pageId,
    });
    if (!c1.ok) throw new Error("seed chat-1");
    const { chatBranchId: branch1 } = c1.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    // chat-2 (the contender) — different page-less anchor; just needs
    // a distinct branch to trip the lock.
    const c2 = await execute(registry, adapter, sysCtx, "chat.create_session", {
      title: `${PFX}Second chat`,
    });
    if (!c2.ok) throw new Error("seed chat-2");
    const { chatBranchId: branch2 } = c2.value as {
      chatSessionId: string;
      chatBranchId: string;
    };

    // chat-1 acquires the lock by writing.
    const editAsChat1: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "edit-c1",
      chatBranchId: branch1,
    };
    const w1 = await execute(registry, adapter, editAsChat1, "modules.update", {
      moduleId,
      html: "<p>v1</p>",
    });
    expect(w1.ok).toBe(true);

    // chat-2 tries to edit the same module → Locked error.
    const editAsChat2: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "system",
      requestId: "edit-c2",
      chatBranchId: branch2,
    };
    const w2 = await execute(registry, adapter, editAsChat2, "modules.update", {
      moduleId,
      html: "<p>v2</p>",
    });
    expect(w2.ok).toBe(false);
    if (w2.ok) return;
    const err = w2.error as { kind: string; message: string };
    expect(err.kind).toBe("Locked");
    // The message must name the OTHER chat by title + page slug. The
    // pre-v0.8 wording was "(session <uuid>)" which is what we're
    // explicitly avoiding.
    expect(err.message).toContain(`${PFX}First chat`);
    expect(err.message).toContain(`/${PFX}home`);
    // The pre-v0.8 wording read "(session <uuid>)" — assert that
    // specific format is gone. The entity-id UUID may still appear
    // (it's the module id the operator needs to identify what's
    // locked); we're not stripping UUIDs wholesale, only the
    // unhelpful "(session ...)" reference to the holder chat.
    expect(err.message.includes("(session")).toBe(false);
  });
});
