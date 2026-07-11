// SPDX-License-Identifier: MPL-2.0

/**
 * v0.3.1 — `screenshot_page` AI tool. Browser-mediated capture: the
 * tool emits a `request-screenshot` SSE event to ChatPanel, which
 * uses html2canvas on the preview iframe and POSTs the PNG to the
 * upload endpoint. The tool awaits the orchestrator's Promise
 * resolution, then returns a ToolResult with `image` set.
 *
 * Why browser-side: see plans/check-the-cms-requirements-smooth-book.md
 * for the full trade-off. tl;dr — captures EXACTLY what the operator
 * sees (same browser, same fonts, same extensions), zero extra image
 * weight on Cloud Run, no IAP/auth complexity.
 *
 * Limitation: requires an ACTIVE operator browser session (the
 * ChatPanel must be receiving the SSE stream + able to render the
 * preview iframe). Background workers / MCP without a chat tab
 * cannot screenshot — the tool times out at 30s. v0.4.x can add a
 * server-side Chromium fallback for those paths if a real use case
 * emerges.
 */

import { z } from "zod";
import { awaitScreenshot } from "../screenshot-orchestrator.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const screenshotInput = z
  .object({
    pageId: z.string().uuid(),
    chatBranchId: z.string().uuid().optional(),
    viewport: z.enum(["desktop", "tablet", "mobile"]).optional(),
  })
  .strict();

export type ScreenshotPageInput = z.infer<typeof screenshotInput>;

export const screenshotPageTool: ToolDefinitionWithHandler<ScreenshotPageInput> = {
  name: "screenshot_page",
  description:
    "Capture a screenshot of the rendered page (operator's browser does the capture via html2canvas; you see the result as an image attached to the next user turn). Use for VISUAL feedback — 'is the spacing right?', 'does the hero feel crowded?', 'what's the overall layout impression?'. " +
    "ALWAYS call this after composing a page or making structural/styling changes — desktop AND mobile viewports — and fix what the screenshot reveals BEFORE telling the operator you're done (max two review rounds; skip for content-only edits). " +
    "For CSS pathology (white halo around the header, wrong colors, broken layout) prefer `inspect_page_render` — it returns the HTML + every CSS layer separately and is faster + cheaper. " +
    "Pass `chatBranchId` to capture the chat-branch preview (with pending edits). REQUIRES an active operator browser session — fails with a 30s timeout if the operator closed the tab. Only call this once per visual check; the image is attached to ONE follow-up user turn, not persisted across the chat.",
  schema: screenshotInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      chatBranchId: {
        type: "string",
        format: "uuid",
        description:
          "Optional. When set, the captured iframe shows the chat-branch preview with staged edits. Usually the right choice when debugging the operator's in-progress work.",
      },
      viewport: {
        type: "string",
        enum: ["desktop", "tablet", "mobile"],
        description:
          "Optional viewport hint. ChatPanel applies the corresponding iframe dimensions before capture (1280x800 / 768x1024 / 375x812). Defaults to desktop.",
      },
    },
  },
  handler: async (_ctx, input, toolCtx) => {
    if (!toolCtx.pushClientEvent) {
      return {
        ok: false,
        content:
          "screenshot_page is only available inside an interactive chat session — no SSE handler is attached so the operator's browser can't be asked to capture. Try inspect_page_render for HTML/CSS-level debugging instead.",
      };
    }
    const requestId = crypto.randomUUID();
    // Yield the SSE event for ChatPanel — it'll mount the preview
    // iframe at the right viewport, run html2canvas on its body,
    // and POST the PNG to the upload endpoint.
    toolCtx.pushClientEvent({
      kind: "request-screenshot",
      requestId,
      pageId: input.pageId,
      ...(input.chatBranchId ? { chatBranchId: input.chatBranchId } : {}),
      viewport: input.viewport ?? "desktop",
    });
    try {
      const image = await awaitScreenshot(requestId, 30_000);
      return {
        ok: true,
        content: `Screenshot captured (${input.viewport ?? "desktop"} viewport). Image attached to the next user turn for analysis.`,
        image,
      };
    } catch (e) {
      return {
        ok: false,
        content: `screenshot_page failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  },
};
