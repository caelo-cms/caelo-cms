// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1217 — `screenshot_page`'s server-side path on a GCP install: no
 * browser in the admin; the admin renders the preview through the Query
 * API, signs a read URL per media file the page shows, and hands both to
 * the capture job. Cloud Run and GCS are faked (an in-memory bucket, a
 * launcher whose "task" writes a result); the page, the render, the media
 * lookups and the tool are real.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { setExternalScreenshotterForTests } from "../ai/tools/_external-screenshotter.js";
import { resetPreviewScreenshotBudgetForTests } from "../ai/tools/_preview-screenshot-budget.js";
import { screenshotPageTool } from "../ai/tools/screenshot-page.js";
import { setCaptureBackendForTests } from "../capture/capture-backend.js";
import { type CaptureLauncher, createCaptureClient } from "../capture/capture-client.js";
import {
  type CaptureOrder,
  type PreviewInput,
  previewInputSchema,
} from "../capture/capture-protocol.js";
import type { CaptureStore } from "../capture/capture-store.js";
import { registerAdminOps } from "../register.js";
import { TEST_MEDIA_DIGEST } from "./fixtures/media-digest.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "capture-preview-test",
};

const PFX = `cpv-${Date.now().toString(36)}`;
const MEDIA_SHA_PREFIX = "c4a7e0b1";
const SHA = `${MEDIA_SHA_PREFIX}${"d".repeat(56)}`;
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pageId = "";
let slug = "";

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE display_name LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
    await tx`DELETE FROM media_assets WHERE sha256 LIKE ${`${MEDIA_SHA_PREFIX}%`}`;
  });
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: `${PFX} TPL`,
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  const templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const upload = await execute(registry, adapter, SYSTEM, "media.upload", {
    sha256: SHA,
    originalName: "hero.png",
    name: `${PFX} Hero`,
    mime: "image/png",
    sizeBytes: 4,
    width: 800,
    height: 400,
    alt: "Hero",
    storageKey: `${SHA}/orig.png`,
    variants: [
      {
        variant: "orig",
        format: "png",
        width: 800,
        height: 400,
        sizeBytes: 4,
        storageKey: `${SHA}/orig.png`,
        digest: TEST_MEDIA_DIGEST,
      },
      {
        variant: "webp-400",
        format: "webp",
        width: 400,
        height: 200,
        sizeBytes: 2,
        storageKey: `${SHA}/webp-400.webp`,
        digest: TEST_MEDIA_DIGEST,
      },
    ],
  });
  if (!upload.ok) throw new Error(`media seed: ${JSON.stringify(upload.error)}`);
  const assetId = (upload.value as { assetId: string }).assetId;
  slug = (upload.value as { slug: string }).slug;
  const page = await execute(registry, adapter, SYSTEM, "pages.build_page", {
    page: { slug: `${PFX}-page`, title: `${PFX} page`, templateId, status: "draft" },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} Body`,
        description: "Page body.",
        kind: "content",
        html: `<h1>{{body_text}}</h1><img alt="Hero" src="caelo:media/${assetId}/webp-400">`,
        fields: [{ name: "body_text", kind: "text", label: "Body" }],
        content: { source: "inline", values: { body_text: "Draft headline" } },
      },
    ],
  });
  if (!page.ok) throw new Error(`build_page: ${JSON.stringify(page.error)}`);
  pageId = (page.value as { pageId: string }).pageId;
});

afterAll(async () => {
  setCaptureBackendForTests(null);
  setExternalScreenshotterForTests(null);
  await wipe();
  await adapter.close();
});

/** The fake bucket + job: the task "reads" its input and answers a PNG. */
function fakeJob() {
  const objects = new Map<string, string>();
  const orders: CaptureOrder[] = [];
  const inputs: PreviewInput[] = [];
  const removed: string[] = [];
  const store: CaptureStore = {
    async writeInput(key, text) {
      objects.set(key, text);
    },
    signInput: async (key) => `https://storage.googleapis.com/capture/${key}?X-Goog-Signature=s`,
    signMedia: async (key) => `https://storage.googleapis.com/media/${key}?X-Goog-Signature=s`,
    readResult: async (key) => objects.get(key) ?? null,
    async remove(key) {
      removed.push(key);
      objects.delete(key);
    },
  };
  const launcher: CaptureLauncher = {
    label: "fake capture job",
    async start(order) {
      orders.push(order);
      if (order.op.kind !== "preview-capture") throw new Error("unexpected op");
      const key = new URL(order.op.inputUrl).pathname.replace(/^\/capture\//, "");
      inputs.push(previewInputSchema.parse(JSON.parse(objects.get(key) as string)));
      const png = Buffer.alloc(24);
      png[0] = 0x89;
      png[1] = 0x50;
      png.writeUInt32BE(1280, 16);
      png.writeUInt32BE(800, 20);
      objects.set(
        order.resultKey,
        JSON.stringify({
          kind: "capture",
          captureId: order.captureId,
          pngBase64: png.toString("base64"),
          width: 1280,
          height: 800,
        }),
      );
      return "projects/acme/locations/europe-west1/jobs/caelo-production-capture/executions/x";
    },
    status: async () => ({ finished: true, failed: false }),
  };
  return {
    client: createCaptureClient({ launcher, store, sleep: async () => {} }),
    objects,
    orders,
    inputs,
    removed,
  };
}

describe("screenshot_page on a GCP install (#1217)", () => {
  it("hands the job the rendered preview and signed media, starts no browser, cleans up", async () => {
    // Any in-process browser would be a failure of the acceptance criterion.
    setExternalScreenshotterForTests(async () => {
      throw new Error("the admin must not start a browser on GCP");
    });
    const job = fakeJob();
    setCaptureBackendForTests({ kind: "job", client: job.client });
    resetPreviewScreenshotBudgetForTests();

    const r = await screenshotPageTool.handler(SYSTEM, { pageId }, { adapter, registry });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("1280×800px");
    expect(r.image?.mediaType).toBe("image/png");

    const order = job.orders[0] as CaptureOrder;
    expect(order.op).toMatchObject({
      kind: "preview-capture",
      pageId,
      width: 1280,
      height: 800,
      fullPage: false,
    });
    const input = job.inputs[0] as PreviewInput;
    // The admin's own render of the draft, not a published copy.
    expect(input.html).toContain("Draft headline");
    expect(input.html).toContain(`/_caelo/media/${slug}/webp-400`);
    // Exactly the media the page shows, each signed for its stored object.
    expect(input.media).toEqual({
      [`/_caelo/media/${slug}/webp-400`]: {
        url: `https://storage.googleapis.com/media/${SHA}/webp-400.webp?X-Goog-Signature=s`,
        contentType: "image/webp",
      },
    });
    // One capture, one hand-over: nothing stays in the bucket.
    expect(job.objects.size).toBe(0);
    expect(job.removed).toContain(`in/${order.captureId}.json`);
  });

  it("says the page could not be rendered instead of starting the job for a page that does not exist", async () => {
    const job = fakeJob();
    setCaptureBackendForTests({ kind: "job", client: job.client });
    resetPreviewScreenshotBudgetForTests();
    const r = await screenshotPageTool.handler(
      SYSTEM,
      { pageId: crypto.randomUUID() },
      { adapter, registry },
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("could not be rendered");
    expect(job.orders).toEqual([]);
  });
});
