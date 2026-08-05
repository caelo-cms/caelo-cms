// SPDX-License-Identifier: MPL-2.0

/**
 * issue #412 — server-side `screenshot_page` backend: render the chat
 * branch's staged preview in the in-process headless Chromium and return
 * the pixels, so headless surfaces (Power-MCP, `mcp.send_chat`, subagent
 * child turns) can visually verify their work without an operator
 * browser.
 *
 * Decision (1) on the issue: navigate to the admin's OWN
 * `/_caelo/preview-screenshot/<pageId>` route with a short-lived signed
 * branch-scoped token (see `preview-screenshot-token.ts`) — real
 * rendering including real asset delivery, byte-identical to what the
 * operator's preview iframe shows for the same branch. The token rides a
 * request HEADER on the navigation and same-origin subresource requests
 * ONLY (never in a URL, never to third-party hosts the page may embed),
 * so it cannot land in access logs or leave the admin's origin.
 *
 * The browser is the SAME shared Chromium `screenshot_external_page`
 * uses (`_external-screenshotter.ts`) — one instance, idle-closed, no
 * second cold-start path.
 */

import {
  mintPreviewScreenshotToken,
  PREVIEW_SCREENSHOT_TOKEN_HEADER,
} from "./preview-screenshot-token.js";
import { externalFetchAllowedHosts } from "./tools/_external-fetch-budget.js";
import { getExternalScreenshotter } from "./tools/_external-screenshotter.js";
import { pngDimensions } from "./tools/screenshot-external-page.js";

/** Same viewport presets ChatPanel applies to the SSE-path iframe, so the
 *  two backends of `screenshot_page` show comparable framing. */
export const PREVIEW_SCREENSHOT_VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 812 },
} as const;

export type PreviewScreenshotViewport = keyof typeof PREVIEW_SCREENSHOT_VIEWPORTS;

export type PreviewScreenshotResult =
  | {
      readonly ok: true;
      readonly image: { readonly base64: string; readonly mediaType: "image/png" };
      /** Pixel size of the captured PNG (IHDR), when readable. */
      readonly widthPx?: number;
      readonly heightPx?: number;
    }
  | {
      readonly ok: false;
      readonly reason: "playwright-unavailable" | "self-origin-unresolvable" | "capture-failed";
      /** Operator/AI-facing detail; never contains token material. */
      readonly message: string;
    };

/**
 * Resolve the base URL under which THIS admin process serves HTTP, for
 * the headless browser's localhost navigation. Resolution order:
 * `CAELO_PREVIEW_SELF_ORIGIN` (explicit override) → `127.0.0.1:$PORT`
 * (svelte-adapter-bun serves on PORT; loopback bypasses IAP/identity
 * proxies, which would otherwise block a public-`ORIGIN` round-trip) →
 * `ORIGIN` (adapter convention). No silent default port (CLAUDE.md §2
 * no-fallbacks): a guessed-wrong port would screenshot someone else's
 * localhost service and present it as the page.
 */
export function resolvePreviewSelfOrigin():
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly message: string } {
  const explicit = process.env.CAELO_PREVIEW_SELF_ORIGIN?.trim();
  if (explicit) return { ok: true, origin: explicit.replace(/\/+$/, "") };
  const port = process.env.PORT?.trim();
  if (port && /^\d+$/.test(port)) return { ok: true, origin: `http://127.0.0.1:${port}` };
  const origin = process.env.ORIGIN?.trim();
  if (origin) return { ok: true, origin: origin.replace(/\/+$/, "") };
  return {
    ok: false,
    message:
      "the admin's own HTTP origin is not configured — set CAELO_PREVIEW_SELF_ORIGIN " +
      "(e.g. http://127.0.0.1:3000), or PORT, or ORIGIN so the server-side renderer " +
      "can reach the preview route",
  };
}

/**
 * Capture the branch-scoped preview of `pageId` server-side. Never
 * throws — every failure mode returns a structured, loud result the tool
 * handler can turn into AI-actionable content.
 */
export async function capturePreviewScreenshot(args: {
  readonly pageId: string;
  readonly chatBranchId?: string;
  readonly viewport?: PreviewScreenshotViewport;
  readonly selector?: string;
}): Promise<PreviewScreenshotResult> {
  const origin = resolvePreviewSelfOrigin();
  if (!origin.ok) {
    return { ok: false, reason: "self-origin-unresolvable", message: origin.message };
  }
  const screenshotter = await getExternalScreenshotter({
    allowedHosts: externalFetchAllowedHosts(),
  });
  if (!screenshotter) {
    return {
      ok: false,
      reason: "playwright-unavailable",
      message:
        "Playwright/Chromium is not installed in this runtime " +
        "(`bun node_modules/playwright/cli.js install chromium` in the repo root fixes it " +
        "on self-hosted installs)",
    };
  }
  const vp = PREVIEW_SCREENSHOT_VIEWPORTS[args.viewport ?? "desktop"];
  const token = mintPreviewScreenshotToken({
    pageId: args.pageId,
    ...(args.chatBranchId ? { chatBranchId: args.chatBranchId } : {}),
  });
  try {
    const shot = await screenshotter.capture(
      `${origin.origin}/_caelo/preview-screenshot/${args.pageId}`,
      {
        width: vp.width,
        height: vp.height,
        // Our own loopback origin — the external SSRF guard must NOT run
        // (it would block the private address by design).
        external: false,
        fullPage: true,
        ...(args.selector ? { selector: args.selector } : {}),
        sameOriginHeaders: { [PREVIEW_SCREENSHOT_TOKEN_HEADER]: token },
      },
    );
    if (shot.finalStatus !== undefined && shot.finalStatus >= 400) {
      // Refuse to present an error page as "the page" — loud instead.
      return {
        ok: false,
        reason: "capture-failed",
        message: `the preview route answered HTTP ${shot.finalStatus} for page ${args.pageId}${
          args.chatBranchId ? ` on branch ${args.chatBranchId}` : ""
        } — the page or branch may not exist`,
      };
    }
    const dims = pngDimensions(shot.bytes);
    return {
      ok: true,
      image: { base64: Buffer.from(shot.bytes).toString("base64"), mediaType: "image/png" },
      ...(dims ? { widthPx: dims.width, heightPx: dims.height } : {}),
    };
  } catch (e) {
    return {
      ok: false,
      reason: "capture-failed",
      message: e instanceof Error ? e.message : String(e),
    };
  } finally {
    // No-op on the shared reuse wrapper — the idle timer owns teardown.
    await screenshotter.dispose().catch(() => undefined);
  }
}
