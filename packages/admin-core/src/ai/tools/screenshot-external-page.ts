// SPDX-License-Identifier: MPL-2.0

/**
 * issue #189 — `screenshot_external_page`: render ONE external URL in
 * headless Chromium (SSRF-guarded per-capture, #191) and hand the
 * pixels to the model via the established `result.image` multimodal
 * path (tool-dispatch appends it as an image part on the next turn).
 *
 * This is the visual half of the migration glance: the design fact
 * base says WHICH colors exist; the screenshot says what the site
 * FEELS like — which is what the keep-design question is about.
 *
 * Playwright-absent runtimes fail LOUDLY (CLAUDE.md §2 no-fallbacks):
 * a silent text-only degrade would let the AI claim it "looked at"
 * a site it never saw.
 */

import { createPlaywrightScreenshotter, type Screenshotter } from "@caelo-cms/site-importer";
import { z } from "zod";
import { externalFetchAllowedHosts, takeExternalFetchBudget } from "./_external-fetch-budget.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const input = z
  .object({
    url: z.string().url(),
    viewport: z.enum(["desktop", "mobile"]).optional(),
  })
  .strict();
type Input = z.infer<typeof input>;

/**
 * Test seam: launching Chromium in unit tests is neither fast nor
 * deterministic. Mirrors `setGenesisParityDepsForTests`.
 */
let screenshotterFactory: (opts: {
  allowedHosts: readonly string[];
}) => Promise<Screenshotter | null> = (opts) => createPlaywrightScreenshotter(opts);

export function setExternalScreenshotDepsForTests(
  factory: typeof screenshotterFactory | null,
): void {
  screenshotterFactory = factory ?? ((opts) => createPlaywrightScreenshotter(opts));
}

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 375, height: 812 },
} as const;

export const screenshotExternalPageTool: ToolDefinitionWithHandler<Input> = {
  name: "screenshot_external_page",
  description:
    "Render ONE page of an EXTERNAL website in headless Chromium and see it as an image (attached to your next turn). Use together with `inspect_external_page` when an operator names their existing site — the inventory gives you the facts, this gives you the visual impression the keep-design question depends on. " +
    "Viewport-only capture (not full page): one glance, not an archive. Do NOT use for Caelo's own pages — use `screenshot_page`. Do NOT loop it over many URLs — for whole-site work propose the crawl. " +
    "Only public http(s) URLs; private/internal addresses are refused. Fails loudly when Playwright/Chromium is not installed in this runtime — report that to the operator instead of pretending you saw the page.",
  schema: input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", description: "Absolute public URL, e.g. https://example.com/" },
      viewport: {
        type: "string",
        enum: ["desktop", "mobile"],
        description: "Capture viewport. Defaults to desktop (1280×800).",
      },
    },
  },
  handler: async (_ctx, toolInput, toolCtx) => {
    const budget = takeExternalFetchBudget(toolCtx.chatSessionId);
    if (!budget.ok) {
      return {
        ok: false,
        content:
          "External-fetch budget exhausted for this session (12 per 10 minutes). For whole-site visual review, propose the crawl via `propose_site_import` — its worker captures screenshots per page.",
      };
    }
    const allowedHosts = externalFetchAllowedHosts();
    const screenshotter = await screenshotterFactory({ allowedHosts });
    if (!screenshotter) {
      return {
        ok: false,
        content:
          "screenshot_external_page UNAVAILABLE: Playwright/Chromium is not installed in this runtime (`bun node_modules/playwright/cli.js install chromium` in the repo root fixes it on self-hosted installs — bunx may fetch a version whose browser build differs). Tell the operator you could not visually inspect the site — use `inspect_external_page` for the non-visual fact base instead. Do NOT claim you saw the page.",
      };
    }
    try {
      const vp = VIEWPORTS[toolInput.viewport ?? "desktop"];
      const shot = await screenshotter.capture(toolInput.url, {
        width: vp.width,
        height: vp.height,
        external: true,
        fullPage: false,
      });
      return {
        ok: true,
        content: `Screenshot of ${toolInput.url} captured (${toolInput.viewport ?? "desktop"} viewport, ${vp.width}×${vp.height}). Image attached to the next turn. (${budget.remaining} external fetches left in this session's budget.)`,
        image: { base64: Buffer.from(shot.bytes).toString("base64"), mediaType: "image/png" },
      };
    } catch (e) {
      return {
        ok: false,
        content: `screenshot_external_page failed for ${toolInput.url}: ${e instanceof Error ? e.message : String(e)}`,
      };
    } finally {
      await screenshotter.dispose().catch(() => undefined);
    }
  },
};
