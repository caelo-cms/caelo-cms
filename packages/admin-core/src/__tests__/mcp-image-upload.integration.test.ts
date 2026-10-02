// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { FixtureProvider } from "../ai/providers/anthropic.js";
import { LocalVolumeAdapter, setMediaStorage } from "../media/storage.js";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";

const adminUrl = process.env.ADMIN_DATABASE_URL!;
const adapter = new DatabaseAdapter({
  adminDatabaseUrl: adminUrl,
  publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL!,
});
const registry = new OperationRegistry();
registerAdminOps(registry);
const db = new SQL(adminUrl);
const actorId = crypto.randomUUID();
const system = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "mcp-images-test",
};
const human = { ...system, actorId, actorKind: "human" as const };
const provider = new FixtureProvider([
  { kind: "text-delta", text: "Image received." },
  { kind: "usage", inputTokens: 10, outputTokens: 3, cachedTokens: 0 },
  { kind: "done", stopReason: "end_turn" },
]);
const root = await mkdtemp(join(tmpdir(), "caelo-mcp-media-"));
const storage = new LocalVolumeAdapter(root);

beforeAll(async () => {
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${actorId}::uuid, 'human', 'Upload test')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${actorId}::uuid, ${`${actorId}@example.test`}, 'unused')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${actorId}::uuid, id FROM roles WHERE name = 'editor'`;
  });
  setMediaStorage(storage, "local");
  configureMcpBridge({ adapter, registry, resolveProvider: async () => provider });
});
afterAll(async () => {
  await adapter.close();
  await db.end();
  await rm(root, { recursive: true });
});
async function mint(scope: "chat" | "admin") {
  const result = await execute(registry, adapter, human, "mcp_tokens.create", {
    displayName: "image-test",
    scope,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value as { id: string; plaintextToken: string };
}
async function authorize(plaintextToken: string) {
  return execute(registry, adapter, system, "mcp.authorize_upload", { plaintextToken });
}

test("chat and admin tokens authorize uploads; revoked, expired, removed-role and deleted users do not", async () => {
  for (const scope of ["chat", "admin"] as const) {
    const token = await mint(scope);
    expect((await authorize(token.plaintextToken)).ok).toBe(true);
    await execute(registry, adapter, human, "mcp_tokens.revoke", { id: token.id });
    expect((await authorize(token.plaintextToken)).ok).toBe(false);
  }
  expect((await authorize("mcp_unknown_token")).ok).toBe(false);
  const token = await mint("chat");
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`UPDATE mcp_tokens SET expires_at = now() - interval '1 day' WHERE id = ${token.id}::uuid`;
  });
  expect((await authorize(token.plaintextToken)).ok).toBe(false);
  const valid = await mint("chat");
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`DELETE FROM user_roles WHERE user_id = ${actorId}::uuid`;
  });
  expect((await authorize(valid.plaintextToken)).ok).toBe(false);
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${actorId}::uuid, id FROM roles WHERE name = 'editor'`;
    await tx`UPDATE users SET deleted_at = now() WHERE id = ${actorId}::uuid`;
  });
  expect((await authorize(valid.plaintextToken)).ok).toBe(false);
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`UPDATE users SET deleted_at = NULL WHERE id = ${actorId}::uuid`;
  });
});

test("MCP image reaches the model as image content and survives session replay", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=",
    "base64",
  );
  await storage.put("mcp-test/orig.png", png, "image/png");
  const upload = await execute(registry, adapter, human, "media.upload", {
    sha256: "e".repeat(64),
    originalName: "mcp-reference.png",
    mime: "image/png",
    sizeBytes: png.length,
    width: 1,
    height: 1,
    alt: "Reference",
    storageKey: "mcp-test/orig.png",
    storageProvider: "local",
    variants: [
      {
        variant: "orig",
        format: "png",
        width: 1,
        height: 1,
        sizeBytes: png.length,
        storageKey: "mcp-test/orig.png",
      },
    ],
  });
  if (!upload.ok) throw new Error(JSON.stringify(upload.error));
  const attachment = {
    assetId: (upload.value as { assetId: string }).assetId,
    mime: "image/png",
    alt: "Reference",
  };
  const token = await mint("chat");
  const reply = await execute(registry, adapter, system, "mcp.send_chat", {
    plaintextToken: token.plaintextToken,
    message: "Describe this reference",
    attachments: [attachment],
  });
  if (!reply.ok) throw new Error(JSON.stringify(reply.error));
  expect(JSON.stringify(provider.seenPrompts)).toContain('"mediaType":"image/png"');
  const { chatSessionId } = reply.value as { chatSessionId: string };
  const history = await execute(registry, adapter, human, "chat.get_session", { chatSessionId });
  expect(JSON.stringify(history)).toContain(attachment.assetId);
  const promptsBefore = provider.seenPrompts.length;
  const again = await execute(registry, adapter, system, "mcp.send_chat", {
    plaintextToken: token.plaintextToken,
    chatSessionId,
    message: "Keep that character for page two",
  });
  if (!again.ok) throw new Error(JSON.stringify(again.error));
  expect(JSON.stringify(provider.seenPrompts.slice(promptsBefore))).toContain(
    '"mediaType":"image/png"',
  );
});

test("MCP cannot supply arbitrary storage keys or more than four attachments", async () => {
  for (const attachments of [
    [{ storageKey: "private/secret", mime: "image/png" }],
    Array(5).fill({ assetId: actorId, mime: "image/png" }),
  ]) {
    const r = await execute(registry, adapter, system, "mcp.send_chat", {
      plaintextToken: "mcp_invalid",
      message: "x",
      attachments,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("ValidationFailed");
  }
});
