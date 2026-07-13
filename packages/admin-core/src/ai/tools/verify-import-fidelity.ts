// SPDX-License-Identifier: MPL-2.0

/**
 * issue #250 (WS4) — the migration fidelity gate's AI-facing verdict tool.
 *
 * "Habe ich das gut gemacht?" turned into a MEASURED answer. After the AI
 * rebuilds an imported page it calls this to compare the page's STORED SOURCE
 * screenshot (the live original, captured during the crawl — WS1 #257)
 * against a fresh screenshot of the REBUILT Caelo page (rendered through the
 * same `pages.render_preview` path production uses). A coarse structural diff
 * (downscale + per-cell colour delta) yields pass/warn/fail + a "what
 * drifted" band hint; the result is written to `import_pages.diff_status` /
 * `diff_pct` so the run report + missing-content surface can flag it.
 *
 * This is the engine behind #278's homepage self-analysis checkpoint (build
 * the homepage → self-grade → ask the operator "passt die Richtung?"). It is
 * ALSO the #244 loop-cost fix: the verdict (numbers + pass/fail + hint) comes
 * back SYNCHRONOUSLY in the tool result — no browser round-trip, no image
 * deferred to the next turn — so the AI can decide "fix vs present" in the
 * same cycle it rebuilt the page, without an operator "continue" nudge.
 *
 * Pages with no stored source screenshot are reported UNVERIFIED (loud),
 * never a silent "pass" (CLAUDE.md §2). When the screenshot runtime
 * (Playwright chromium) is unavailable, the tool says so LOUDLY rather than
 * fake-passing — same stance as check_genesis_parity.
 */

import { execute } from "@caelo-cms/query-api";
import {
  computeFidelityStatus,
  computeStructuralDiff,
  createPlaywrightScreenshotter,
  type DiffStatus,
  type PageBand,
} from "@caelo-cms/site-importer";
import { z } from "zod";
import { getMediaStorage } from "../../media/storage.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const fidelityInput = z
  .object({
    /** EITHER the staging import_pages id OR the composed page id you just
     *  built (accepted_page_id) — both resolve to the same import page. */
    importPageId: z.string().uuid(),
  })
  .strict();
type FidelityInput = z.infer<typeof fidelityInput>;

/** Human-readable region for a diverging band — a free "what drifted" hint. */
function bandRegion(band: PageBand): string {
  return band === "top"
    ? "the header/hero area"
    : band === "bottom"
      ? "the footer area"
      : "the main content";
}

/**
 * Pure verdict-string builder — kept separate from the I/O so the phrasing is
 * unit-testable without Playwright or a database. Encodes the two-round
 * repair cap + the "never claim done over a red page" contract.
 */
export function buildFidelityVerdict(input: {
  status: DiffStatus;
  diffPct: number;
  worstBand: PageBand;
  bandPct: number;
  sourceUrl: string | null;
}): string {
  const pct = (input.diffPct * 100).toFixed(1);
  const bandPct = (input.bandPct * 100).toFixed(1);
  const where = `${bandRegion(input.worstBand)} diverged most (${bandPct}%)`;
  const src = input.sourceUrl ? ` vs ${input.sourceUrl}` : "";
  if (input.status === "pass") {
    return `PASS — the rebuilt page structurally matches the original${src} (${pct}% diff; ${where}). Fidelity verified; you can present this page.`;
  }
  if (input.status === "warn") {
    return `WARN — ${pct}% structural diff from the original${src}; ${where}. Look at that region against the source screenshot (get_import_page_screenshot), fix the largest gap — missing section, wrong spacing/colour, dropped image — and re-run this check. HARD CAP two repair rounds, then tell the operator what still differs. Do NOT report this page as done while it reads WARN.`;
  }
  return `FAIL — ${pct}% structural diff: the rebuilt page does NOT match the original${src}; ${where}. This usually means a blank/broken page, a missing section, or the wrong template. Compare against the source (get_import_page_screenshot), rebuild the divergent part, and re-check (max two repair rounds). If it still FAILs, report it honestly — never say "fertig" over a failed page.`;
}

/** data: URL wrapper so the rebuilt HTML renders as a standalone document in
 *  the headless viewport (no auth, no base-URL coupling). Matches
 *  check_genesis_parity's rendering path. */
function toDataUrl(html: string): string {
  return `data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}`;
}

