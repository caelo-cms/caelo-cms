// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1217 — one capture, in its own short-lived container (the Cloud Run
 * job `caelo-<env>-capture`, started by the admin per render):
 *
 *   CAELO_CAPTURE_ORDER='<CaptureOrder JSON>' bun --bun packages/admin-core/src/capture/capture-task.ts
 *
 * Least privilege: the task's identity may create objects under `out/` of
 * the capture bucket and write logs — nothing else. It reads its input (a
 * preview document, an HTML string) only through the signed URL in the
 * order, and media through the signed URLs inside that input. No database,
 * no secrets, no VPC, and no way into the admin.
 *
 * Exit code 0 means a result was written (a render that failed is a written
 * `error` result, not a crash). Any other exit leaves no result, and the
 * admin reports the execution as failed with a pointer to its log.
 */

import { CAELO_VERSION, mediaSecurityHeaders } from "@caelo-cms/shared";
import {
  createPlaywrightScreenshotter,
  EXTERNAL_URL_BLOCKED,
  isExternalUrlBlockedError,
  type Screenshot,
  type Screenshotter,
  type ServeOwnOrigin,
} from "@caelo-cms/site-importer";
import { previewDocumentHeaders } from "../preview-document.js";
import {
  CAPTURE_ORDER_ENV_VAR,
  type CaptureOrder,
  type CaptureResult,
  captureOrderSchema,
  PREVIEW_CAPTURE_ORIGIN,
  type PreviewInput,
  previewInputSchema,
  queryInputSchema,
  SIGNED_URL_HOST,
} from "./capture-protocol.js";
import { CAPTURE_BUCKET_ENV_VAR } from "./capture-store.js";

/** The biggest input or media file the task fetches. */
const MAX_FETCH_BYTES = 50 * 1024 * 1024;

/**
 * Fetch a signed URL's bytes. Only `https://storage.googleapis.com/` is
 * fetched (the order schema checks it too), redirects are refused, and the
 * size is capped. Exported for tests.
 */
export async function fetchSigned(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ readonly status: number; readonly bytes: Uint8Array }> {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.hostname !== SIGNED_URL_HOST) {
    throw new Error(`refusing to fetch ${u.origin}: only ${SIGNED_URL_HOST} signed URLs`);
  }
  const res = await fetchFn(url, { redirect: "error" });
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_FETCH_BYTES) throw new Error(`signed object too large (${declared} bytes)`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_FETCH_BYTES) throw new Error("signed object too large");
  return { status: res.status, bytes };
}

async function fetchInput(url: string, fetchFn: typeof fetch): Promise<unknown> {
  const r = await fetchSigned(url, fetchFn);
  if (r.status !== 200) {
    throw new Error(
      `the capture input answered HTTP ${r.status} (expired, already used, or never written)`,
    );
  }
  return JSON.parse(new TextDecoder().decode(r.bytes));
}

/**
 * What the job's browser gets for each request to the preview origin: the
 * document at `/_caelo/preview-screenshot/<pageId>`, the handed-over media at
 * their paths, nothing else (null = 404). Pure apart from `fetchFn`;
 * exported for tests.
 */
export function previewServer(
  input: PreviewInput,
  pageId: string,
  fetchFn: typeof fetch = fetch,
): ServeOwnOrigin {
  const documentPath = `/_caelo/preview-screenshot/${pageId}`;
  const document = new TextEncoder().encode(input.html);
  return async (url) => {
    if (url.pathname === documentPath) {
      return { status: 200, headers: previewDocumentHeaders(), body: document };
    }
    const media = Object.hasOwn(input.media, url.pathname) ? input.media[url.pathname] : undefined;
    if (!media) return null;
    const r = await fetchSigned(media.url, fetchFn);
    if (r.status !== 200) return null;
    return {
      status: 200,
      headers: { "content-type": media.contentType, ...mediaSecurityHeaders(media.contentType) },
      body: r.bytes,
    };
  };
}

function captureResult(captureId: string, shot: Screenshot): CaptureResult {
  return {
    kind: "capture",
    captureId,
    pngBase64: Buffer.from(shot.bytes).toString("base64"),
    width: shot.width,
    height: shot.height,
    ...(shot.finalUrl !== undefined ? { finalUrl: shot.finalUrl } : {}),
    ...(shot.finalStatus !== undefined ? { finalStatus: shot.finalStatus } : {}),
    ...(shot.contentType !== undefined ? { contentType: shot.contentType } : {}),
    ...(shot.styleSamples ? { styleSamples: [...shot.styleSamples] } : {}),
    ...(shot.renderedHtml !== undefined ? { renderedHtml: shot.renderedHtml } : {}),
    ...(shot.visibleHtml !== undefined ? { visibleHtml: shot.visibleHtml } : {}),
    ...(shot.hiddenRemoved !== undefined ? { hiddenRemoved: shot.hiddenRemoved } : {}),
  };
}

