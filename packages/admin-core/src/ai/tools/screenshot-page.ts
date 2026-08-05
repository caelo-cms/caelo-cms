// SPDX-License-Identifier: MPL-2.0

/**
 * v0.3.1 — `screenshot_page` AI tool. ONE tool, TWO backends (issue #412):
 *
 * - Operator-browser capture (interactive chat): the tool emits a
 *   `request-screenshot` SSE event to ChatPanel, which uses html2canvas
 *   on the preview iframe and POSTs the PNG to the upload endpoint.
 *   Captures EXACTLY what the operator sees (same browser, same fonts,
 *   same extensions) — see plans/check-the-cms-requirements-smooth-book.md
 *   for the original trade-off.
 * - Server-side capture (headless surfaces): the in-process Chromium
 *   renders the chat branch's preview via the signed-token route (see
 *   `../preview-screenshot.ts`). Used when no operator browser consumes
 *   client events (Power-MCP dispatch, `mcp.send_chat`, subagent child
 *   turns) and as the fallback when the SSE capture times out (operator
 *   closed the tab mid-turn).
 *
 * Backend selection keys on `toolCtx.operatorBrowserAttached`, NOT on
 * `pushClientEvent` alone: the chat-runner installs an event sink on
 * every dispatch (including headless send_chat, where nothing consumes
 * it), so the sink's presence cannot distinguish the surfaces.
 */

import { z } from "zod";
import { capturePreviewScreenshot } from "../preview-screenshot.js";
import { awaitScreenshot } from "../screenshot-orchestrator.js";
import { takePreviewScreenshotBudget } from "./_preview-screenshot-budget.js";
import type { ToolContext, ToolDefinitionWithHandler, ToolResult } from "./dispatch.js";

/**
 * Build the failure tool-result content for a LIVE-browser capture failure
 * (html2canvas error, selector no-match, upload failure). Timeouts never
 * reach this since issue #412 — they fall back to the server-side renderer
 * instead of dead-ending the model (pre-#412, a live run looped
 * screenshot_page × viewports × attempts on 30s timeouts —
 * run-logs/token-efficiency-analysis.md). Pure so it's unit-testable
 * without the browser bridge.
 */
export function screenshotFailureContent(errorMessage: string): string {
  return `screenshot_page failed: ${errorMessage}`;
}

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

/**
 * issue #412 — capture via the server-side renderer (headless surfaces +
 * the SSE-timeout fallback). Budget-gated per session so an agent cannot
 * flood the in-process Chromium; every failure mode returns AI-actionable
 * content (CLAUDE.md §11) instead of throwing.
 */
async function captureServerSide(
  input: ScreenshotPageInput,
  chatBranchId: string | undefined,
  toolCtx: ToolContext,
  sseTimeoutNote?: string,
): Promise<ToolResult> {
  const budget = takePreviewScreenshotBudget(toolCtx.chatSessionId);
  if (!budget.ok) {
    return {
      ok: false,
      content:
        "screenshot_page budget exhausted for this session (24 server-side captures per 10 minutes). " +
        "Do NOT retry now — continue the work and verify layout/CSS questions with `inspect_page_render` instead; " +
        "screenshot again once the window has passed.",
    };
  }
  const r = await capturePreviewScreenshot({
    pageId: input.pageId,
    ...(chatBranchId ? { chatBranchId } : {}),
    ...(input.viewport ? { viewport: input.viewport } : {}),
    ...(input.selector ? { selector: input.selector } : {}),
  });
  if (!r.ok) {
    const alsoTimedOut = sseTimeoutNote
      ? " (The operator's browser was asked first and did not answer within 30s.)"
      : "";
    if (r.reason === "playwright-unavailable") {
      return {
        ok: false,
        content:
          `screenshot_page UNAVAILABLE on this surface: ${r.message}.${alsoTimedOut} ` +
          "Do NOT retry this turn and do NOT claim you saw the page — verify with `inspect_page_render` " +
          "(composed HTML + CSS, no browser) and tell the operator you could not visually verify the render.",
      };
    }
    return {
      ok: false,
      content:
        `screenshot_page (server-side render) failed: ${r.message}.${alsoTimedOut} ` +
        "Do NOT retry with identical arguments this turn. For layout/CSS verification use `inspect_page_render`; " +
        "if the page or branch id looks wrong, re-check it with `list_pages` first.",
    };
  }
  const dims = r.widthPx !== undefined ? ` Image: ${r.widthPx}×${r.heightPx}px.` : "";
  return {
    ok: true,
    content:
      `Screenshot captured (${input.viewport ?? "desktop"} viewport${
        input.selector ? `, element ${input.selector}` : ""
      }) by the server-side renderer — a real Chromium render of this chat's branch preview, no html2canvas approximation.${dims}` +
      `${sseTimeoutNote ? " (The operator's browser did not answer within 30s, so the server rendered instead.)" : ""} ` +
      "The image is available to you in THIS turn — analyse it on your next step; do not end the turn to wait for it.",
    image: r.image,
  };
}

