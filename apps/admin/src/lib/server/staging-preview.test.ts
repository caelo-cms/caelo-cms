// SPDX-License-Identifier: MPL-2.0

/**
 * #842 / #848 — GET /_staging-preview/<runId>/<rest> must answer a staged
 * run it cannot read with an HTTP error that keeps the actionable message
 * ("...Run Stage again"). The admin has no `handleError` hook, so a plain
 * thrown Error would reach the operator as SvelteKit's generic 500
 * "Internal Error".
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SVG_DOCUMENT_CSP } from "@caelo-cms/shared";
import type { Bucket } from "@google-cloud/storage";
import { isHttpError } from "@sveltejs/kit";
import { createStagingPreviewHandler, gcsStagingPreviewBuckets } from "./staging-preview.js";

const RUN = "run-1";
const FILE_LIST_KEY = `_build-files/${RUN}.json`;

type FakeObject = string | { throws: string };

/** The slice of a GCS bucket the staged reader touches, backed by a record. */
function fakeBucket(name: string, objects: Record<string, FakeObject>): Bucket {
  const read = (key: string): string => {
    const value = objects[key];
    if (typeof value === "object") throw new Error(value.throws);
    return value ?? "";
  };
  return {
    name,
    file: (key: string) => ({
      name: key,
      bucket: { name },
      exists: async () => [key in objects],
      download: async () => [Buffer.from(read(key))],
      getMetadata: async () => [
        { contentType: key.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8" },
      ],
    }),
  } as unknown as Bucket;
}

type Handler = ReturnType<typeof createStagingPreviewHandler>;

/** Call a handler the way SvelteKit does; a thrown HttpError is the answer. */
async function get(handler: Handler, rest: string): Promise<{ status: number; message: string }> {
  try {
    const res = await handler({
      params: { runId: RUN, rest },
    } as unknown as Parameters<Handler>[0]);
    return { status: res.status, message: await res.text() };
  } catch (thrown) {
    if (isHttpError(thrown)) return { status: thrown.status, message: thrown.body.message };
    throw thrown;
  }
}

function handlerWith(staging: Record<string, FakeObject>, live: Record<string, FakeObject> = {}) {
  return createStagingPreviewHandler(async () => ({
    staging: fakeBucket("staging", staging),
    live: fakeBucket("static", live),
  }));
}

let savedEnv: Record<string, string | undefined>;
const ENV_KEYS = ["CAELO_PROVIDER", "CAELO_STAGING_BUCKET", "CAELO_STATIC_BUCKET"] as const;

beforeAll(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CAELO_PROVIDER = "gcp";
  delete process.env.CAELO_STAGING_BUCKET;
  delete process.env.CAELO_STATIC_BUCKET;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("GET /_staging-preview/<runId>/<rest>", () => {
  it("serves a staged page", async () => {
    const handler = handlerWith({
      [FILE_LIST_KEY]: JSON.stringify({ files: ["about/index.html"] }),
      [`${RUN}/about/index.html`]: "staged about",
    });
    expect(await get(handler, "about/")).toEqual({ status: 200, message: "staged about" });
  });

  it("serves staged media SVGs under the media CSP, pages without it (#863)", async () => {
    const handler = handlerWith({
      [FILE_LIST_KEY]: JSON.stringify({ files: ["about/index.html", "_assets/logo.abc.svg"] }),
      [`${RUN}/about/index.html`]: "staged about",
      [`${RUN}/_assets/logo.abc.svg`]: "<svg/>",
    });
    const call = (rest: string) =>
      handler({ params: { runId: RUN, rest } } as unknown as Parameters<Handler>[0]);
    const svg = await call("_assets/logo.abc.svg");
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toBe(SVG_DOCUMENT_CSP);
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
    // A staged page runs the site's own scripts: no sandbox CSP there.
    const page = await call("about/");
    expect(page.headers.get("content-security-policy")).toBeNull();
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers 404 for a page the staged build no longer contains", async () => {
    const handler = handlerWith(
      { [FILE_LIST_KEY]: JSON.stringify({ files: ["about/index.html"] }) },
      { "deleted/index.html": "live deleted" },
    );
    const res = await get(handler, "deleted/");
    expect(res.status).toBe(404);
    expect(res.message).toContain("Not in staging build run-1: deleted/index.html");
  });

  it("answers 409 with Run Stage again when the run has no file list", async () => {
    const res = await get(handlerWith({}), "about/");
    expect(res.status).toBe(409);
    expect(res.message).toMatch(/file list of run run-1 .* Run Stage again/);
  });

  it("answers 409 with Run Stage again when the file list is corrupt JSON", async () => {
    const res = await get(handlerWith({ [FILE_LIST_KEY]: '{"files": [' }), "about/");
    expect(res.status).toBe(409);
    expect(res.message).toMatch(/is not valid JSON .* Run Stage again/);
  });

  it("answers 409 when a file of the build is in neither bucket", async () => {
    const handler = handlerWith({
      [FILE_LIST_KEY]: JSON.stringify({ files: ["gone/index.html"] }),
    });
    const res = await get(handler, "gone/");
    expect(res.status).toBe(409);
    expect(res.message).toMatch(/neither in its staging prefix nor live.* Run Stage again/);
  });

  it("answers 502 with the cause when the bucket read itself fails", async () => {
    const handler = handlerWith({
      [FILE_LIST_KEY]: JSON.stringify({ files: ["about/index.html"] }),
      [`${RUN}/about/index.html`]: { throws: "403 caller lacks storage.objects.get" },
    });
    const res = await get(handler, "about/");
    expect(res.status).toBe(502);
    expect(res.message).toContain("403 caller lacks storage.objects.get");
  });

  it("answers 500 with the config message when the install's buckets are not configured", async () => {
    const res = await get(createStagingPreviewHandler(gcsStagingPreviewBuckets), "about/");
    expect(res.status).toBe(500);
    expect(res.message).toContain("CAELO_STAGING_BUCKET not set");
  });

  it("is what the route serves (read as source: bun cannot resolve the #lib import map to .ts)", () => {
    const route = readFileSync(
      resolve(
        import.meta.dir,
        "../../routes/(authed)/_staging-preview/[runId]/[...rest]/+server.ts",
      ),
      "utf8",
    );
    expect(route).toContain("createStagingPreviewHandler(gcsStagingPreviewBuckets)");
  });
});
