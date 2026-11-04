// SPDX-License-Identifier: MPL-2.0

/**
 * #1330 — the staged site's full mirror in two slots of the staging bucket:
 * a Stage writes only what differs from the slot it fills, deletes what the
 * build lost, never touches the served slot, and writes the manifest last.
 */

import { describe, expect, it } from "bun:test";
import { stagedManifestKey, stagingSlotLocation } from "@caelo-cms/shared";
import type { Bucket, File } from "@google-cloud/storage";
import { GcsSlotSync } from "../staging-slots.js";

const RUN_A = "0b7c0d6e-1111-4111-8111-111111111111";
const RUN_B = "0b7c0d6e-2222-4222-8222-222222222222";

/** An in-memory bucket with the calls GcsSlotSync makes, and a write log. */
function fakeBucket() {
  const objects = new Map<string, string>();
  const writes: string[] = [];
  const deletes: string[] = [];
  const file = (name: string) =>
    ({
      name,
      async exists() {
        return [objects.has(name)];
      },
      async download() {
        return [Buffer.from(objects.get(name) ?? "")];
      },
      async delete() {
        deletes.push(name);
        objects.delete(name);
        return [{}];
      },
      async save(body: string | Buffer) {
        writes.push(name);
        objects.set(name, body.toString());
        return [{}];
      },
    }) as unknown as File;
  const bucket = {
    file,
    async getFiles({ prefix }: { prefix: string }) {
      return [[...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => file(k))];
    },
  } as unknown as Bucket;
  return { bucket, objects, writes, deletes };
}

async function stage(
  bucket: Bucket,
  served: string | null,
  runId: string,
  files: Record<string, string>,
) {
  const sync = await GcsSlotSync.open(bucket, served);
  for (const [path, body] of Object.entries(files)) {
    await sync.take(path, { type: "text/html", hash: `h:${body}` }, async (dest) => {
      await dest.save(body);
    });
  }
  return sync.finish({ runId, pageUrlStyle: "directory" });
}

describe("#1330 GcsSlotSync", () => {
  it("fills the slot staging does not serve, completely, manifest last", async () => {
    const b = fakeBucket();
    const first = await stage(b.bucket, null, RUN_A, {
      "index.html": "one",
      "about/index.html": "a",
    });
    expect(first.location).toBe(stagingSlotLocation("a"));
    expect(first.written).toBe(2);
    expect(b.writes.at(-1)).toBe(stagedManifestKey("_slots/a"));
    const manifest = JSON.parse(b.objects.get(stagedManifestKey("_slots/a")) ?? "{}");
    expect(manifest.runId).toBe(RUN_A);
    expect(Object.keys(manifest.files).sort()).toEqual(["about/index.html", "index.html"]);
  });

  it("writes only what differs from the slot and deletes what the build lost", async () => {
    const b = fakeBucket();
    await stage(b.bucket, null, RUN_A, { "index.html": "one", "old.html": "x", "keep.html": "k" });
    // Stage 2 fills slot b (a is served), Stage 3 fills a again.
    await stage(b.bucket, "_slots/a", RUN_B, { "index.html": "one", "keep.html": "k" });
    b.writes.length = 0;
    const third = await stage(b.bucket, "_slots/b", RUN_A, {
      "index.html": "two",
      "keep.html": "k",
    });
    expect(third.location).toBe("_slots/a");
    expect(third.written).toBe(1);
    expect(third.unchanged).toBe(1);
    expect(third.deleted).toBe(1);
    expect(b.objects.has("_slots/a/old.html")).toBe(false);
    expect(b.objects.get("_slots/a/index.html")).toBe("two");
    // Nothing of the served slot b was written or deleted.
    expect(b.writes.filter((w) => w.startsWith("_slots/b"))).toEqual([]);
    expect(b.deletes.filter((d) => d.startsWith("_slots/b"))).toEqual([]);
  });

  it("after a sync that stopped halfway, trusts nothing and writes everything again", async () => {
    const b = fakeBucket();
    await stage(b.bucket, null, RUN_A, { "index.html": "one", "keep.html": "k" });
    // A sync of slot a that dies after deleting the manifest and writing one file.
    const broken = await GcsSlotSync.open(b.bucket, "_slots/b");
    await broken.take("index.html", { type: "text/html", hash: "h:half" }, async (d) => {
      await d.save("half");
    });
    expect(b.objects.has(stagedManifestKey("_slots/a"))).toBe(false);
    const next = await stage(b.bucket, "_slots/b", RUN_B, {
      "index.html": "one",
      "keep.html": "k",
    });
    expect(next.written).toBe(2);
    expect(b.objects.get("_slots/a/index.html")).toBe("one");
  });

  it("fails the finish when a write failed, and serves nothing of it", async () => {
    const b = fakeBucket();
    const sync = await GcsSlotSync.open(b.bucket, null);
    await sync.take("index.html", { type: "text/html", hash: "h" }, async () => {
      throw new Error("quota");
    });
    await expect(sync.finish({ runId: RUN_A, pageUrlStyle: "directory" })).rejects.toThrow(/quota/);
    expect(b.objects.has(stagedManifestKey("_slots/a"))).toBe(false);
  });
});
