// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1217 — the capture job's protocol, the admin's client, the job's
 * task logic and the in-process render slot, without a browser or a cloud:
 * a fake launcher and an in-memory bucket stand in for Cloud Run and GCS,
 * and a fake screenshotter for Chromium.
 *
 * The adversarial cases are the hand-over's guarantees: a signed URL works
 * for one capture only (the admin deletes the input when it ends), an
 * expired or reused one leaves the job with nothing, a preview hand-over
 * serves its own page and nothing else, and the job fetches from GCS signed
 * URLs only.
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  EXTERNAL_URL_BLOCKED,
  isExternalUrlBlockedError,
  type Screenshotter,
} from "@caelo-cms/site-importer";
import { Storage } from "@google-cloud/storage";
import { captureBackendFromEnv } from "../capture-backend.js";
import { CaptureJobError, type CaptureLauncher, createCaptureClient } from "../capture-client.js";
import {
  type CaptureOrder,
  type CaptureResult,
  captureOrderSchema,
  MAX_PREVIEW_MEDIA,
  previewInputSchema,
} from "../capture-protocol.js";
import { createCaptureSlots } from "../capture-slot.js";
import { type CaptureStore, gcsCaptureStore, SIGNED_URL_TTL_MS } from "../capture-store.js";
import { fetchSigned, previewServer, runOrder } from "../capture-task.js";
import { jobScreenshotter } from "../job-screenshotter.js";
import { buildPreviewInput } from "../preview-capture.js";

const PAGE = "11111111-1111-4111-8111-111111111111";
const OTHER_PAGE = "22222222-2222-4222-8222-222222222222";
const SIGNED = (key: string) => `https://storage.googleapis.com/bucket/${key}?X-Goog-Signature=abc`;

/** An in-memory capture bucket. */
function memoryStore() {
  const objects = new Map<string, string>();
  const removed: string[] = [];
  const store: CaptureStore = {
    async writeInput(key, text) {
      if (objects.has(key)) throw new Error("precondition failed");
      objects.set(key, text);
    },
    signInput: async (key) => SIGNED(key),
    signMedia: async (key) => SIGNED(`media/${key}`),
    readResult: async (key) => objects.get(key) ?? null,
    async remove(key) {
      removed.push(key);
      objects.delete(key);
    },
  };
  return { store, objects, removed };
}

