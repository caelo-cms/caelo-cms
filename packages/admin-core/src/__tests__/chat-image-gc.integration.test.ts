// SPDX-License-Identifier: MPL-2.0

/**
 * issue #356 — the chat-image sweep, against a real Postgres.
 *
 * Two properties are easy to get wrong and expensive if you do:
 *
 *   - keys are content-addressed, so an unchanged page screenshotted in two
 *     chats is ONE object. Deleting it because one chat aged out would blind
 *     the other, mid-conversation;
 *   - the aged rows must lose their reference, so replaying an old transcript
 *     does not attempt a read that can only fail.
 *
 * The sweep is DB-driven (the storage adapter has no `list()`), so these are
 * decided by SQL and deserve a real database rather than a stub.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { buildChatImageKey } from "@caelo-cms/shared";
import { SQL } from "bun";

import { sweepChatImagesOnce } from "../chat-image-gc-worker.js";
import { getMediaStorage, LocalVolumeAdapter, setMediaStorage } from "../media/storage.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "chat-image-gc-test",
};

const SHA_OLD = "a".repeat(64);
const SHA_SHARED = "b".repeat(64);
const KEY_OLD = buildChatImageKey("2020-01-01", SHA_OLD, "png");
const KEY_SHARED = buildChatImageKey("2020-01-01", SHA_SHARED, "png");

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_messages WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE 'imggc-%')`;
      await tx`DELETE FROM chat_sessions WHERE title LIKE 'imggc-%'`;
    });
  } finally {
    await sql.end();
  }
}

/** Age a message by rewriting created_at — the sweep keys off it. */
async function backdate(messageId: string, days: number): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`UPDATE chat_messages SET created_at = now() - make_interval(days => ${days}) WHERE id = ${messageId}::uuid`;
    });
  } finally {
    await sql.end();
  }
}

async function appendWithImage(sessionId: string, storageKey: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "chat.append_message", {
    chatSessionId: sessionId,
    role: "tool",
    content: "screenshot captured",
    toolCallId: `toolu_${Math.abs(storageKey.length * 7)}`,
    attachments: [{ storageKey, mime: "image/png", alt: "test shot" }],
  });
  if (!r.ok) throw new Error(`append failed: ${JSON.stringify(r.error)}`);
  return (r.value as { messageId: string }).messageId;
}

async function newSession(title: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "chat.create_session", { title });
  if (!r.ok) throw new Error("session create failed");
  return (r.value as { chatSessionId: string }).chatSessionId;
}

let mediaRoot: string;

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  mediaRoot = await mkdtemp(join(tmpdir(), "chat-image-gc-"));
  setMediaStorage(new LocalVolumeAdapter(mediaRoot));
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  await getMediaStorage().put(KEY_OLD, png, "image/png");
  await getMediaStorage().put(KEY_SHARED, png, "image/png");
});

afterAll(async () => {
  await wipe();
  await rm(mediaRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("chat-image GC sweep (issue #356)", () => {
  it("deletes an aged image, keeps one a live message still shares, and clears the aged reference", async () => {
    const oldSession = await newSession("imggc-old");
    const liveSession = await newSession("imggc-live");

    // Only referenced by an aged message → deletable.
    const agedOnly = await appendWithImage(oldSession, KEY_OLD);
    // Content-addressed collision: the SAME object referenced by an aged
    // message AND a current one. The live chat must not be blinded.
    const agedShared = await appendWithImage(oldSession, KEY_SHARED);
    await appendWithImage(liveSession, KEY_SHARED);

    await backdate(agedOnly, 30);
    await backdate(agedShared, 30);

    const result = await sweepChatImagesOnce({ adapter, staleAfterMs: 7 * 24 * 60 * 60 * 1000 });

    expect(result.deletedObjects).toBe(1);
    expect(result.keptShared).toBe(1);
    expect(result.clearedRows).toBe(2);

    expect(await getMediaStorage().exists(KEY_OLD)).toBe(false);
    // Still readable for the conversation that is still using it.
    expect(await getMediaStorage().exists(KEY_SHARED)).toBe(true);

    // Aged rows lost their reference; the live one kept it.
    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT m.attachments::text AS att, s.title
            FROM chat_messages m JOIN chat_sessions s ON s.id = m.chat_session_id
           WHERE s.title LIKE 'imggc-%' AND m.role = 'tool'
        `) as unknown as { att: string | null; title: string }[];
        const aged = rows.filter((r) => r.title === "imggc-old");
        const live = rows.filter((r) => r.title === "imggc-live");
        expect(aged.every((r) => r.att === null)).toBe(true);
        expect(live.every((r) => r.att !== null)).toBe(true);
      });
    } finally {
      await sql.end();
    }
  });

  it("is idempotent — a second sweep finds nothing left to do", async () => {
    const result = await sweepChatImagesOnce({ adapter, staleAfterMs: 7 * 24 * 60 * 60 * 1000 });
    expect(result.deletedObjects).toBe(0);
    expect(result.clearedRows).toBe(0);
  });
});
