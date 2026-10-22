// SPDX-License-Identifier: MPL-2.0

/**
 * 2026-07 (run B4 forensics) — screenshot capture geometry.
 *
 * The B4 model doubted a selector crop ("seems to be returning the full
 * page render") and NOTHING could confirm or refute it: images are
 * ephemeral and the tool result carried no dimensions. Now the browser
 * reports canvas + page geometry with the upload, and the tool result
 * states crop-vs-full-page as a fact:
 *  - a real crop → "Crop: WxH out of the PWxPH page";
 *  - a selector whose element spans the page → an explicit "matched a
 *    full-page wrapper" warning with a next step;
 *  - no meta (old client tab) → the legacy text, unchanged.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  clearPendingScreenshots,
  deliverScreenshot,
  type ScreenshotCaptureMeta,
} from "../screenshot-orchestrator.js";
import type { ToolContext } from "../tools/dispatch.js";
import { screenshotPageTool } from "../tools/screenshot-page.js";

afterEach(() => clearPendingScreenshots());

const CTX = { actorId: "00000000-0000-0000-0000-00000000ffff", actorKind: "system" } as never;

/** Drive the tool with a fake ChatPanel that answers the SSE event. */
async function run(
  input: Record<string, unknown>,
  meta: ScreenshotCaptureMeta | undefined,
  events: unknown[] = [],
) {
  const toolCtx = {
    pushClientEvent: (ev: { requestId: string }) => {
      events.push(ev);
      // Deliver on the next tick, like the operator's browser would.
      queueMicrotask(() =>
        deliverScreenshot(ev.requestId, {
          base64: "aGk=",
          mediaType: "image/jpeg",
          ...(meta ? { meta } : {}),
        }),
      );
    },
    // issue #412 — the SSE path now also requires the browser-attached
    // flag; without it the tool routes to the server-side backend.
    operatorBrowserAttached: true,
  } as unknown as ToolContext;
  return screenshotPageTool.handler(
    CTX,
    { pageId: "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e", ...input } as never,
    toolCtx,
  );
}

describe("screenshot_page capture geometry", () => {
  it("states a true selector crop as fact (crop ≪ page)", async () => {
    const r = await run(
      { selector: ".caelo-feature-grid" },
      { canvasWidth: 1280, canvasHeight: 367, pageWidth: 1280, pageHeight: 1467 },
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Crop: 1280×367px out of the 1280×1467px page");
    expect(r.content).not.toContain("full-page wrapper");
  });

  it("calls out a selector that matched a full-page wrapper", async () => {
    const r = await run(
      { selector: "main" },
      { canvasWidth: 1280, canvasHeight: 1460, pageWidth: 1280, pageHeight: 1467 },
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("full-page wrapper");
    expect(r.content).toContain("more specific selector");
  });

  it("reports plain dimensions on a full-page shot", async () => {
    const r = await run(
      {},
      { canvasWidth: 1280, canvasHeight: 800, pageWidth: 1280, pageHeight: 1467 },
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Image: 1280×800px (full page: 1280×1467px)");
  });

  it("stays on the legacy text when the client sent no meta (old tab)", async () => {
    const r = await run({ selector: ".x" }, undefined);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("element .x");
    expect(r.content).not.toContain("Crop:");
  });

  // Regression: a fixed 1280px capture showed the AI a 3-line headline the
  // operator's ~1740px preview wrapped onto 4 lines. The result must say
  // whose view the image shows.
  it("states the operator's live preview size when the capture used it", async () => {
    const r = await run(
      {},
      {
        canvasWidth: 1743,
        canvasHeight: 980,
        pageWidth: 1728,
        pageHeight: 7808,
        viewportWidth: 1743,
        viewportHeight: 980,
        viewportSource: "operator-preview",
      },
    );
    expect(r.content).toContain("Rendered at 1743×980px — the operator's live preview size");
  });

  it("warns when desktop fell back to the preset (no live preview open)", async () => {
    const r = await run(
      {},
      {
        canvasWidth: 1280,
        canvasHeight: 800,
        pageWidth: 1265,
        pageHeight: 7808,
        viewportWidth: 1280,
        viewportHeight: 800,
        viewportSource: "preset",
      },
    );
    expect(r.content).toContain("NOT necessarily the operator's view");
  });

  it("forwards an explicit width to the operator's browser", async () => {
    const events: unknown[] = [];
    const r = await run(
      { width: 1920 },
      {
        canvasWidth: 1920,
        canvasHeight: 800,
        pageWidth: 1905,
        pageHeight: 7000,
        viewportWidth: 1920,
        viewportHeight: 800,
        viewportSource: "requested",
      },
      events,
    );
    expect(events[0]).toMatchObject({ kind: "request-screenshot", width: 1920 });
    expect(r.content).toContain("Rendered at 1920px wide (the width you requested)");
  });
});
