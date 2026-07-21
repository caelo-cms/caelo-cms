// SPDX-License-Identifier: MPL-2.0

/**
 * issue #164 slice 3 — the screenshot-parity gate (compiler contract:
 * code verifies, the AI repairs).
 *
 * After materialising the selected Genesis draft into theme + modules,
 * "did the compiled site actually match the chosen design?" must be a
 * MEASURED answer, not a vibe. Both sides render under identical
 * conditions — the draft HTML and the composed page HTML (from
 * `pages.render_preview`) are screenshotted as `data:` documents in
 * the same headless viewport — then pixel-diffed with the
 * site-importer's classifier (`pass` ≤5% | `warn` ≤15% | `fail`).
 *
 * data-URL rendering is deliberate: no auth, no base-URL coupling, and
 * SYMMETRIC degradation — neither side can load `/_caelo/*` media or
 * fonts, and Genesis drafts carry no external assets by rule, so the
 * comparison measures structure, palette, and layout, which is exactly
 * what materialisation must preserve.
 *
 * Playwright is optional at runtime (same stance as the import
 * screenshots): when unavailable the tool reports that LOUDLY instead
 * of fake-passing (CLAUDE.md §2).
 */

import { execute } from "@caelo-cms/query-api";
import {
  computeDiffStatus,
  computePixelDiff,
  createPlaywrightScreenshotter,
  type Screenshotter,
} from "@caelo-cms/site-importer";
import { z } from "zod";
import { getMediaStorage } from "../../media/storage.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const parityInput = z
  .object({
    /** The page materialised from the draft (usually the homepage). */
    pageId: z.string().uuid(),
    /** Defaults to the SELECTED draft. */
    draftId: z.string().uuid().optional(),
  })
  .strict();
type ParityInput = z.infer<typeof parityInput>;

type ScreenshotterFactory = () => Promise<Screenshotter | null>;
type PixelDiff = typeof computePixelDiff;

/** Test seam — production uses the Playwright factory + real differ. */
let screenshotterFactory: ScreenshotterFactory = createPlaywrightScreenshotter;
let pixelDiff: PixelDiff = computePixelDiff;
export function setGenesisParityDepsForTests(deps: {
  factory?: ScreenshotterFactory;
  diff?: PixelDiff;
}): void {
  if (deps.factory) screenshotterFactory = deps.factory;
  if (deps.diff) pixelDiff = deps.diff;
}

function toDataUrl(html: string): string {
  return `data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}`;
}

export const checkGenesisParityTool: ToolDefinitionWithHandler<ParityInput> = {
  name: "check_genesis_parity",
  description:
    "Measure how closely the materialised page matches the SELECTED Genesis draft: both render in the same headless viewport and get pixel-diffed (pass ≤5% | warn ≤15% | fail). " +
    "Call after materialising (theme + modules + manifest) and after each repair round. On `warn`/`fail`, fix the named gap — palette, section structure, spacing — and re-check; HARD CAP two repair rounds, then report the residual honestly to the operator. " +
    "This is the compiler's verification stage: the design the operator chose is the contract, not an inspiration.",
  schema: parityInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      draftId: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // 1. Load the draft.
    const draftsRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "genesis.list_drafts", {
      includeHtml: true,
    });
    if (!draftsRes.ok) {
      return {
        ok: false,
        content: `genesis.list_drafts failed: ${describeError(draftsRes.error)}`,
      };
    }
    const drafts = (
      draftsRes.value as {
        drafts: {
          id: string;
          status: string;
          html?: string;
          sourceKind?: string;
          referenceAssetId?: string | null;
        }[];
      }
    ).drafts;
    const draft =
      input.draftId !== undefined
        ? drafts.find((d) => d.id === input.draftId)
        : drafts.find((d) => d.status === "selected");
    if (!draft?.html) {
      return {
        ok: false,
        content:
          "no selected Genesis draft found — parity is measured against the operator's chosen design (select_genesis_draft first)",
      };
    }

    // 2. Render the composed page through the SAME renderer production uses.
    const previewRes = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "pages.render_preview",
      {
        pageId: input.pageId,
        ...(ctx.chatBranchId ? { chatBranchId: ctx.chatBranchId } : {}),
      },
    );
    if (!previewRes.ok) {
      return {
        ok: false,
        content: `pages.render_preview failed: ${describeError(previewRes.error)}`,
      };
    }
    const composedHtml = (previewRes.value as { html: string }).html;

    // 3. Screenshot both sides under identical conditions.
    const shotter = await screenshotterFactory();
    if (shotter === null) {
      return {
        ok: false,
        content:
          "parity UNCHECKED — the screenshot runtime (Playwright chromium) is not available in this install. " +
          "Tell the operator the visual parity gate could not run; do NOT claim the design matches.",
      };
    }
    try {
      // issue #199 — byod_image drafts verify against the OPERATOR'S
      // uploaded mockup, not the AI's HTML reproduction of it: their
      // asset is the contract. Missing asset = loud failure.
      let referenceUrl: string;
      if (draft.sourceKind === "byod_image" && draft.referenceAssetId) {
        const assetRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "media.get", {
          assetId: draft.referenceAssetId,
        });
        const asset = assetRes.ok
          ? (assetRes.value as { asset: { storageKey: string; mime: string } | null }).asset
          : null;
        if (!asset) {
          return {
            ok: false,
            content:
              "parity UNCHECKED — the draft's reference mockup asset is missing (deleted?). Tell the operator the visual gate could not compare against their design.",
          };
        }
        let bytes: Uint8Array;
        try {
          bytes = await getMediaStorage().get(asset.storageKey);
        } catch (e) {
          return {
            ok: false,
            content: `parity UNCHECKED — the reference mockup could not be read from storage: ${e instanceof Error ? e.message : String(e)}.`,
          };
        }
        // Wrap in a minimal page so both sides render as full-width
        // documents in the same viewport.
        referenceUrl = toDataUrl(
          `<!doctype html><body style="margin:0"><img src="data:${asset.mime};base64,${Buffer.from(bytes).toString("base64")}" style="width:100%;display:block"></body>`,
        );
      } else {
        referenceUrl = toDataUrl(draft.html);
      }
      const [draftShot, composedShot] = [
        await shotter.capture(referenceUrl, { width: 1280, height: 800 }),
        await shotter.capture(toDataUrl(composedHtml), { width: 1280, height: 800 }),
      ];
      const diffPct = await pixelDiff(draftShot, composedShot);
      const { status } = computeDiffStatus(diffPct);
      const pct = (diffPct * 100).toFixed(1);
      const verdict =
        status === "pass"
          ? `PASS — composed page matches the chosen draft (${pct}% pixel diff). Materialisation verified; tell the operator.`
          : status === "warn"
            ? `WARN — ${pct}% pixel diff against the chosen draft. Compare hero/section backgrounds, spacing rhythm, and typography scale; fix the largest gap and re-check (max two repair rounds).`
            : `FAIL — ${pct}% pixel diff: the composed page does NOT match the chosen design. Re-read inspect_genesis_draft's inventory, fix palette/structure divergence, and re-check (max two repair rounds); if it still fails, report the residual honestly.`;
      return { ok: true, content: verdict, value: { status, diffPct } };
    } finally {
      await shotter.dispose().catch(() => {});
    }
  },
};
