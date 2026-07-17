// SPDX-License-Identifier: MPL-2.0

/**
 * Coverage for the media tools that had no dedicated test:
 * find_media (match + no-match), set_media_alt, generate_image
 * (no-image-provider path — the test DB has no OpenAI/Google image
 * provider, so the tool must fail loud, not throw). Real Postgres (§6).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { findMediaTool } from "../ai/tools/find-media.js";
import { generateImageTool } from "../ai/tools/generate-image.js";
import { setMediaAltTool } from "../ai/tools/set-media-alt.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "media-tools-int",
};

// sha256 is [0-9a-f]{64}; the searchable token lives in the filename, not here.
const PFX = "cafe1234";
const SHA = `${PFX}${"a".repeat(64 - PFX.length)}`;
let assetId: string;
const toolCtx = () => ({ adapter, registry }) as ToolContext;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM media_assets WHERE sha256 LIKE ${`${PFX}%`}`;
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
  const up = await execute(registry, adapter, SYSTEM, "media.upload", {
    sha256: SHA,
    originalName: "mtcafe-hero.jpg",
    mime: "image/jpeg",
    sizeBytes: 12345,
    width: 1920,
    height: 1080,
    alt: "",
    storageKey: `${SHA}/orig.jpg`,
    variants: [
      {
        variant: "orig",
        format: "jpeg",
        width: 1920,
        height: 1080,
        sizeBytes: 12345,
        storageKey: `${SHA}/orig.jpg`,
      },
      {
        variant: "webp-800",
        format: "webp",
        width: 800,
        height: 450,
        sizeBytes: 4567,
        storageKey: `${SHA}/webp-800.webp`,
      },
    ],
  });
  if (!up.ok) throw new Error("seed upload");
  assetId = (up.value as { assetId: string }).assetId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("find_media", () => {
  it("returns a match with a resolved URL when the query hits", async () => {
    const r = await findMediaTool.handler(SYSTEM, { filter: "mtcafe-hero" }, toolCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain("mtcafe-hero.jpg");
    // The URL points at an existing variant, not a fabricated one.
    expect(r.content).toContain(assetId);
  });

  it("returns a clean no-match message (not an error) when nothing hits", async () => {
    const r = await findMediaTool.handler(SYSTEM, { filter: "no-such-asset-zzz-98765" }, toolCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain("No media matched");
  });
});

describe("set_media_alt", () => {
  it("writes the alt text on an asset", async () => {
    const r = await setMediaAltTool.handler(
      SYSTEM,
      { assetId, alt: "A sunlit cafe storefront" },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    // Reads back through the media getter.
    const got = await execute(registry, adapter, SYSTEM, "media.get", { assetId });
    if (!got.ok) throw new Error("media.get");
    expect((got.value as { asset: { alt: string } }).asset.alt).toBe("A sunlit cafe storefront");
  });
});

describe("generate_image", () => {
  it("fails loudly (no throw) when no image-capable provider is configured", async () => {
    const r = await generateImageTool.handler(SYSTEM, { prompt: "a red bicycle" }, toolCtx());
    // The test DB has no active OpenAI/Google image provider, so the tool
    // returns a structured ok:false pointing at the missing config — it must
    // never throw or claim success.
    expect(r.ok).toBe(false);
    expect(r.content).toContain("generate_image");
  });
});
