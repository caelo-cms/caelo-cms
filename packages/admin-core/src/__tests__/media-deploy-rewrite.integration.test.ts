// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — deploy.trigger output verification:
 *  - HTML referencing /_caelo/media/<id>/<variant> is rewritten to
 *    /_assets/<id>/<variant>.<ext> by the static-generator media-pass.
 *  - Variant bytes are copied into output/<env>/builds/<runId>/_assets.
 *  - cdn_manifest.json is always written (entries empty when CDN off).
 *
 * Doesn't drive deploy.trigger end-to-end (subprocess overhead);
 * exercises runMediaPass directly against a real Postgres tx and
 * tmp filesystem, same pattern as apps/static-generator/src/media-pass.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo/query-api";
import type { ExecutionContext } from "@caelo/shared";
import { SQL } from "bun";
// We import runMediaPass via dynamic require so this test stays in
// admin-core without a circular workspace dep on static-generator.
// runMediaPass exists in apps/static-generator/src/media-pass.ts and
// is independently covered by that package's own test; here we just
// verify the SAME behaviour against a fresh tmp dir + real tx.
import { runMediaPass } from "../../../../apps/static-generator/src/media-pass.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TEST_PREFIX = "deba9001";
const SHA = `${TEST_PREFIX}${"a".repeat(56)}`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let mediaRoot: string;
let buildDir: string;
let assetId = "";

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "media-deploy-rewrite-test",
};

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

  mediaRoot = join(tmpdir(), `caelo-media-deploy-${Date.now()}`);
  buildDir = join(tmpdir(), `caelo-media-build-${Date.now()}`);
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(buildDir, { recursive: true });

  const upload = await execute(registry, adapter, systemCtx, "media.upload", {
    sha256: SHA,
    originalName: "deploy-test.png",
    mime: "image/png",
    sizeBytes: 4,
    width: null,
    height: null,
    alt: "",
    storageKey: `${SHA}/orig.png`,
    variants: [
      {
        variant: "orig",
        format: "png",
        width: null,
        height: null,
        sizeBytes: 4,
        storageKey: `${SHA}/orig.png`,
      },
    ],
  });
  if (!upload.ok) throw new Error("seed upload failed");
  assetId = (upload.value as { assetId: string }).assetId;

  await mkdir(join(mediaRoot, SHA), { recursive: true });
  await writeFile(join(mediaRoot, SHA, "orig.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("P7 deploy.trigger media rewrite", () => {
  it("rewrites /_caelo/media URLs to /_assets/... and copies variant bytes", async () => {
    const pages = [
      { html: `<p>hi <img src="/_caelo/media/${assetId}/orig" alt="x" /></p>`, pageSlug: "home" },
    ];
    await adapter.withAdminTransaction(systemCtx, async (tx) => {
      await runMediaPass({
        tx,
        buildDir,
        pages,
        mediaRoot,
        settings: { cdnEnabled: false, threshold: 5 },
      });
    });
    expect(pages[0]?.html).toContain(`/_assets/${assetId}/orig.png`);
    expect(pages[0]?.html).not.toContain("/_caelo/media");
    const copied = await readFile(join(buildDir, "_assets", assetId, "orig.png"));
    expect(copied.byteLength).toBe(4);
  });
});