/** A launcher whose "task" answers with `answer(order)` written to the store. */
function fakeLauncher(
  objects: Map<string, string>,
  answer: (o: CaptureOrder) => CaptureResult | null,
  opts: { failed?: boolean; finished?: boolean } = {},
) {
  const orders: CaptureOrder[] = [];
  const launcher: CaptureLauncher = {
    label: "fake job",
    async start(order) {
      orders.push(order);
      const r = answer(order);
      if (r) objects.set(order.resultKey, JSON.stringify(r));
      return "projects/p/locations/r/jobs/caelo-production-capture/executions/e-1";
    },
    status: async () => ({ finished: opts.finished ?? true, failed: opts.failed ?? false }),
  };
  return { launcher, orders };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
const shot = (o: CaptureOrder): CaptureResult => ({
  kind: "capture",
  captureId: o.captureId,
  pngBase64: PNG,
  width: 1280,
  height: 800,
});

describe("capture client", () => {
  it("hands the input over by signed URL, returns the result and deletes both", async () => {
    const { store, objects, removed } = memoryStore();
    const { launcher, orders } = fakeLauncher(objects, shot);
    const client = createCaptureClient({
      launcher,
      store,
      version: "1.0.0",
      sleep: async () => {},
    });
    const r = await client.run(
      (inputUrl) => ({
        kind: "query",
        inputUrl: inputUrl as string,
        cssSelector: "h1",
      }),
      { text: JSON.stringify({ html: "<h1>x</h1>" }) },
    );
    expect(r.kind).toBe("capture");
    const order = orders[0] as CaptureOrder;
    expect(order.version).toBe("1.0.0");
    expect(order.resultKey).toBe(`out/${order.captureId}.json`);
    expect(order.op).toMatchObject({
      kind: "query",
      inputUrl: SIGNED(`in/${order.captureId}.json`),
    });
    // One capture, one URL: the input is gone once the capture ended.
    expect(removed.sort()).toEqual([`in/${order.captureId}.json`, `out/${order.captureId}.json`]);
    expect(objects.size).toBe(0);
  });

  it("deletes the input even when the job fails", async () => {
    const { store, objects, removed } = memoryStore();
    const { launcher } = fakeLauncher(objects, () => null, { failed: true });
    const client = createCaptureClient({ launcher, store, sleep: async () => {} });
    const err = await client
      .run((u) => ({ kind: "query", inputUrl: u as string, xpath: "//a" }), { text: "{}" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureJobError);
    expect((err as CaptureJobError).code).toBe("task-failed");
    expect((err as Error).message).toContain("e-1");
    expect(removed.some((k) => k.startsWith("in/"))).toBe(true);
    expect(objects.size).toBe(0);
  });

  it("times out with the execution named, polling until the deadline", async () => {
    const { store, objects } = memoryStore();
    const { launcher } = fakeLauncher(objects, () => null, { finished: false });
    let t = 0;
    const client = createCaptureClient({
      launcher,
      store,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 5000,
    });
    const err = (await client
      .run(() => ({
        kind: "external-render",
        url: "https://example.com/",
        allowedHosts: [],
        opts: {},
      }))
      .catch((e: unknown) => e)) as CaptureJobError;
    expect(err.code).toBe("timeout");
    expect(err.message).toContain("did not finish within 5 s");
  });

  it("says how to fix a job that cannot be started", async () => {
    const { store } = memoryStore();
    const launcher: CaptureLauncher = {
      label: "fake job",
      start: async () => {
        throw new Error("HTTP 404: job not found");
      },
      status: async () => ({ finished: true, failed: true }),
    };
    const client = createCaptureClient({ launcher, store });
    const err = (await client
      .run(() => ({
        kind: "external-render",
        url: "https://example.com/",
        allowedHosts: [],
        opts: {},
      }))
      .catch((e: unknown) => e)) as CaptureJobError;
    expect(err.code).toBe("start-failed");
    expect(err.message).toContain("cms-provision upgrade");
  });

  it("refuses a result that names another capture or does not parse (the job is untrusted)", async () => {
    for (const bad of [
      (o: CaptureOrder) => ({ ...shot(o), captureId: crypto.randomUUID() }),
      (o: CaptureOrder) => ({ ...shot(o), extra: "field" }) as unknown as CaptureResult,
    ]) {
      const { store, objects } = memoryStore();
      const { launcher } = fakeLauncher(objects, bad);
      const client = createCaptureClient({ launcher, store, sleep: async () => {} });
      const err = (await client
        .run(() => ({
          kind: "external-render",
          url: "https://example.com/",
          allowedHosts: [],
          opts: {},
        }))
        .catch((e: unknown) => e)) as CaptureJobError;
      expect(err.code).toBe("bad-result");
    }
  });
});

describe("capture order schema", () => {
  const base = { version: "1", captureId: PAGE, resultKey: `out/${PAGE}.json` };

  it("accepts only GCS signed input URLs", () => {
    for (const inputUrl of [
      "http://storage.googleapis.com/b/in/x.json",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://storage.googleapis.com.evil.example/b/x",
      "https://caelo-production-admin-xyz.a.run.app/_caelo/preview-screenshot/x",
    ]) {
      expect(
        captureOrderSchema.safeParse({ ...base, op: { kind: "query", inputUrl, cssSelector: "a" } })
          .success,
      ).toBe(false);
    }
    expect(
      captureOrderSchema.safeParse({
        ...base,
        op: { kind: "query", inputUrl: SIGNED("in/x.json"), cssSelector: "a" },
      }).success,
    ).toBe(true);
  });

  it("binds the result key to the capture", () => {
    expect(
      captureOrderSchema.safeParse({
        ...base,
        resultKey: `out/${OTHER_PAGE}.json`,
        op: { kind: "external-render", url: "https://e.com/", allowedHosts: [], opts: {} },
      }).success,
    ).toBe(false);
    expect(
      captureOrderSchema.safeParse({
        ...base,
        resultKey: `in/${PAGE}.json`,
        op: { kind: "external-render", url: "https://e.com/", allowedHosts: [], opts: {} },
      }).success,
    ).toBe(false);
  });
});

describe("signed URLs (gcsCaptureStore)", () => {
  // Explicit credentials sign offline, exactly as Google verifies.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const storage = new Storage({
    projectId: "acme",
    credentials: {
      client_email: "caelo-production-run-sa@acme.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
  });
  const store = gcsCaptureStore(
    "acme-caelo-production-capture",
    "acme-caelo-production-media",
    storage,
  );

  it("signs a 5-minute read URL for exactly one input object", async () => {
    const url = new URL(await store.signInput("in/abc.json"));
    expect(url.origin).toBe("https://storage.googleapis.com");
    expect(url.pathname).toBe("/acme-caelo-production-capture/in/abc.json");
    expect(url.searchParams.get("X-Goog-Expires")).toBe(String(SIGNED_URL_TTL_MS / 1000));
    expect(url.searchParams.get("X-Goog-Algorithm")).toBe("GOOG4-RSA-SHA256");
    expect(url.searchParams.get("X-Goog-SignedHeaders")).toBe("host");
  });

  it("signs a media variant in the media bucket, not the capture bucket", async () => {
    const url = new URL(await store.signMedia("abc123/webp-400.webp"));
    expect(url.pathname).toBe("/acme-caelo-production-media/abc123/webp-400.webp");
    expect(url.searchParams.get("X-Goog-Expires")).toBe("300");
  });
});

describe("capture task (job side)", () => {
  const ORDER = (op: CaptureOrder["op"], version = "1.0.0"): CaptureOrder => ({
    version,
    captureId: PAGE,
    resultKey: `out/${PAGE}.json`,
    op,
  });
  const noBrowser = async () => {
    throw new Error("no browser expected");
  };

  it("refuses an order from an admin on another version", async () => {
    const r = await runOrder(
      ORDER({ kind: "external-render", url: "https://e.com/", allowedHosts: [], opts: {} }, "0.9"),
      { open: noBrowser, ownVersion: "1.0.0" },
    );
    expect(r).toMatchObject({ kind: "error", code: "version-mismatch" });
    expect((r as { message: string }).message).toContain("cms-provision upgrade");
  });

  it("an expired or already-used input leaves the job with nothing (HTTP 403/404)", async () => {
    for (const status of [400, 403, 404]) {
      const fakeBrowser = {
        query: async () => ["<h1>leak</h1>"],
        dispose: async () => undefined,
      } as unknown as Screenshotter;
      const r = await runOrder(
        ORDER({ kind: "query", inputUrl: SIGNED("in/x.json"), cssSelector: "h1" }),
        {
          open: async () => fakeBrowser,
          ownVersion: "1.0.0",
          fetchFn: (async () =>
            new Response("<Error>ExpiredToken</Error>", { status })) as unknown as typeof fetch,
        },
      );
      expect(r).toMatchObject({ kind: "error", code: "render-failed" });
      expect((r as { message: string }).message).toContain("expired, already used");
    }
  });

  it("reports the SSRF guard's refusal under its own code", async () => {
    const blocked = Object.assign(new Error("External URL blocked: http://10.0.0.1/"), {
      code: EXTERNAL_URL_BLOCKED,
    });
    const browser = {
      renderHtml: async () => {
        throw blocked;
      },
      dispose: async () => undefined,
    } as unknown as Screenshotter;
    const r = await runOrder(
      ORDER({ kind: "external-render", url: "http://10.0.0.1/", allowedHosts: [], opts: {} }),
      { open: async () => browser, ownVersion: "1.0.0" },
    );
    expect(r).toMatchObject({ kind: "error", code: EXTERNAL_URL_BLOCKED });
  });

  it("renders a served preview of the ordered page only", async () => {
    const input = previewInputSchema.parse({ html: "<h1>Draft</h1>", media: {} });
    let servedDoc: number | undefined;
    let otherDoc: unknown;
    const browser = {
      capture: async (
        url: string,
        opts: { serve: (u: URL) => Promise<{ status: number } | null> },
      ) => {
        expect(url).toBe(`https://preview.caelo.invalid/_caelo/preview-screenshot/${PAGE}`);
        servedDoc = (await opts.serve(new URL(url)))?.status;
        otherDoc = await opts.serve(
          new URL(`https://preview.caelo.invalid/_caelo/preview-screenshot/${OTHER_PAGE}`),
        );
        return { bytes: new Uint8Array([1]), width: 1, height: 1 };
      },
      dispose: async () => undefined,
    } as unknown as Screenshotter;
    const r = await runOrder(
      ORDER({
        kind: "preview-capture",
        inputUrl: SIGNED("in/x.json"),
        pageId: PAGE,
        width: 1280,
        height: 800,
        fullPage: false,
      }),
      {
        open: async () => browser,
        ownVersion: "1.0.0",
        fetchFn: (async () => new Response(JSON.stringify(input))) as unknown as typeof fetch,
      },
    );
    expect(r.kind).toBe("capture");
    expect(servedDoc).toBe(200);
    expect(otherDoc).toBeNull();
  });
});

describe("previewServer (the hand-over, as the job's browser sees it)", () => {
  const MEDIA_URL = SIGNED("media/abc/webp-400.webp");
  const input = previewInputSchema.parse({
    html: "<img src='/_caelo/media/hero/webp-400'>",
    media: { "/_caelo/media/hero/webp-400": { url: MEDIA_URL, contentType: "image/webp" } },
  });
  const fetched: string[] = [];
  const fetchFn = (async (u: string) => {
    fetched.push(u);
    return new Response(new Uint8Array([1, 2, 3]));
  }) as unknown as typeof fetch;
  const serve = previewServer(input, PAGE, fetchFn);
  const at = (path: string) => serve(new URL(`https://preview.caelo.invalid${path}`));

  it("serves the document sandboxed, as the admin's preview route does", async () => {
    const doc = await at(`/_caelo/preview-screenshot/${PAGE}`);
    expect(doc?.headers["content-security-policy"]).toBe("sandbox allow-scripts");
    expect(new TextDecoder().decode(doc?.body)).toContain("webp-400");
  });

  it("serves a handed-over media file from its signed URL, with the media headers", async () => {
    const m = await at("/_caelo/media/hero/webp-400");
    expect(m?.headers["content-type"]).toBe("image/webp");
    expect(m?.headers["x-content-type-options"]).toBe("nosniff");
    expect(fetched).toEqual([MEDIA_URL]);
  });

  it("has nothing for another page, another media file or an admin route", async () => {
    for (const path of [
      `/_caelo/preview-screenshot/${OTHER_PAGE}`,
      "/_caelo/media/secret-draft",
      "/_caelo/media/hero/webp-800",
      "/api/mcp/remote/admin",
      "/_caelo/media/__proto__",
      "/_caelo/media/constructor",
    ]) {
      expect(await at(path)).toBeNull();
    }
  });
});

describe("fetchSigned", () => {
  it("fetches GCS signed URLs only, never following a redirect", async () => {
    const seen: RequestInit[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return new Response("x");
    }) as unknown as typeof fetch;
    await fetchSigned(SIGNED("in/x.json"), fetchFn);
    expect(seen[0]?.redirect).toBe("error");
    for (const url of [
      "http://169.254.169.254/computeMetadata/v1/",
      "http://storage.googleapis.com/b/x",
      "https://example.com/x",
    ]) {
      await expect(fetchSigned(url, fetchFn)).rejects.toThrow(/only storage.googleapis.com/);
    }
  });
});

