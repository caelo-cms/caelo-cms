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
    /** issue #250 (WS4) — CSS selector for a single-element capture. */
    selector: z.string().min(1).max(300).optional(),
  })
  .strict();

export type ScreenshotPageInput = z.infer<typeof screenshotInput>;

export const screenshotPageTool: ToolDefinitionWithHandler<ScreenshotPageInput> = {
  name: "screenshot_page",
  description:
    "Capture a screenshot of the rendered page (operator's browser does the capture via html2canvas; you see the result as an image attached to the next user turn). Use for VISUAL feedback — 'is the spacing right?', 'does the hero feel crowded?', 'what's the overall layout impression?'. " +
    "ALWAYS call this after composing a page or making structural/styling changes — desktop AND mobile viewports — and fix what the screenshot reveals BEFORE telling the operator you're done (max two review rounds; skip for content-only edits). " +
    "For CSS pathology (white halo around the header, wrong colors, broken layout) prefer `inspect_page_render` — it returns the HTML + every CSS layer separately and is faster + cheaper. " +
    "Pass `selector` (CSS selector) to capture a SINGLE element instead of the whole page — right choice when checking one module (a footer, a hero) instead of the page. By default the capture shows THIS chat's branch preview (your pending edits included); pass `chatBranchId` only to capture a different branch. REQUIRES an active operator browser session — fails with a 30s timeout if the operator closed the tab. Only call this once per visual check; the image is attached to ONE follow-up user turn, not persisted across the chat.",
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
          "Optional override. Defaults to the current chat's branch, so you normally omit it. Set it only to capture another branch's staged edits.",
      },
      viewport: {
        type: "string",
        enum: ["desktop", "tablet", "mobile"],
        description:
          "Optional viewport hint. ChatPanel applies the corresponding iframe dimensions before capture (1280x800 / 768x1024 / 375x812). Defaults to desktop.",
      },
      selector: {
        type: "string",
        minLength: 1,
        maxLength: 300,
        description:
          "Optional CSS selector — capture ONLY the first matching element instead of the full page (e.g. '[data-caelo-module-id=\"<uuid>\"]', 'footer.caelo-layout-footer'). Use when verifying or debugging a single module; cheaper to analyse than a full page. Fails loudly if nothing matches.",
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
    // Run #8 R3 (follow-up from live-edit CI) — default to the CURRENT
    // chat's branch, mirroring inspect_page_render. Without this, an
    // omitted chatBranchId made ChatPanel mount the PUBLISHED preview:
    // pre-staging pages 404'd in the iframe (a red console error the
    // operator sees) and the model concluded "the page isn't served
    // yet" instead of seeing its own work.
    const chatBranchId = input.chatBranchId ?? toolCtx.chatBranchId;
    // Yield the SSE event for ChatPanel — it'll mount the preview
    // iframe at the right viewport, run html2canvas on its body,
    // and POST the PNG to the upload endpoint.
    toolCtx.pushClientEvent({
      kind: "request-screenshot",
      requestId,
      pageId: input.pageId,
      ...(chatBranchId ? { chatBranchId } : {}),
      ...(input.selector ? { selector: input.selector } : {}),
      viewport: input.viewport ?? "desktop",
    });
    try {
      const image = await awaitScreenshot(requestId, 30_000);
      return {
        ok: true,
        content: `Screenshot captured (${input.viewport ?? "desktop"} viewport${input.selector ? `, element ${input.selector}` : ""}). Image attached to the next user turn for analysis.`,
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
