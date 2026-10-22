// SPDX-License-Identifier: MPL-2.0

/**
 * #891 — the converge's backfill of a `gcp` install's live SVGs: patch the
 * ones not yet served as downloads, then purge Cloud CDN once.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import type { InstallTarget } from "./stack-converge.js";
import { ensureSvgDownloads, svgObjectsMissingDisposition } from "./static-svg-gcp.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const gcp: InstallTarget = {
  provider: "gcp",
  projectId: "acme",
  region: "europe-west1",
  env: "production",
  services: { admin: "caelo-production-admin-1", gateway: "caelo-production-gateway-2" },
};

const URL_A = "gs://acme-caelo-production-static/_assets/a.0123456789abcdef.svg";
const URL_B = "gs://acme-caelo-production-static/_assets/brand/b.0123456789abcdef.svg";

/** Answers by the longest matching command prefix; records every call. */
function fakeGcloud(answers: Record<string, GcloudResult>) {
  const calls: string[] = [];
  const run = async (args: string[]) => {
    const line = args.join(" ");
    calls.push(line);
    const key = Object.keys(answers)
      .filter((k) => line.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return key ? (answers[key] as GcloudResult) : ok();
  };
  return { run, calls };
}

const listing = (...objects: object[]) => ok(JSON.stringify(objects));

describe("svgObjectsMissingDisposition", () => {
  it("returns the objects not served as attachment", () => {
    expect(
      svgObjectsMissingDisposition(
        JSON.stringify([
          { storage_url: URL_A, content_disposition: "attachment" },
          { storage_url: URL_B },
          { storage_url: "gs://x/c.svg", content_disposition: "inline" },
        ]),
      ),
    ).toEqual([URL_B, "gs://x/c.svg"]);
  });

  it("treats empty output as no objects and refuses anything that is not a listing", () => {
    expect(svgObjectsMissingDisposition("")).toEqual([]);
    expect(() => svgObjectsMissingDisposition("{}")).toThrow("not a JSON list");
    expect(() => svgObjectsMissingDisposition('[{"name":"a.svg"}]')).toThrow("storage_url");
  });
});

describe("ensureSvgDownloads", () => {
  it("patches the SVGs a pre-#891 install serves inline, then purges the CDN once", async () => {
    const { run, calls } = fakeGcloud({
      "storage objects list": listing(
        { storage_url: URL_A },
        { storage_url: URL_B, content_disposition: "attachment" },
      ),
      "compute url-maps list": ok("caelo-production-url-map-1a2b3c\n"),
    });
    const outcome = await ensureSvgDownloads(gcp, run);
    expect(outcome.status).toBe("applied");
    expect(outcome.onFailure).toBe("warn");
    expect(calls).toEqual([
      "storage objects list gs://acme-caelo-production-static/**.svg --project=acme --format=json",
      `storage objects update ${URL_A} --content-disposition=attachment --project=acme`,
      "compute url-maps list --global --project=acme --filter=name~^caelo-production-url-map --format=value(name)",
      "compute url-maps invalidate-cdn-cache caelo-production-url-map-1a2b3c --path=/* --global --async --project=acme --quiet",
    ]);
  });

  it("does nothing (no purge) when every SVG is already a download", async () => {
    const { run, calls } = fakeGcloud({
      "storage objects list": listing({ storage_url: URL_A, content_disposition: "attachment" }),
    });
    expect((await ensureSvgDownloads(gcp, run)).status).toBe("present");
    expect(calls).toHaveLength(1);
  });

  it("is present for an install without any SVG", async () => {
    const { run } = fakeGcloud({
      "storage objects list": fail(
        "ERROR: (gcloud.storage.objects.list) One or more URLs matched no objects.",
      ),
    });
    expect((await ensureSvgDownloads(gcp, run)).status).toBe("present");
  });

  it("patches in batches so no argv grows with the site", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      storage_url: `gs://acme-caelo-production-static/_assets/i${i}.svg`,
    }));
    const { run, calls } = fakeGcloud({
      "storage objects list": ok(JSON.stringify(many)),
      "compute url-maps list": ok("caelo-production-url-map-1\n"),
    });
    expect((await ensureSvgDownloads(gcp, run)).status).toBe("applied");
    const updates = calls.filter((c) => c.startsWith("storage objects update"));
    expect(updates).toHaveLength(3);
    expect(updates[0]?.split(" gs://")).toHaveLength(101);
  });

  it("warns with the manual next step when the patch or the purge fails", async () => {
    const patchFails = fakeGcloud({
      "storage objects list": listing({ storage_url: URL_A }),
      "storage objects update": fail("PERMISSION_DENIED"),
    });
    const patched = await ensureSvgDownloads(gcp, patchFails.run);
    expect(patched).toMatchObject({ status: "failed", onFailure: "warn" });
    expect(patched.error).toContain("PERMISSION_DENIED");
    expect(patchFails.calls.some((c) => c.includes("invalidate-cdn-cache"))).toBe(false);

    const purgeFails = fakeGcloud({
      "storage objects list": listing({ storage_url: URL_A }),
      "compute url-maps list": ok("caelo-production-url-map-1\n"),
      "compute url-maps invalidate-cdn-cache": fail("rate limited"),
    });
    const purged = await ensureSvgDownloads(gcp, purgeFails.run);
    expect(purged.status).toBe("failed");
    expect(purged.error).toContain("invalidate-cdn-cache");
  });
});
