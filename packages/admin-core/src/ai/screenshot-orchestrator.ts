// SPDX-License-Identifier: MPL-2.0

/**
 * v0.3.1 — In-process orchestrator for browser-mediated screenshot
 * capture. The `screenshot_page` AI tool needs to coordinate two
 * concurrent things:
 *
 *   (1) yield an SSE event to the operator's ChatPanel asking it
 *       to capture the preview iframe via html2canvas; and
 *   (2) wait for the operator's browser to upload the captured
 *       PNG to a separate POST endpoint, then return the bytes
 *       as the tool's ToolResult.image.
 *
 * The two HTTP requests (the SSE chat stream + the upload POST)
 * may land on different Cloud Run instances if the deployment
 * scales out without session affinity. v0.3.1 ships the simple
 * single-instance version: an in-process Map<requestId,
 * {resolve, reject}> registers pending captures, the upload
 * endpoint resolves the matching entry. If the upload lands on a
 * different instance it 404s; the operator's tab retries once.
 *
 * v0.4.x can promote this to a DB-backed table for multi-instance
 * deployments (operator with adminMaxInstances > 1 + bursty chat
 * traffic). Most installs run 1-3 instances and Cloud Run prefers
 * to keep a long-lived SSE pinned to one — so this assumption
 * holds in practice.
 */

/**
 * Capture formats the browser-side ChatPanel may upload. JPEG became
 * the default in the run #9 CI fix (issue #262): a full-viewport PNG
 * of a real page runs 0.8-1.1 MB base64, which exceeds
 * svelte-adapter-bun's default BODY_SIZE_LIMIT (512K) and the upload
 * dies with 413 before SvelteKit ever sees it. JPEG at quality 0.85
 * is 5-10x smaller at no cost to the vision-model verdict.
 */
export type ScreenshotMediaType = "image/png" | "image/jpeg";

interface PendingCapture {
  resolve: (image: { base64: string; mediaType: ScreenshotMediaType }) => void;
  reject: (reason: string) => void;
  /** When the entry expires + auto-rejects so the Map doesn't leak. */
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingCapture>();

/**
 * Register a pending screenshot. The caller (typically the
 * `screenshot_page` tool handler) generates the requestId, calls
 * this, then awaits the returned Promise. The promise resolves when
 * `deliverScreenshot(requestId, ...)` is called from the upload
 * endpoint.
 */
export function awaitScreenshot(
  requestId: string,
  timeoutMs: number = 30_000,
): Promise<{ base64: string; mediaType: ScreenshotMediaType }> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      pending.delete(requestId);
      reject(
        `screenshot ${requestId.slice(0, 8)}… timed out after ${timeoutMs}ms — operator's browser didn't capture in time`,
      );
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timeoutHandle });
  });
}

/**
 * Resolve a pending screenshot with the captured image bytes.
 * Called from the upload endpoint. Returns true if a pending entry
 * was matched (so the endpoint can return 200), false if not (404 —
 * SSE landed on a different instance OR timed out already).
 */
export function deliverScreenshot(
  requestId: string,
  image: { base64: string; mediaType: ScreenshotMediaType },
): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  clearTimeout(entry.timeoutHandle);
  pending.delete(requestId);
  entry.resolve(image);
  return true;
}

/**
 * Reject a pending screenshot (operator's browser reported an error
 * or aborted). Called from the upload endpoint's failure path.
 */
export function failScreenshot(requestId: string, reason: string): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  clearTimeout(entry.timeoutHandle);
  pending.delete(requestId);
  entry.reject(reason);
  return true;
}

/**
 * Test helper — drop all pending entries. Used by integration tests
 * that can't afford to wait for timeouts to fire.
 */
export function clearPendingScreenshots(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timeoutHandle);
  }
  pending.clear();
}