export const verifyImportFidelityTool: ToolDefinitionWithHandler<FidelityInput> = {
  name: "verify_import_page_fidelity",
  description:
    "Measure how faithfully a REBUILT imported page matches its original: the stored source screenshot is structurally diffed against a fresh render of your rebuilt page, returning pass (≤12%) / warn (≤25%) / fail (>25%) + which region drifted most. " +
    "Call it right after you build a page from an import (homepage FIRST as the design anchor, then per page type) and after each repair round. The verdict comes back in THIS tool result — numbers, not a deferred image — so act on it immediately: on warn/fail fix the named region and re-check (HARD CAP two rounds) BEFORE telling the operator the page is done. " +
    "`importPageId` accepts EITHER id: the staging import_pages id OR the composed CMS page id you just built (accept_page / compose_from_import) — both work. A page with no stored source screenshot comes back UNVERIFIED (say so plainly; never claim it matches). Use `get_import_page_screenshot` to actually LOOK at the source when a diff tells you to fix something.",
  schema: fidelityInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["importPageId"],
    properties: {
      importPageId: {
        type: "string",
        format: "uuid",
        description:
          "The page to grade — pass EITHER the staging import_pages id OR the composed page id (accepted_page_id). Both resolve to the same import page.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // 1. Resolve source screenshot + composed page id from either id.
    const inputsRes = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "imports.get_page_fidelity_inputs",
      { pageRef: input.importPageId },
    );
    if (!inputsRes.ok) {
      return {
        ok: false,
        content: `verify_import_page_fidelity failed: ${describeError(inputsRes.error)}`,
      };
    }
    const inputs = inputsRes.value as {
      importPageId: string;
      sourceUrl: string | null;
      screenshotObjectKey: string | null;
      acceptedPageId: string | null;
    };

    // 2. No source screenshot → UNVERIFIED, loud (never a silent pass).
    if (inputs.screenshotObjectKey === null) {
      return {
        ok: false,
        content:
          "UNVERIFIED — this page has NO stored source screenshot, so there is no ground truth to diff the rebuild against. Tell the operator this page could not be fidelity-checked; do NOT claim it matches the original. (Source screenshots are captured during the crawl; a missing one means a fetch-only crawl or a capture failure — see the run report's screenshot_missing warning.)",
      };
    }
    // 3. Not composed yet → tell the AI to build it first.
    if (inputs.acceptedPageId === null) {
      return {
        ok: false,
        content:
          "this import page has not been composed into a Caelo page yet — build it first (compose_from_import / accept_page), then re-run verify_import_page_fidelity on the resulting page id.",
      };
    }

    // 4. Load the stored SOURCE screenshot bytes.
    let sourceBytes: Uint8Array;
    try {
      sourceBytes = await getMediaStorage().get(inputs.screenshotObjectKey);
    } catch (e) {
      return {
        ok: false,
        content: `UNVERIFIED — the stored source screenshot could not be read from storage (${e instanceof Error ? e.message : String(e)}). Do not claim the rebuild matches; tell the operator the fidelity check could not run.`,
      };
    }

    // 5. Render the rebuilt page through the SAME renderer production uses.
    const previewRes = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "pages.render_preview",
      {
        pageId: inputs.acceptedPageId,
        ...(ctx.chatBranchId ? { chatBranchId: ctx.chatBranchId } : {}),
      },
    );
    if (!previewRes.ok) {
      return {
        ok: false,
        content: `pages.render_preview failed: ${describeError(previewRes.error)}`,
      };
    }
    const rebuiltHtml = (previewRes.value as { html: string }).html;

    // 6. Screenshot the rebuilt page in a headless viewport.
    const shotter = await createPlaywrightScreenshotter();
    if (shotter === null) {
      return {
        ok: false,
        content:
          "fidelity UNCHECKED — the screenshot runtime (Playwright chromium) is not available in this install. Tell the operator the visual fidelity gate could not run; do NOT claim the rebuild matches the original.",
      };
    }
    let diffFraction: number;
    let worstBand: PageBand;
    let bandPct: number;
    let rebuiltBytes: Uint8Array;
    try {
      const shot = await shotter.capture(toDataUrl(rebuiltHtml), {
        width: 1280,
        height: 800,
        fullPage: true,
      });
      rebuiltBytes = shot.bytes;
      const diff = await computeStructuralDiff(sourceBytes, rebuiltBytes);
      diffFraction = diff.fraction;
      worstBand = diff.worstBand;
      bandPct = diff.bands[diff.worstBand];
    } catch (e) {
      return {
        ok: false,
        content: `fidelity UNCHECKED — screenshot/diff failed: ${e instanceof Error ? e.message : String(e)}. Do not claim the rebuild matches; report to the operator.`,
      };
    } finally {
      await shotter.dispose().catch(() => {});
    }

    const { status } = computeFidelityStatus(diffFraction);

    // 7. Persist the rebuilt screenshot (best-effort, for the review
    //    side-by-side) + the verdict. update_page_diff is system-scoped:
    //    the diff is computed by our code, not AI judgement, so recording
    //    it under the system actor mirrors change_page_slug's sub-op call.
    let stagedKey: string | undefined;
    try {
      stagedKey = `imports/staged/${inputs.importPageId}.png`;
      await getMediaStorage().put(stagedKey, rebuiltBytes, "image/png");
    } catch {
      // Non-fatal: the verdict + numbers still land; only the review
      // thumbnail is missing.
      stagedKey = undefined;
    }
    const persistRes = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      { ...ctx, actorKind: "system" },
      "imports.update_page_diff",
      {
        importPageId: inputs.importPageId,
        diffStatus: status,
        diffPct: diffFraction,
        ...(stagedKey ? { stagedScreenshotObjectKey: stagedKey } : {}),
      },
    );
    const persistNote = persistRes.ok
      ? ""
      : ` (note: the verdict could not be persisted to the run report: ${describeError(persistRes.error)})`;

    return {
      ok: true,
      content:
        buildFidelityVerdict({
          status,
          diffPct: diffFraction,
          worstBand,
          bandPct,
          sourceUrl: inputs.sourceUrl,
        }) + persistNote,
      value: { status, diffPct: diffFraction, worstBand },
    };
  },
};
