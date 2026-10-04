// SPDX-License-Identifier: MPL-2.0

/**
 * #527 / #532 — the chat's generate_image runs the shared image
 * lifecycle: references from the media library, budget reserved before the
 * paid call, replay-safe request ids, provenance on the media row. Uses the
 * test-only fake image provider (no network, no cost).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import sharp from "sharp";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { generateImageTool } from "../ai/tools/generate-image.js";
import { getImageCapabilitiesTool } from "../ai/tools/get-image-capabilities.js";
import { runMediaPipeline } from "../media/pipeline.js";
import { getMediaStorage, LocalVolumeAdapter, setMediaStorage } from "../media/storage.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "chat-image-requests",
};
const AI: ExecutionContext = { ...SYSTEM, actorKind: "ai" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let chatSessionId = "";
let referenceId = "";
let referenceSha = "";
const mediaRoot = mkdtempSync(join(tmpdir(), "caelo-chat-images-"));

const toolCtx = (toolCallId: string): ToolContext =>
  ({ adapter, registry, chatSessionId, toolCallId }) as ToolContext;

async function sql<T>(run: (tx: SQL) => Promise<T>): Promise<T> {
  const db = new SQL(ADMIN_URL!);
  try {
    return await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return run(tx as unknown as SQL);
    });
  } finally {
    await db.end();
  }
}

const requestsInSession = () =>
  sql(
    async (tx) =>
      (await tx`SELECT status, prompt, references_json FROM image_requests WHERE scope = ${`chat:${chatSessionId}`}`) as unknown as {
        status: string;
        prompt: string;
        references_json: { id: string; sha256: string }[];
      }[],
  );
const callsInSession = () =>
  sql(async (tx) =>
    Number(
      (
        (await tx`SELECT count(*)::int AS n FROM ai_calls WHERE chat_session_id = ${chatSessionId}::uuid AND operation_type = 'image'`) as unknown as {
          n: number;
        }[]
      )[0]?.n ?? 0,
    ),
  );

beforeAll(async () => {
  process.env.CAELO_FAKE_IMAGE_PROVIDER = "1";
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setMediaStorage(new LocalVolumeAdapter(mediaRoot));

  const session = await execute(registry, adapter, SYSTEM, "chat.create_session", {
    title: "chat image requests",
  });
  if (!session.ok) throw new Error(JSON.stringify(session.error));
  chatSessionId = (session.value as { chatSessionId: string }).chatSessionId;

  // A real PNG in storage, as an operator upload would leave it.
  const png = new Uint8Array(
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "#c33" } })
      .png()
      .toBuffer(),
  );
  referenceSha = new Bun.CryptoHasher("sha256").update(png).digest("hex");
  const pipeline = await runMediaPipeline(referenceSha, "image/png", png);
  for (const v of pipeline.variants)
    await getMediaStorage().put(v.storageKey, v.body, v.contentType);
  const up = await execute(registry, adapter, SYSTEM, "media.upload", {
    sha256: referenceSha,
    originalName: "character.png",
    name: "Character sheet",
    mime: "image/png",
    sizeBytes: png.byteLength,
    width: pipeline.width,
    height: pipeline.height,
    alt: "character sheet",
    storageKey: pipeline.variants[0]!.storageKey,
    variants: pipeline.variants.map((v) => ({
      variant: v.variant,
      format: v.format,
      width: v.width,
      height: v.height,
      sizeBytes: v.sizeBytes,
      storageKey: v.storageKey,
    })),
  });
  if (!up.ok) throw new Error(JSON.stringify(up.error));
  referenceId = (up.value as { assetId: string }).assetId;
});

afterAll(async () => {
  await sql(async (tx) => {
    await tx`DELETE FROM ai_budgets WHERE operation_type = 'image'`;
    await tx`DELETE FROM image_requests WHERE scope = ${`chat:${chatSessionId}`}`;
    await tx`DELETE FROM ai_calls WHERE chat_session_id = ${chatSessionId}::uuid`;
  });
  await adapter.close();
  rmSync(mediaRoot, { recursive: true, force: true });
});

test("generate_image with a reference records provenance and is replay-safe", async () => {
  const input = generateImageTool.schema.parse({
    prompt: "the same character waving",
    references: [referenceId],
    altText: "character waving",
  });
  const first = await generateImageTool.handler(AI, input, toolCtx("toolu_ref_1"));
  expect(first.ok).toBe(true);
  const mediaId = /mediaId=([0-9a-f-]{36})/.exec(first.content)?.[1];
  expect(mediaId).toBeDefined();

  const rows = await requestsInSession();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("ready");
  expect(rows[0]!.references_json[0]).toMatchObject({ id: referenceId, sha256: referenceSha });

  const got = await execute(registry, adapter, AI, "media.get", { assetId: mediaId! });
  const generation = (
    got.value as { asset: { generation: { prompt: string; references: { id: string }[] } } }
  ).asset.generation;
  expect(generation.prompt).toBe("the same character waving");
  expect(generation.references[0]!.id).toBe(referenceId);

  // The same tool call again (a replay) returns the recorded image and pays nothing more.
  const calls = await callsInSession();
  const replay = await generateImageTool.handler(AI, input, toolCtx("toolu_ref_1"));
  expect(replay.ok).toBe(true);
  expect(replay.content).toContain(mediaId!);
  expect(await callsInSession()).toBe(calls);
  expect(await requestsInSession()).toHaveLength(1);
});

test("an exhausted image budget refuses before the provider call", async () => {
  const set = await execute(registry, adapter, SYSTEM, "ai_budgets.set", {
    scope: "day-global",
    operationType: "image",
    capMicrocents: 0,
  });
  expect(set.ok).toBe(true);
  const calls = await callsInSession();
  const refused = await generateImageTool.handler(
    AI,
    generateImageTool.schema.parse({ prompt: "another image" }),
    toolCtx("toolu_budget"),
  );
  expect(refused.ok).toBe(false);
  expect(refused.content).toContain("ImageBudgetExceeded");
  expect(await callsInSession()).toBe(calls);
  await sql(async (tx) => tx`DELETE FROM ai_budgets WHERE operation_type = 'image'`);
});

test("requests outside the model's capabilities are refused before anything is reserved", async () => {
  const before = (await requestsInSession()).length;
  const tooMany = await generateImageTool.handler(
    AI,
    generateImageTool.schema.parse({
      prompt: "x",
      references: Array.from({ length: 14 }, () => referenceId),
    }),
    toolCtx("toolu_ok_14"),
  );
  expect(tooMany.ok).toBe(true);
  const unsupported = await generateImageTool.handler(
    AI,
    { ...generateImageTool.schema.parse({ prompt: "y" }), size: "800x600" as never },
    toolCtx("toolu_bad_size"),
  );
  expect(unsupported.ok).toBe(false);
  expect(unsupported.content).toContain("get_image_capabilities");
  expect((await requestsInSession()).length).toBe(before + 1);
});

test("get_image_capabilities reports the configured model's limits", async () => {
  const r = await getImageCapabilitiesTool.handler(AI, {}, toolCtx("toolu_caps"));
  expect(r.ok).toBe(true);
  const caps = JSON.parse(r.content) as { operations: string[]; references: { max: number } };
  expect(caps.operations).toContain("generate");
  expect(caps.references.max).toBeGreaterThan(0);
});
