// SPDX-License-Identifier: MPL-2.0

/**
 * #1330 — the audit's reads of a staging slot are fenced: once a later
 * Stage starts resyncing the slot, a read of the audited build fails
 * instead of returning the new build's bytes under the old manifest.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { fakeStagingBucket } from "../../__tests__/fixtures/fake-staging-bucket.js";
import { GcsSlotSync, setStagingBucketForTests } from "../../deploy/staging-slots.js";
import { stagingSlotSource } from "../staged-origin.js";

const RUN_A = "0b7c0d6e-1111-4111-8111-111111111111";
const RUN_C = "0b7c0d6e-3333-4333-8333-333333333333";

async function fill(
  bucket: ReturnType<typeof fakeStagingBucket>["bucket"],
  served: string | null,
  runId: string,
  body: string,
) {
  const sync = await GcsSlotSync.open(bucket, served);
  await sync.take("index.html", { type: "text/html", hash: body }, (d) =>
    d.save(body).then(() => undefined),
  );
  return sync.finish({ runId, pageUrlStyle: "directory" });
}

afterEach(() => setStagingBucketForTests(null));

describe("#1330 stagingSlotSource", () => {
  it("reads the audited build, and refuses once a later Stage reuses its slot", async () => {
    const fake = fakeStagingBucket();
    setStagingBucketForTests(fake.bucket);
    const a = await fill(fake.bucket, null, RUN_A, "<h1>A</h1>");
    expect(a.location).toBe("_slots/a");
    const source = stagingSlotSource("_slots/a", RUN_A);
    expect(new TextDecoder().decode((await source.read("index.html"))?.bytes)).toBe("<h1>A</h1>");
    // Stage B fills slot b; Stage C starts reusing slot a.
    await fill(fake.bucket, "_slots/a", "0b7c0d6e-2222-4222-8222-222222222222", "<h1>B</h1>");
    await fill(fake.bucket, "_slots/b", RUN_C, "<h1>C</h1>");
    await expect(source.read("index.html")).rejects.toThrow(/later Stage replaced it/);
    // A fresh source of A refuses at once.
    await expect(stagingSlotSource("_slots/a", RUN_A).read("index.html")).rejects.toThrow(
      /later Stage replaced it/,
    );
  });
});
