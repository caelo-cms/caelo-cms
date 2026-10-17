// SPDX-License-Identifier: MPL-2.0

/**
 * #842 — reading a staged GCS run: the staging prefix first, the live
 * bucket only for files the build contains. A page the staged build
 * deleted is still live until Confirm-publish prunes it; the staging
 * preview, the audit origin and `inspect_built_page` must not show it.
 */

import { describe, expect, it } from "bun:test";
import type { Bucket } from "@google-cloud/storage";
import { buildFilesKey, readStagedBuildFiles, readStagedObject } from "../staged-build-files.js";

/** The slice of a GCS bucket the reader touches, backed by a Map. */
function fakeBucket(name: string, objects: Record<string, string>): Bucket {
  const store = new Map(Object.entries(objects));
  return {
    name,
    file: (key: string) => ({
      name: key,
      bucket: { name },
      exists: async () => [store.has(key)],
      download: async () => [Buffer.from(store.get(key) ?? "")],
      getMetadata: async () => [{ contentType: "text/html; charset=utf-8" }],
    }),
  } as unknown as Bucket;
}

const RUN = "run-1";

function stagingWith(files: string[] | null, staged: Record<string, string> = {}): Bucket {
  const objects: Record<string, string> = {};
  for (const [k, v] of Object.entries(staged)) objects[`${RUN}/${k}`] = v;
  if (files !== null) objects[buildFilesKey(RUN)] = JSON.stringify({ files });
  return fakeBucket("staging", objects);
}

describe("readStagedBuildFiles", () => {
  it("returns the run's file list", async () => {
    const files = await readStagedBuildFiles(stagingWith(["index.html", "_redirects"]), RUN);
    expect([...files].sort()).toEqual(["_redirects", "index.html"]);
  });

  it("fails loudly for a run staged by an older release (no list)", async () => {
    await expect(readStagedBuildFiles(stagingWith(null), RUN)).rejects.toThrow(
      /file list of run run-1 .* Run Stage again/,
    );
  });

  it("refuses an empty list", async () => {
    await expect(readStagedBuildFiles(stagingWith([]), RUN)).rejects.toThrow(
      /not a build file list/,
    );
  });
});

describe("readStagedObject", () => {
  const live = fakeBucket("static", {
    "about/index.html": "live about",
    "deleted/index.html": "live deleted",
  });

  async function read(staging: Bucket, key: string) {
    return readStagedObject({
      staging,
      live,
      runId: RUN,
      buildFiles: await readStagedBuildFiles(staging, RUN),
      key,
    });
  }

  it("reads a changed file from the staging prefix", async () => {
    const staging = stagingWith(["about/index.html"], { "about/index.html": "staged about" });
    const object = await read(staging, "about/index.html");
    expect(object?.body.toString("utf8")).toBe("staged about");
    expect(object?.fromLive).toBe(false);
    expect(object?.location).toBe("gs://staging/run-1/about/index.html");
  });

  it("reads an unchanged (hash-skipped) file of the build from live", async () => {
    const object = await read(stagingWith(["about/index.html"]), "about/index.html");
    expect(object?.body.toString("utf8")).toBe("live about");
    expect(object?.fromLive).toBe(true);
    expect(object?.location).toBe("gs://static/about/index.html");
  });

  it("does not serve a live page the staged build no longer contains", async () => {
    expect(await read(stagingWith(["about/index.html"]), "deleted/index.html")).toBeNull();
  });

  it("fails loudly when a file of the build is in neither bucket", async () => {
    await expect(read(stagingWith(["gone/index.html"]), "gone/index.html")).rejects.toThrow(
      /neither in its staging prefix nor live/,
    );
  });
});