/**
 * Run one order with a browser from `open`. Never throws for a render that
 * fails: that is an `error` result. Exported for tests.
 */
export async function runOrder(
  order: CaptureOrder,
  deps: {
    readonly open: (allowedHosts: readonly string[]) => Promise<Screenshotter | null>;
    readonly fetchFn?: typeof fetch;
    readonly ownVersion?: string;
  },
): Promise<CaptureResult> {
  const { captureId, op } = order;
  const fetchFn = deps.fetchFn ?? fetch;
  const error = (code: string, message: string): CaptureResult => ({
    kind: "error",
    captureId,
    code,
    message: message.slice(0, 4000),
  });
  const ownVersion = deps.ownVersion ?? CAELO_VERSION;
  if (order.version !== ownVersion) {
    return error(
      "version-mismatch",
      `the capture job runs Caelo ${ownVersion} but the admin runs ${order.version}; the job's image did not follow the last upgrade — the operator runs \`cms-provision upgrade\``,
    );
  }
  const screenshotter = await deps.open(
    op.kind === "external-capture" || op.kind === "external-render" ? op.allowedHosts : [],
  );
  if (!screenshotter) {
    return error("browser-unavailable", "the capture job's image has no usable Chromium");
  }
  try {
    switch (op.kind) {
      case "external-capture":
        return captureResult(
          captureId,
          await screenshotter.capture(op.url, { ...op.opts, external: true }),
        );
      case "external-render": {
        const r = await screenshotter.renderHtml(op.url, { ...op.opts, external: true });
        return {
          kind: "render",
          captureId,
          finalUrl: r.finalUrl,
          html: r.html,
          ...(r.contentType !== undefined ? { contentType: r.contentType } : {}),
          ...(r.styleSamples ? { styleSamples: [...r.styleSamples] } : {}),
          ...(r.visibleHtml !== undefined ? { visibleHtml: r.visibleHtml } : {}),
          ...(r.hiddenRemoved !== undefined ? { hiddenRemoved: r.hiddenRemoved } : {}),
        };
      }
      case "query": {
        const input = queryInputSchema.parse(await fetchInput(op.inputUrl, fetchFn));
        const matches = await screenshotter.query(input.html, {
          ...(op.cssSelector ? { cssSelector: op.cssSelector } : {}),
          ...(op.xpath ? { xpath: op.xpath } : {}),
          ...(op.maxMatches ? { maxMatches: op.maxMatches } : {}),
        });
        return { kind: "query", captureId, matches };
      }
      case "preview-capture": {
        const input = previewInputSchema.parse(await fetchInput(op.inputUrl, fetchFn));
        const shot = await screenshotter.capture(
          `${PREVIEW_CAPTURE_ORIGIN}/_caelo/preview-screenshot/${op.pageId}`,
          {
            width: op.width,
            height: op.height,
            fullPage: op.fullPage,
            ...(op.selector ? { selector: op.selector } : {}),
            serve: previewServer(input, op.pageId, fetchFn),
          },
        );
        return captureResult(captureId, shot);
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return error(isExternalUrlBlockedError(e) ? EXTERNAL_URL_BLOCKED : "render-failed", message);
  } finally {
    await screenshotter.dispose().catch(() => undefined);
  }
}

async function writeResult(bucket: string, key: string, text: string): Promise<void> {
  const { Storage } = await import("@google-cloud/storage");
  // ifGenerationMatch 0: create only — the identity may not overwrite.
  await new Storage()
    .bucket(bucket)
    .file(key)
    .save(text, {
      contentType: "application/json",
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
    });
}

async function main(): Promise<void> {
  const raw = process.env[CAPTURE_ORDER_ENV_VAR];
  if (!raw)
    throw new Error(`${CAPTURE_ORDER_ENV_VAR} is not set — the admin passes the order in it`);
  const bucket = process.env[CAPTURE_BUCKET_ENV_VAR];
  if (!bucket) {
    throw new Error(
      `${CAPTURE_BUCKET_ENV_VAR} is not set — capture-job-setup.ts sets it on the job; run \`cms-provision upgrade\``,
    );
  }
  const order = captureOrderSchema.parse(JSON.parse(raw));
  const result = await runOrder(order, {
    open: (allowedHosts) => createPlaywrightScreenshotter({ allowedHosts }),
  });
  await writeResult(bucket, order.resultKey, JSON.stringify(result));
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error("[capture-task] failed:", e instanceof Error ? (e.stack ?? e.message) : e);
      process.exit(1);
    },
  );
}
