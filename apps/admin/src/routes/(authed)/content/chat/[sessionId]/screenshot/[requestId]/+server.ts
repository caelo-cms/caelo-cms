// SPDX-License-Identifier: MPL-2.0

/**
 * v0.3.1 — Screenshot upload endpoint. ChatPanel calls this with a
 * captured PNG (base64-encoded) when the chat-runner emitted a
 * `request-screenshot` SSE event with a matching requestId.
 *
 * The handler resolves the in-process awaiting Promise (see
 * `screenshot-orchestrator.ts`) so the AI's `screenshot_page` tool
 * call returns the image bytes as `ToolResult.image`.
 *
 * Multi-instance caveat: orchestrator state is in-process. If the
 * SSE chat stream + this upload land on different Cloud Run
 * instances (no session affinity), the upload returns 404 and the
 * SSE side eventually times out at 30s. v0.3.1 ships this single-
 * instance shape; v0.4.x can promote to a DB-backed table for
 * multi-instance deployments. Most installs run 1-3 instances and
 * Cloud Run keeps long-lived SSE pinned, so this works in practice.
 */

import { deliverScreenshot, failScreenshot } from "@caelo-cms/admin-core";
import { error, json } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import type { RequestHandler } from "./$types";

interface UploadBody {
  /** base64-encoded image payload (no `data:` prefix). */
  base64: string;
  /**
   * Run #9 CI fix (issue #262) — ChatPanel captures as JPEG by default
   * now (a full-viewport PNG runs ~1 MB base64 and trips
   * svelte-adapter-bun's 512K default BODY_SIZE_LIMIT with a 413).
   * Optional for back-compat with tabs still running the PNG-only
   * client; absent means PNG.
   */
  mediaType?: "image/png" | "image/jpeg";
  /** When the operator's browser couldn't capture (html2canvas
   *  threw, iframe didn't load, etc.). Resolves the orchestrator's
   *  Promise to a rejection so the AI's tool result is a clean
   *  failure. Mutually exclusive with `base64`. */
  errorMessage?: string;
  /** 2026-07 — capture geometry (canvas + page dimensions) so the
   *  tool result can state crop-vs-full-page as a fact instead of
   *  leaving it to vision judgment (run B4 selector-crop doubt). */
  meta?: {
    canvasWidth: number;
    canvasHeight: number;
    pageWidth: number;
    pageHeight: number;
  };
}

/** All four geometry fields present and sane, or the meta is dropped. */
function sanitizeMeta(meta: UploadBody["meta"]): UploadBody["meta"] | undefined {
  if (!meta) return undefined;
  const vals = [meta.canvasWidth, meta.canvasHeight, meta.pageWidth, meta.pageHeight];
  if (vals.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000)) {
    return undefined;
  }
  return {
    canvasWidth: Math.round(meta.canvasWidth),
    canvasHeight: Math.round(meta.canvasHeight),
    pageWidth: Math.round(meta.pageWidth),
    pageHeight: Math.round(meta.pageHeight),
  };
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  // Same permission as the chat send — the operator must already
  // have an active chat session for this to be useful, and chat
  // sessions require content.read.
  requirePermission(locals, "content.read");
  if (!locals.user) throw error(401, "Not authenticated");

  // Lightweight CSRF check via a header (the body is JSON, not
  // form-encoded). Same shape as the SSE stream endpoint.
  const csrf = request.headers.get("x-csrf-token") ?? "";
  const { verifyCsrfToken } = await import("@caelo-cms/admin-core");
  if (!(await verifyCsrfToken(locals.user.csrfSecret, csrf))) {
    throw error(403, "CSRF token mismatch");
  }

  const requestId = params.requestId ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
    throw error(400, "invalid requestId format");
  }

  const body = (await request.json()) as UploadBody;

  if (typeof body.errorMessage === "string" && body.errorMessage.length > 0) {
    const matched = failScreenshot(requestId, body.errorMessage);
    if (!matched) {
      // Either the SSE landed on a different instance, the request
      // expired (30s timeout already fired), OR this is a duplicate
      // upload after the first one already resolved. Return 404 so
      // the operator's tab can decide whether to retry or give up.
      throw error(404, "no pending screenshot for this requestId");
    }
    return json({ ok: true, kind: "failure" });
  }

  if (typeof body.base64 !== "string" || body.base64.length === 0) {
    throw error(400, "missing base64 image payload");
  }
  const mediaType = body.mediaType ?? "image/png";
  if (mediaType !== "image/png" && mediaType !== "image/jpeg") {
    throw error(400, `unsupported mediaType: ${String(mediaType)}`);
  }
  // Reject obviously oversized payloads. Browser captures of an
  // edit-overlay iframe at 1280x800 typically land ≤ 500 KB; cap at
  // 10 MB so a malformed canvas dump can't exhaust memory.
  if (body.base64.length > 10_000_000) {
    throw error(413, `payload too large: ${body.base64.length} chars`);
  }

  const meta = sanitizeMeta(body.meta);
  const matched = deliverScreenshot(requestId, {
    base64: body.base64,
    mediaType,
    ...(meta ? { meta } : {}),
  });
  if (!matched) {
    throw error(404, "no pending screenshot for this requestId");
  }
  return json({ ok: true, kind: "delivered" });
};
