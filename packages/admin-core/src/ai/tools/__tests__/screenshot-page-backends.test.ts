// SPDX-License-Identifier: MPL-2.0

/**
 * issue #412 — `screenshot_page` backend selection. One tool, two
 * backends: the operator-browser SSE capture (interactive chat only) and
 * the server-side Chromium render of the branch preview (headless
 * surfaces + the timeout fallback). The Playwright browser itself is
 * faked through the shared `_external-screenshotter` seam — everything
 * around it (selection, token scoping, budget, failure contents) runs
 * for real.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { Screenshot, Screenshotter } from "@caelo-cms/site-importer";
import {
  PREVIEW_SCREENSHOT_TOKEN_HEADER,
  verifyPreviewScreenshotToken,
} from "../../preview-screenshot-token.js";
import {
  clearPendingScreenshots,
  deliverScreenshot,
  failScreenshot,
} from "../../screenshot-orchestrator.js";
import { setExternalScreenshotterForTests } from "../_external-screenshotter.js";
import {
  resetPreviewScreenshotBudgetForTests,
  takePreviewScreenshotBudget,
} from "../_preview-screenshot-budget.js";
import type { ToolContext } from "../dispatch.js";
import { screenshotFailureContent, screenshotPageTool } from "../screenshot-page.js";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const BRANCH_ID = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "http://127.0.0.1:9"; // never contacted — the browser is faked

const aiCtx: ExecutionContext = {
  actorId: "55555555-5555-4555-8555-555555555555",
  actorKind: "ai",
  requestId: "test-req",
};

/** Minimal byte layout `pngDimensions` reads: PNG magic + IHDR w/h. */
function fakePngBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b[0] = 0x89;
  b[1] = 0x50;
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

interface RecordedCapture {
  url: string;
  opts: Parameters<Screenshotter["capture"]>[1];
}

function installFakeScreenshotter(recorded: RecordedCapture[], finalStatus = 200): void {
  const fake: Screenshotter = {
    async capture(url, opts) {
      recorded.push({ url, opts });
      const shot: Screenshot = {
        bytes: fakePngBytes(640, 480),
        width: opts?.width ?? 1280,
        height: opts?.height ?? 800,
        finalUrl: url,
        finalStatus,
      };
      return shot;
    },
    async renderHtml() {
      throw new Error("not used");
    },
    async query() {
      return [];
    },
    async dispose() {
      /* fake */
    },
  };
  setExternalScreenshotterForTests(async () => fake);
}

function toolCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    adapter: {} as ToolContext["adapter"],
    registry: {} as ToolContext["registry"],
    chatSessionId: crypto.randomUUID(),
    chatBranchId: BRANCH_ID,
    ...overrides,
  };
}

const savedEnv = {
  self: process.env.CAELO_PREVIEW_SELF_ORIGIN,
  port: process.env.PORT,
  origin: process.env.ORIGIN,
};

beforeEach(() => {
  process.env.CAELO_PREVIEW_SELF_ORIGIN = ORIGIN;
  resetPreviewScreenshotBudgetForTests();
  clearPendingScreenshots();
});

afterEach(() => {
  if (savedEnv.self === undefined) delete process.env.CAELO_PREVIEW_SELF_ORIGIN;
  else process.env.CAELO_PREVIEW_SELF_ORIGIN = savedEnv.self;
  if (savedEnv.port === undefined) delete process.env.PORT;
  else process.env.PORT = savedEnv.port;
  if (savedEnv.origin === undefined) delete process.env.ORIGIN;
  else process.env.ORIGIN = savedEnv.origin;
  setExternalScreenshotterForTests(null);
});