describe("buildPreviewInput", () => {
  it("signs each served media URL by its stored object and skips what does not resolve", async () => {
    const html =
      "<img src='/_caelo/media/hero/webp-400' srcset='/_caelo/media/hero/webp-400 200w, /_caelo/media/hero 1200w'><a href='/_caelo/media/gone'>x</a><div style=\"background:url(/_caelo/media/bg/webp-1600)\"></div>";
    const resolved: string[] = [];
    const input = await buildPreviewInput(html, {
      resolveMedia: async (ref, variant) => {
        resolved.push(`${ref}/${variant}`);
        return ref === "gone"
          ? null
          : { storageKey: `${ref}-sha/${variant}.webp`, contentType: "image/webp" };
      },
      sign: async (key) => SIGNED(`media/${key}`),
    });
    expect(resolved.sort()).toEqual(["bg/webp-1600", "gone/orig", "hero/orig", "hero/webp-400"]);
    expect(input.media).toEqual({
      "/_caelo/media/hero/webp-400": {
        url: SIGNED("media/hero-sha/webp-400.webp"),
        contentType: "image/webp",
      },
      "/_caelo/media/hero": { url: SIGNED("media/hero-sha/orig.webp"), contentType: "image/webp" },
      "/_caelo/media/bg/webp-1600": {
        url: SIGNED("media/bg-sha/webp-1600.webp"),
        contentType: "image/webp",
      },
    });
    expect(previewInputSchema.safeParse(input).success).toBe(true);
  });

  it("refuses a page with more media than one hand-over carries, naming the way out", async () => {
    const html = Array.from(
      { length: MAX_PREVIEW_MEDIA + 1 },
      (_, i) => `<img src="/_caelo/media/m${i}">`,
    ).join("");
    await expect(
      buildPreviewInput(html, {
        resolveMedia: async () => ({ storageKey: "k", contentType: "image/png" }),
        sign: async (k) => SIGNED(k),
      }),
    ).rejects.toThrow(/selector/);
  });
});

