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
 *   turns), when the SSE capture times out (operator closed the tab
 *   mid-turn), and when the target has no size in the script-less browser
 *   capture (an element only the page's scripts reveal).
 *
 * Backend selection keys on `toolCtx.operatorBrowserAttached`, NOT on
 * `pushClientEvent` alone: the chat-runner installs an event sink on
 * every dispatch (including headless send_chat, where nothing consumes
 * it), so the sink's presence cannot distinguish the surfaces.
 */

import { execute } from "@caelo-cms/query-api";
import { isScreenshotTargetNotRendered } from "@caelo-cms/shared";
import { z } from "zod";
import { capturePreviewScreenshot } from "../preview-screenshot.js";
import { awaitScreenshot, type ScreenshotViewportSource } from "../screenshot-orchestrator.js";
import { describeError } from "./_describe-error.js";
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

/**
 * State the capture viewport as fact. "Desktop" is not one width: module
 * type sizes scale with `vw`, so a fixed 1280px capture showed the AI a
 * 3-line headline that the operator's ~1740px preview wrapped onto 4 —
 * and the AI could not fix what it could not see. The sentence tells the
 * AI whose view it got and when line breaks may differ. Pure for tests.
 */
export function describeCaptureViewport(
  viewport: ScreenshotPageInput["viewport"],
  width: number,
  height: number,
  source: ScreenshotViewportSource,
): string {
  switch (source) {
    case "operator-preview":
      return ` Rendered at ${width}×${height}px — the operator's live preview size, so line breaks and wrapping match what the operator sees.`;
    case "requested":
      return ` Rendered at ${width}px wide (the width you requested), ${height}px tall.`;
    case "preset":
      return (viewport ?? "desktop") === "desktop"
        ? ` Rendered at the ${width}×${height}px desktop preset — NOT necessarily the operator's view; text can wrap differently at their width.`
        : ` Rendered at the ${viewport} preset ${width}×${height}px.`;
  }
}

const screenshotInput = z
  .object({
    pageId: z.string().uuid(),
    chatBranchId: z.string().uuid().optional(),
    viewport: z.enum(["desktop", "tablet", "mobile"]).optional(),
    /** Explicit layout width in CSS px — check another breakpoint on purpose. */
    width: z.number().int().min(320).max(3840).optional(),
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
/**
 * Why a capture the operator's browser was asked for ended up server-side:
 * it did not answer in time, or its script-less render cannot show the
 * target (see `SCREENSHOT_TARGET_NOT_RENDERED`).
 */
type ServerSideHandoff = "browser-timeout" | "not-rendered-in-browser";

const HANDOFF_FAILURE_NOTE: Record<ServerSideHandoff, string> = {
  "browser-timeout": " (The operator's browser was asked first and did not answer within 30s.)",
  "not-rendered-in-browser":
    " (The operator's browser was asked first; its capture runs without the page's scripts and the element had no size there.)",
};

const HANDOFF_SUCCESS_NOTE: Record<ServerSideHandoff, string> = {
  "browser-timeout":
    " (The operator's browser did not answer within 30s, so the server rendered instead.)",
  "not-rendered-in-browser":
    " (The element is revealed by the page's scripts — e.g. a consent banner — and the operator's browser capture runs without scripts, so the server rendered it with scripts instead.)",
};

async function captureServerSide(
  input: ScreenshotPageInput,
  chatBranchId: string | undefined,
  toolCtx: ToolContext,
  handoff?: ServerSideHandoff,
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
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.selector ? { selector: input.selector } : {}),
  });
  if (!r.ok) {
    const alsoTimedOut = handoff ? HANDOFF_FAILURE_NOTE[handoff] : "";
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
  const viewportNote = describeCaptureViewport(
    input.viewport,
    r.viewportWidth,
    r.viewportHeight,
    input.width !== undefined ? "requested" : "preset",
  );
  return {
    ok: true,
    content:
      `Screenshot captured (${input.viewport ?? "desktop"} viewport${
        input.selector ? `, element ${input.selector}` : ""
      }) by the server-side renderer — a real Chromium render of this chat's branch preview, no html2canvas approximation.${dims}${viewportNote}` +
      `${handoff ? HANDOFF_SUCCESS_NOTE[handoff] : ""} ` +
      "The image is available to you in THIS turn — analyse it on your next step; do not end the turn to wait for it.",
    image: r.image,
  };
}

export const screenshotPageTool: ToolDefinitionWithHandler<ScreenshotPageInput> = {
  name: "screenshot_page",
  description:
    "Screenshot a rendered Caelo page of this chat's branch preview (pending edits included). The image returns WITHIN this turn — analyse it next step, do NOT end the turn to wait; not persisted across the chat.\n" +
    "USE FOR: gross visual impression (crowded hero? colors/imagery? overall layout?).\n" +
    "DO NOT USE FOR: spacing/layout/CSS questions (word gaps, flex stacking, white halo around the header, wrong colors, broken layout) -> `inspect_page_render` (summary, then `target`/`search`: composed HTML + each CSS layer, the source of truth).\n" +
    "CORE RULES:\n" +
    "- ALWAYS call after composing a page or structural/styling changes — desktop AND mobile — and fix real issues BEFORE telling the operator you're done (max two review rounds; skip for content-only edits).\n" +
    "- Backend: interactive chat -> operator's browser (html2canvas, their exact viewport); no attached browser (MCP, background sends, subagents) -> real headless Chromium on the server. Result names the backend.\n" +
    "- html2canvas is an APPROXIMATION that mis-renders (1) fine text spacing (irregular word gaps like broken justify) and (2) flex-wrap (one item per line). Artifacts, NOT CSS bugs: never edit CSS or file a bug from a browser-captured screenshot alone — confirm with `inspect_page_render`. Chromium renders have no such artifacts.",
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
          "Omit (defaults to this chat's branch). Set only for another branch: the shared draft or the operator's own chats' branches; other editors' experiments -> 'branch not found'.",
      },
      viewport: {
        type: "string",
        enum: ["desktop", "tablet", "mobile"],
        description:
          "desktop (default) = operator's live preview size in interactive chat (result states size + whose view), else 1280x800; tablet = 768x1024; mobile = 375x812.",
      },
      width: {
        type: "integer",
        minimum: 320,
        maximum: 3840,
        description:
          "Overrides the viewport width (CSS px; height unchanged). Omit on the first capture (= operator's view). Desktop is not one width: vw/clamp() type wraps differently (3 lines at 1280px, 4 at 1740px) -> for typography/layout reviews ALSO capture a second width (1280 if the operator's view is wider, 1920 if narrower); the design must hold at both. Operator reports a wrap/break you don't see -> re-capture without `width` before concluding it's fine.",
      },
      selector: {
        type: "string",
        minLength: 1,
        maxLength: 300,
        description:
          "CSS selector: capture only the first match (e.g. '[data-caelo-module-id=\"<uuid>\"]', 'footer.caelo-layout-footer') — cheaper when checking one module. Error if nothing matches.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // Run #8 R3 (follow-up from live-edit CI) — default to the CURRENT
    // chat's branch, mirroring inspect_page_render. Without this, an
    // omitted chatBranchId made ChatPanel mount the PUBLISHED preview:
    // pre-staging pages 404'd in the iframe (a red console error the
    // operator sees) and the model concluded "the page isn't served
    // yet" instead of seeing its own work.
    const chatBranchId = input.chatBranchId ?? toolCtx.chatBranchId;
    // Issue #569 — an explicit branch override is checked against the
    // chat's owner before anything renders it: the server-side capture
    // renders as the system actor through a signed token, which would
    // otherwise show another editor's isolated branch to this chat.
    if (input.chatBranchId && input.chatBranchId !== toolCtx.chatBranchId) {
      const access = await execute(
        toolCtx.registry,
        toolCtx.adapter,
        ctx,
        "chat.check_branch_access",
        { chatBranchId: input.chatBranchId },
      );
      if (!access.ok) {
        return {
          ok: false,
          content: `screenshot_page: ${describeError(access.error)} Omit chatBranchId to capture this chat's own preview.`,
        };
      }
    }
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
      ...(input.width !== undefined ? { width: input.width } : {}),
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
      const viewportNote =
        m?.viewportWidth !== undefined &&
        m.viewportHeight !== undefined &&
        m.viewportSource !== undefined
          ? describeCaptureViewport(
              input.viewport,
              m.viewportWidth,
              m.viewportHeight,
              m.viewportSource,
            )
          : "";
      return {
        ok: true,
        content: `Screenshot captured (${input.viewport ?? "desktop"} viewport${input.selector ? `, element ${input.selector}` : ""}).${geometry}${viewportNote} The image is available to you in THIS turn — analyse it on your next step; do not end the turn to wait for it.`,
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
        return captureServerSide(input, chatBranchId, toolCtx, "browser-timeout");
      }
      // The browser capture runs without the page's scripts (#946), so an
      // element a script reveals has no size there — a limit of that
      // backend, not a page problem. The server renderer runs scripts.
      if (isScreenshotTargetNotRendered(message)) {
        return captureServerSide(input, chatBranchId, toolCtx, "not-rendered-in-browser");
      }
      return {
        ok: false,
        content: screenshotFailureContent(message),
      };
    }
  },
};
