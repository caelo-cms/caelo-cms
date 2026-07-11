// SPDX-License-Identifier: MPL-2.0

/**
 * issue #190 — attachments persist through the append → get_session
 * round-trip (real Postgres; migration 0111). Persistence is what
 * makes attachments different from the runtime-only screenshot path:
 * a reloaded transcript must still know which images rode which turn.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ChatAttachment, ExecutionContext } from "@caelo-cms/shared";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue190-attachments",
};

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await adapter.close();
});

describe("chat attachments round-trip (#190)", () => {
  it("append with attachments → get_session returns them; plain messages stay null", async () => {
    const created = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      title: "issue190-attachments",
    });
    expect(created.ok).toBe(true);
    const sessionId = (created.value as { chatSessionId: string }).chatSessionId;

    const attachments: ChatAttachment[] = [
      { assetId: "11111111-1111-4111-8111-111111111111", mime: "image/png", alt: "mockup" },
      { assetId: "22222222-2222-4222-8222-222222222222", mime: "image/jpeg" },
    ];
    const withAtts = await execute(registry, adapter, SYSTEM, "chat.append_message", {
      chatSessionId: sessionId,
      role: "user",
      content: "use this design",
      attachments,
    });
    expect(withAtts.ok).toBe(true);
    const plain = await execute(registry, adapter, SYSTEM, "chat.append_message", {
      chatSessionId: sessionId,
      role: "assistant",
      content: "on it",
    });
    expect(plain.ok).toBe(true);

    const got = await execute(registry, adapter, SYSTEM, "chat.get_session", {
      chatSessionId: sessionId,
    });
    expect(got.ok).toBe(true);
    const messages = (
      got.value as {
        messages: { role: string; content: string; attachments: ChatAttachment[] | null }[];
      }
    ).messages;
    const userMsg = messages.find((m) => m.content === "use this design");
    expect(userMsg?.attachments).toEqual(attachments);
    const assistantMsg = messages.find((m) => m.content === "on it");
    expect(assistantMsg?.attachments).toBeNull();
  });

  it("rejects more than CHAT_MAX_ATTACHMENTS at the op boundary", async () => {
    const created = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      title: "issue190-cap",
    });
    const sessionId = (created.value as { chatSessionId: string }).chatSessionId;
    const five = Array.from({ length: 5 }, (_, i) => ({
      assetId: `33333333-3333-4333-8333-33333333333${i}`,
      mime: "image/png" as const,
    }));
    const r = await execute(registry, adapter, SYSTEM, "chat.append_message", {
      chatSessionId: sessionId,
      role: "user",
      content: "too many",
      attachments: five,
    });
    expect(r.ok).toBe(false);
  });
});