describe("job screenshotter", () => {
  function client(answer: (o: CaptureOrder) => CaptureResult) {
    const { store, objects } = memoryStore();
    const { launcher, orders } = fakeLauncher(objects, answer);
    return { c: createCaptureClient({ launcher, store, sleep: async () => {} }), orders };
  }

  it("runs external captures in the job with the SSRF exemptions in the order", async () => {
    const { c, orders } = client(shot);
    const s = jobScreenshotter(c, ["fixture.test"]);
    const out = await s.capture("https://example.com/", {
      external: true,
      fullPage: false,
      width: 375,
    });
    expect(out.bytes.length).toBe(4);
    expect(orders[0]?.op).toEqual({
      kind: "external-capture",
      url: "https://example.com/",
      allowedHosts: ["fixture.test"],
      opts: { width: 375, fullPage: false },
    });
  });

  it("refuses own-origin captures: the job has no way into the admin", async () => {
    const { c, orders } = client(shot);
    const s = jobScreenshotter(c, []);
    await expect(s.capture("http://127.0.0.1:3000/_caelo/preview-screenshot/x")).rejects.toThrow(
      /external URLs only/,
    );
    await expect(
      s.capture("https://e.com/", { external: true, sameOriginHeaders: { a: "b" } }),
    ).rejects.toThrow(/external URLs only/);
    expect(orders).toEqual([]);
  });

  it("keeps the SSRF refusal recognisable for callers", async () => {
    const { c } = client((o) => ({
      kind: "error",
      captureId: o.captureId,
      code: EXTERNAL_URL_BLOCKED,
      message: "External URL blocked",
    }));
    const err = await jobScreenshotter(c, [])
      .renderHtml("http://10.0.0.1/", { external: true })
      .catch((e: unknown) => e);
    expect(isExternalUrlBlockedError(err)).toBe(true);
  });

  it("sends a query's HTML as input, not in the order", async () => {
    const { c, orders } = client((o) => ({
      kind: "query",
      captureId: o.captureId,
      matches: ["<a>1</a>"],
    }));
    const html = `<a>1</a>${"x".repeat(100_000)}`;
    expect(await jobScreenshotter(c, []).query(html, { cssSelector: "a" })).toEqual(["<a>1</a>"]);
    expect(JSON.stringify(orders[0]).length).toBeLessThan(1000);
  });
});