describe("server-side backend selection", () => {
  it("renders server-side when no pushClientEvent exists (Power-MCP dispatch shape)", async () => {
    const recorded: RecordedCapture[] = [];
    installFakeScreenshotter(recorded);
    const result = await screenshotPageTool.handler(aiCtx, { pageId: PAGE_ID }, toolCtx());
    expect(result.ok).toBe(true);
    expect(result.image?.mediaType).toBe("image/png");
    expect(result.content).toContain("server-side renderer");
    expect(result.content).toContain("640×480");
    expect(recorded).toHaveLength(1);
    const cap = recorded[0];
    expect(cap?.url).toBe(`${ORIGIN}/_caelo/preview-screenshot/${PAGE_ID}`);
  });

  it("scopes the minted token to the page + the chat's branch", async () => {
    const recorded: RecordedCapture[] = [];
    installFakeScreenshotter(recorded);
    await screenshotPageTool.handler(aiCtx, { pageId: PAGE_ID }, toolCtx());
    const header = recorded[0]?.opts?.extraHTTPHeaders?.[PREVIEW_SCREENSHOT_TOKEN_HEADER];
    expect(typeof header).toBe("string");
    const v = verifyPreviewScreenshotToken(header as string, { expectedPageId: PAGE_ID });
    expect(v).toEqual({ ok: true, pageId: PAGE_ID, chatBranchId: BRANCH_ID });
    // The same token must NOT open another page.
    const other = verifyPreviewScreenshotToken(header as string, {
      expectedPageId: "99999999-9999-4999-8999-999999999999",
    });
    expect(other).toEqual({ ok: false, reason: "page-mismatch" });
  });

  it("renders server-side when pushClientEvent exists but no browser is attached (headless send_chat shape)", async () => {
    const recorded: RecordedCapture[] = [];
    installFakeScreenshotter(recorded);
    const events: unknown[] = [];
    const result = await screenshotPageTool.handler(
      aiCtx,
      { pageId: PAGE_ID, viewport: "mobile" },
      toolCtx({ pushClientEvent: (e) => events.push(e) }),
    );
    expect(result.ok).toBe(true);
    // No request-screenshot event, no 30s wait — straight to the renderer.
    expect(events).toHaveLength(0);
    expect(recorded[0]?.opts?.width).toBe(375);
  });

  it("forwards the selector for element crops", async () => {
    const recorded: RecordedCapture[] = [];
    installFakeScreenshotter(recorded);
    const result = await screenshotPageTool.handler(
      aiCtx,
      { pageId: PAGE_ID, selector: "footer.caelo-layout-footer" },
      toolCtx(),
    );
    expect(result.ok).toBe(true);
    expect(recorded[0]?.opts?.selector).toBe("footer.caelo-layout-footer");
  });

  it("fails loudly when the preview route answers an error status", async () => {
    const recorded: RecordedCapture[] = [];
    installFakeScreenshotter(recorded, 404);
    const result = await screenshotPageTool.handler(aiCtx, { pageId: PAGE_ID }, toolCtx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("HTTP 404");
    expect(result.content).toContain("Do NOT retry with identical arguments");
    expect(result.image).toBeUndefined();
  });

  it("fails loudly (UNAVAILABLE) when Playwright is not installed", async () => {
    setExternalScreenshotterForTests(async () => null);
    const result = await screenshotPageTool.handler(aiCtx, { pageId: PAGE_ID }, toolCtx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("UNAVAILABLE");
    expect(result.content).toContain("inspect_page_render");
    expect(result.content).toContain("do NOT claim you saw the page");
  });

  it("fails loudly when the admin's own origin is unresolvable (no silent default)", async () => {
    delete process.env.CAELO_PREVIEW_SELF_ORIGIN;
    delete process.env.PORT;
    delete process.env.ORIGIN;
    const recorded: RecordedCapture[] = [];
    installFakeScreenshotter(recorded);
    const result = await screenshotPageTool.handler(aiCtx, { pageId: PAGE_ID }, toolCtx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("CAELO_PREVIEW_SELF_ORIGIN");
    expect(recorded).toHaveLength(0);
  });

  it("caps server-side captures per session (rolling budget)", async () => {
    const recorded: RecordedCapture[] = [];
    installFakeScreenshotter(recorded);
    const sessionKey = crypto.randomUUID();
    let remaining = Number.POSITIVE_INFINITY;
    while (remaining > 0) {
      const take = takePreviewScreenshotBudget(sessionKey);
      expect(take.ok).toBe(true);
      remaining = take.remaining;
    }
    const result = await screenshotPageTool.handler(
      aiCtx,
      { pageId: PAGE_ID },
      toolCtx({ chatSessionId: sessionKey }),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("budget exhausted");
    expect(result.content).toContain("inspect_page_render");
    expect(recorded).toHaveLength(0);
    // Another session is unaffected.
    expect(takePreviewScreenshotBudget(crypto.randomUUID()).ok).toBe(true);
  });
});

describe("operator-browser path (SSE) + fallback", () => {
  it("keeps the SSE capture as the default when a browser is attached", async () => {
    const recorded: RecordedCapture[] = [];
    installFakeScreenshotter(recorded);
    const events: Array<{ kind: string; requestId: string }> = [];
    const pending = screenshotPageTool.handler(
      aiCtx,
      { pageId: PAGE_ID },
      toolCtx({
        pushClientEvent: (e) => events.push(e as { kind: string; requestId: string }),
        operatorBrowserAttached: true,
      }),
    );
    expect(events[0]?.kind).toBe("request-screenshot");
    const delivered = deliverScreenshot(events[0]?.requestId ?? "", {
      base64: "b64-from-operator-browser",
      mediaType: "image/jpeg",
    });
    expect(delivered).toBe(true);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.image?.base64).toBe("b64-from-operator-browser");
    // The server renderer stayed out of it.
    expect(recorded).toHaveLength(0);
  });

  it("falls back to the server-side renderer when the browser capture times out", async () => {
    const recorded: RecordedCapture[] = [];
    installFakeScreenshotter(recorded);
    const events: Array<{ kind: string; requestId: string }> = [];
    const pending = screenshotPageTool.handler(
      aiCtx,
      { pageId: PAGE_ID },
      toolCtx({
        pushClientEvent: (e) => events.push(e as { kind: string; requestId: string }),
        operatorBrowserAttached: true,
      }),
    );
    failScreenshot(
      events[0]?.requestId ?? "",
      "screenshot deadbeef timed out after 30000ms — operator's browser didn't capture in time",
    );
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.content).toContain("server rendered instead");
    expect(recorded).toHaveLength(1);
  });

  it("keeps NON-timeout browser failures loud — no fallback masking a live-browser bug", async () => {
    const recorded: RecordedCapture[] = [];
    installFakeScreenshotter(recorded);
    const events: Array<{ kind: string; requestId: string }> = [];
    const pending = screenshotPageTool.handler(
      aiCtx,
      { pageId: PAGE_ID },
      toolCtx({
        pushClientEvent: (e) => events.push(e as { kind: string; requestId: string }),
        operatorBrowserAttached: true,
      }),
    );
    failScreenshot(events[0]?.requestId ?? "", "html2canvas exploded");
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.content).toBe("screenshot_page failed: html2canvas exploded");
    expect(recorded).toHaveLength(0);
  });
});

describe("screenshotFailureContent", () => {
  it("formats live-browser failures plainly", () => {
    expect(screenshotFailureContent("upload endpoint returned 500")).toBe(
      "screenshot_page failed: upload endpoint returned 500",
    );
  });
});
