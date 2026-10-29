// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1217 — the capture job's served preview in the real Chromium: the
 * job's browser renders the document the admin handed over, its media from
 * the signed URLs in the hand-over, and reaches nothing else — a module
 * script's fetch, image or iframe aimed at a canary on this machine never
 * arrives. Only `fetchFn` is faked (it stands in for GCS). When Chromium is
 * not installed the suite skips LOUDLY locally and FAILS under CI, whose
 * test job installs it — the contract of site-importer browser-egress.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:net";
import { createPlaywrightScreenshotter, type Screenshotter } from "@caelo-cms/site-importer";
import sharp from "sharp";
import { runOrder } from "../capture-task.js";

const PAGE = "11111111-1111-4111-8111-111111111111";
const INPUT_URL = "https://storage.googleapis.com/capture/in/a.json?X-Goog-Signature=s";
const MEDIA_URL = "https://storage.googleapis.com/media/sha/webp-400.webp?X-Goog-Signature=s";

let browser: Screenshotter | null = null;
let canary: Server;
let canaryPort = 0;
const canaryHits: string[] = [];

beforeAll(async () => {
  canary = createServer((s) => {
    canaryHits.push("tcp");
    s.destroy();
  });
  await new Promise<void>((r) => canary.listen(0, "127.0.0.1", () => r()));
  const a = canary.address();
  if (a === null || typeof a === "string") throw new Error("canary did not bind");
  canaryPort = a.port;
  browser = await createPlaywrightScreenshotter({ allowedHosts: [] });
  if (browser === null) {
    if (process.env.CI) {
      throw new Error(
        "[served-preview.test] Playwright Chromium unavailable in CI — the CI test job must install it (`bun node_modules/playwright/cli.js install chromium --with-deps`).",
      );
    }
    console.warn("[served-preview.test] Playwright Chromium unavailable — SKIPPING.");
  }
});

afterAll(async () => {
  await browser?.dispose();
  canary.close();
});

describe("served preview capture (live Chromium)", () => {
  it("renders the handed-over document and media, runs its scripts, reaches nothing else", async () => {
    if (browser === null) return;
    const red = await sharp({
      create: { width: 200, height: 100, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer();
    const blocked = `http://127.0.0.1:${canaryPort}`;
    const input = {
      html: `<!doctype html><html><body style="margin:0;background:#00ff00"><img src="/_caelo/media/hero/webp-400" width="200" height="100"><img src="${blocked}/i.png"><iframe src="${blocked}/f"></iframe><script>fetch("${blocked}/x").catch(()=>{});document.body.style.borderTop="0"</script></body></html>`,
      media: { "/_caelo/media/hero/webp-400": { url: MEDIA_URL, contentType: "image/png" } },
    };
    const fetched: string[] = [];
    const fetchFn = (async (u: string) => {
      fetched.push(u);
      return u === INPUT_URL ? new Response(JSON.stringify(input)) : new Response(red);
    }) as unknown as typeof fetch;
    const shared = browser;
    const r = await runOrder(
      {
        version: "v",
        captureId: PAGE,
        resultKey: `out/${PAGE}.json`,
        op: {
          kind: "preview-capture",
          inputUrl: INPUT_URL,
          pageId: PAGE,
          width: 400,
          height: 300,
          fullPage: false,
        },
      },
      {
        // The test's browser is reused across cases; runOrder disposes it.
        open: async () => ({ ...shared, dispose: async () => undefined }),
        fetchFn,
        ownVersion: "v",
      },
    );
    await new Promise((res) => setTimeout(res, 500));
    expect(r.kind).toBe("capture");
    if (r.kind !== "capture") return;
    const { data, info } = await sharp(Buffer.from(r.pngBase64, "base64"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    expect([info.width, info.height]).toEqual([400, 300]);
    expect(px(10, 10)).toEqual([255, 0, 0]); // the handed-over media
    expect(px(390, 290)).toEqual([0, 255, 0]); // the document
    expect(fetched).toEqual([INPUT_URL, MEDIA_URL]);
    expect(canaryHits).toEqual([]);
  });
});