describe("capture backend", () => {
  it("renders in-process on self-hosted and dev installs", () => {
    expect(captureBackendFromEnv({}).kind).toBe("in-process");
    expect(captureBackendFromEnv({ CAELO_PROVIDER: "self-hosted" }).kind).toBe("in-process");
  });

  it("uses the job on GCP and never falls back to an in-process browser", () => {
    const full = {
      CAELO_PROVIDER: "gcp",
      CAELO_CAPTURE_JOB: "projects/acme/locations/europe-west1/jobs/caelo-production-capture",
      CAELO_CAPTURE_BUCKET: "acme-caelo-production-capture",
      CAELO_MEDIA_BUCKET: "acme-caelo-production-media",
    };
    expect(captureBackendFromEnv(full).kind).toBe("job");
    expect(captureBackendFromEnv({ ...full, CAELO_PROVIDER: "gcp-firebase" }).kind).toBe("job");
    const missing = captureBackendFromEnv({ ...full, CAELO_CAPTURE_JOB: "" });
    expect(missing).toMatchObject({ kind: "unavailable" });
    expect((missing as { message: string }).message).toContain("cms-provision upgrade");
    expect(captureBackendFromEnv({ ...full, CAELO_CAPTURE_JOB: "not-a-job" }).kind).toBe(
      "unavailable",
    );
  });

  it("refuses on aws and azure with the tracking issue", () => {
    expect(captureBackendFromEnv({ CAELO_PROVIDER: "aws" })).toMatchObject({
      kind: "unavailable",
      message: expect.stringContaining("#749"),
    });
    expect(captureBackendFromEnv({ CAELO_PROVIDER: "azure" })).toMatchObject({
      kind: "unavailable",
      message: expect.stringContaining("#750"),
    });
  });
});

