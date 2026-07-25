// SPDX-License-Identifier: MPL-2.0

/**
 * 0181 — media provenance integration tests.
 *
 *  - media.upload with sourceKind/sourceDetail/license persists them and
 *    media.list + media.get return them.
 *  - media.set_source updates the licence on an existing asset, and its
 *    COALESCE semantics leave the other fields intact when omitted.
 *  - a plain upload with no source fields returns nulls.
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

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "media-source-integration-test",
};

// Stable sha prefix so wipe() can scrub even if a prior run failed.
const TEST_PREFIX = "5ec0de5c";
const SHA_PROVENANCE = `${TEST_PREFIX}${"a".repeat(56)}`;
const SHA_PLAIN = `${TEST_PREFIX}${"b".repeat(56)}`;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM media_assets WHERE sha256 LIKE ${`${TEST_PREFIX}%`}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

function uploadInput(
  sha: string,
  extra: Record<string, unknown> = {},
): Parameters<typeof execute>[4] {
  return {
    sha256: sha,
    originalName: `${sha.slice(0, 8)}.jpg`,
    mime: "image/jpeg",
    sizeBytes: 12345,
    width: 1920,
    height: 1080,
    alt: "",
    storageKey: `${sha}/orig.jpg`,
    variants: [
      {
        variant: "orig",
        format: "jpeg",
        width: 1920,
        height: 1080,
        sizeBytes: 12345,
        storageKey: `${sha}/orig.jpg`,
      },
    ],
    ...extra,
  };
}

type Provenance = {
  id: string;
  sha256: string;
  sourceKind: string | null;
  sourceDetail: string | null;
  license: string | null;
};

describe("0181 media provenance", () => {
  it("media.upload persists source fields; media.list + media.get return them", async () => {
    const up = await execute(
      registry,
      adapter,
      systemCtx,
      "media.upload",
      uploadInput(SHA_PROVENANCE, {
        sourceKind: "imported",
        sourceDetail: "https://example.com/photo.jpg",
        license: "CC-BY-4.0",
      }),
    );
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    const assetId = (up.value as { assetId: string }).assetId;

    const get = await execute(registry, adapter, systemCtx, "media.get", { assetId });
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    const asset = (get.value as { asset: Provenance | null }).asset!;
    expect(asset.sourceKind).toBe("imported");
    expect(asset.sourceDetail).toBe("https://example.com/photo.jpg");
    expect(asset.license).toBe("CC-BY-4.0");

    const list = await execute(registry, adapter, systemCtx, "media.list", {
      limit: 60,
      offset: 0,
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const listed = (list.value as { assets: Provenance[] }).assets.find(
      (a) => a.sha256 === SHA_PROVENANCE,
    );
    expect(listed).toBeDefined();
    expect(listed?.sourceKind).toBe("imported");
    expect(listed?.sourceDetail).toBe("https://example.com/photo.jpg");
    expect(listed?.license).toBe("CC-BY-4.0");
  });

  it("media.set_source updates licence and COALESCE leaves other fields intact", async () => {
    // The asset uploaded above has kind=imported, a source URL, and an
    // initial licence. Patch ONLY the licence.
    const get0 = await execute(registry, adapter, systemCtx, "media.list", {
      limit: 60,
      offset: 0,
    });
    if (!get0.ok) throw new Error("list failed");
    const target = (get0.value as { assets: Provenance[] }).assets.find(
      (a) => a.sha256 === SHA_PROVENANCE,
    );
    expect(target).toBeDefined();
    const assetId = target!.id;

    const set = await execute(registry, adapter, systemCtx, "media.set_source", {
      assetId,
      license: "CC0-1.0",
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;

    const get = await execute(registry, adapter, systemCtx, "media.get", { assetId });
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    const asset = (get.value as { asset: Provenance | null }).asset!;
    expect(asset.license).toBe("CC0-1.0");
    // COALESCE: the omitted fields stay as they were.
    expect(asset.sourceKind).toBe("imported");
    expect(asset.sourceDetail).toBe("https://example.com/photo.jpg");
  });

  it("media.set_source on a missing asset returns a HandlerError", async () => {
    const res = await execute(registry, adapter, systemCtx, "media.set_source", {
      // Valid v4-shaped UUID that does not exist.
      assetId: "a1500000-0000-4000-8000-0000000a1500",
      license: "MIT",
    });
    expect(res.ok).toBe(false);
  });

  it("a plain upload with no source fields returns nulls", async () => {
    const up = await execute(registry, adapter, systemCtx, "media.upload", uploadInput(SHA_PLAIN));
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    const assetId = (up.value as { assetId: string }).assetId;

    const get = await execute(registry, adapter, systemCtx, "media.get", { assetId });
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    const asset = (get.value as { asset: Provenance | null }).asset!;
    expect(asset.sourceKind).toBeNull();
    expect(asset.sourceDetail).toBeNull();
    expect(asset.license).toBeNull();
  });
});
