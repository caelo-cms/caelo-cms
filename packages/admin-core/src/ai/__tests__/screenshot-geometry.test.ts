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
import { clearPendingScreenshots, deliverScreenshot } from "../screenshot-orchestrator.js";
import type { ToolContext } from "../tools/dispatch.js";
import { screenshotPageTool } from "../tools/screenshot-page.js";

afterEach(() => clearPendingScreenshots());

const CTX = { actorId: "00000000-0000-0000-0000-00000000ffff", actorKind: "system" } as never;

/** Drive the tool with a fake ChatPanel that answers the SSE event. */
async function run(
  input: Record<string, unknown>,
  meta:
    | { canvasWidth: number; canvasHeight: number; pageWidth: number; pageHeight: number }
    | undefined,
) {
  const toolCtx = {
    pushClientEvent: (ev: { requestId: string }) => {
      // Deliver on the next tick, like the operator's browser would.
      queueMicrotask(() =>
        deliverScreenshot(ev.requestId, {
          base64: "aGk=",
          mediaType: "image/jpeg",
          ...(meta ? { meta } : {}),
        }),
      );
    },
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
});