export const screenshotPageTool: ToolDefinitionWithHandler<ScreenshotPageInput> = {
  name: "screenshot_page",
  description:
    "Capture a screenshot of the rendered page (the image comes back WITHIN this same turn — keep working and analyse it on your next step, do NOT end your turn to wait for it). Use for the GROSS visual impression — 'does the hero feel crowded?', 'is the color/imagery right?', 'what's the overall layout impression?'. " +
    "Works on EVERY surface: in an interactive chat the operator's browser captures (html2canvas on their exact viewport); without an attached browser (MCP, background sends, subagent turns) the server renders the branch preview in real headless Chromium instead — the result text names which backend ran. " +
    "FIDELITY LIMIT (browser-captured results only) — html2canvas is an APPROXIMATION, not a real browser render. It reliably mis-renders TWO things: (1) fine text spacing — words can show large irregular gaps that look like broken text-align:justify, and (2) flex-wrap — wrapping rows can stack one-item-per-line. These are html2canvas artifacts, NOT real CSS bugs. If a browser-captured screenshot shows justified-looking word gaps or single-column flex stacking, DO NOT edit CSS or file a bug from the screenshot alone — confirm against `inspect_page_render` first. Server-rendered results are real Chromium output and carry no such artifacts. " +
    "ALWAYS call this after composing a page or making structural/styling changes — desktop AND mobile viewports — and fix real issues the screenshot reveals BEFORE telling the operator you're done (max two review rounds; skip for content-only edits). " +
    "For ANY spacing/layout/CSS question (word gaps, flex stacking, white halo around the header, wrong colors, broken layout) prefer `inspect_page_render` — its summary then `target`/`search` give the composed HTML and each CSS layer separately, the accurate source of truth for spacing + layout. " +
    "Pass `selector` (CSS selector) to capture a SINGLE element instead of the whole page — right choice when checking one module (a footer, a hero) instead of the page. By default the capture shows THIS chat's branch preview (your pending edits included); pass `chatBranchId` only to capture a different branch. The image is available to you in this turn only, not persisted across the chat.",
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
    // Run #8 R3 (follow-up from live-edit CI) — default to the CURRENT
    // chat's branch, mirroring inspect_page_render. Without this, an
    // omitted chatBranchId made ChatPanel mount the PUBLISHED preview:
    // pre-staging pages 404'd in the iframe (a red console error the
    // operator sees) and the model concluded "the page isn't served
    // yet" instead of seeing its own work.
    const chatBranchId = input.chatBranchId ?? toolCtx.chatBranchId;
    // issue #412 — backend selection. Only an interactive chat whose SSE
    // stream a real browser consumes may use the operator-browser path;
    // everything else (Power-MCP dispatch, headless send_chat, subagent
    // child turns, tests) renders server-side directly — no 30s timeout.
    if (!toolCtx.pushClientEvent || toolCtx.operatorBrowserAttached !== true) {
      return captureServerSide(input, chatBranchId, toolCtx);
    }
    const requestId = crypto.randomUUID();
    // Yield the SSE event for ChatPanel — it'll mount the preview
    // iframe at the right viewport, run html2canvas on its body,
    // and POST the PNG to the upload endpoint.
    toolCtx.pushClientEvent({
      kind: "request-screenshot",
      requestId,
      pageId: input.pageId,
      // Thread the tool-call id so ChatPanel stores the image it captures
      // straight into `toolImages[toolCallId]` — the card shows the operator's
      // own capture without waiting on (or relying on) the SSE image echo.
      ...(toolCtx.toolCallId ? { toolCallId: toolCtx.toolCallId } : {}),
      ...(chatBranchId ? { chatBranchId } : {}),
      ...(input.selector ? { selector: input.selector } : {}),
      viewport: input.viewport ?? "desktop",
    });
    try {
      const image = await awaitScreenshot(requestId, 30_000);
      // Capture geometry as FACT text (2026-07, run B4): the model
      // doubted a selector crop and had no way to verify. With the
      // canvas + page dimensions in the result, crop-vs-full-page is
      // decidable without vision judgment — and auditable from logs.
      const m = image.meta;
      const geometry = m
        ? input.selector
          ? m.canvasWidth >= m.pageWidth && m.canvasHeight >= m.pageHeight * 0.95
            ? ` The crop is ${m.canvasWidth}×${m.canvasHeight}px — effectively the WHOLE ${m.pageWidth}×${m.pageHeight}px page; your selector matched a full-page wrapper. Use a more specific selector for a tighter crop.`
            : ` Crop: ${m.canvasWidth}×${m.canvasHeight}px out of the ${m.pageWidth}×${m.pageHeight}px page.`
          : ` Image: ${m.canvasWidth}×${m.canvasHeight}px (full page: ${m.pageWidth}×${m.pageHeight}px).`
        : "";
      return {
        ok: true,
        content: `Screenshot captured (${input.viewport ?? "desktop"} viewport${input.selector ? `, element ${input.selector}` : ""}).${geometry} The image is available to you in THIS turn — analyse it on your next step; do not end the turn to wait for it.`,
        image,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // issue #412 — a TIMEOUT means no browser answered (tab closed,
      // stream stale). Instead of handing the model a dead end, fall back
      // to the server-side renderer within the same call. Non-timeout
      // failures (html2canvas error, selector no-match) come from a LIVE
      // browser and stay loud — the server render would mask a real
      // browser-side problem the model should see.
      if (/timed out/i.test(message)) {
        return captureServerSide(input, chatBranchId, toolCtx, message);
      }
      return {
        ok: false,
        content: screenshotFailureContent(message),
      };
    }
  },
};