describe("capture slots", () => {
  it("runs one render at a time, first come first served, and frees the slot on failure", async () => {
    const slots = createCaptureSlots(1);
    const log: string[] = [];
    let release!: () => void;
    const first = slots.run(
      () =>
        new Promise<void>((r) => {
          log.push("a:start");
          release = () => {
            log.push("a:end");
            r();
          };
        }),
    );
    const second = slots.run(async () => {
      log.push("b");
      throw new Error("boom");
    });
    const third = slots.run(async () => {
      log.push("c");
    });
    await Promise.resolve();
    expect(slots.active).toBe(1);
    expect(log).toEqual(["a:start"]);
    release();
    await first;
    await expect(second).rejects.toThrow("boom");
    await third;
    expect(log).toEqual(["a:start", "a:end", "b", "c"]);
    expect(slots.active).toBe(0);
  });
});

describe("the shared in-process browser (self-hosted)", () => {
  it("never runs two renders at once, whoever calls", async () => {
    const { reuseWrapper } = await import("../../ai/tools/_external-screenshotter.js");
    let running = 0;
    let peak = 0;
    const slow = async <T>(v: T): Promise<T> => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return v;
    };
    const inner = {
      capture: () => slow({ bytes: new Uint8Array([1]), width: 1, height: 1 }),
      renderHtml: () => slow({ finalUrl: "https://e.com/", html: "" }),
      query: () => slow([] as string[]),
      dispose: async () => undefined,
    } as unknown as Screenshotter;
    // A crawl's four workers next to a chat screenshot and a selector query.
    const a = reuseWrapper(inner);
    const b = reuseWrapper(inner);
    await Promise.all([
      a.renderHtml("https://e.com/1", { external: true }),
      a.renderHtml("https://e.com/2", { external: true }),
      a.renderHtml("https://e.com/3", { external: true }),
      a.renderHtml("https://e.com/4", { external: true }),
      b.capture("https://e.com/5", { external: true }),
      b.query("<a></a>", { cssSelector: "a" }),
    ]);
    expect(peak).toBe(1);
  });
});
