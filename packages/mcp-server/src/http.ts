// SPDX-License-Identifier: MPL-2.0

/**
 * Shared HTTP plumbing for both MCP surfaces (chat + admin). One POST
 * per call against the admin install's /api/mcp/* endpoints, bearer in
 * the `x-caelo-mcp-token` header, with an abortable client-side timeout.
 * On IAP-protected installs the IAP credential rides along in
 * `authorization` (see ingress-auth.ts).
 *
 * Timeouts default per call site (chat 30s, tool execution 120s — bulk
 * ops and media imports legitimately run long) and can be overridden
 * globally via `CAELO_MCP_TIMEOUT_MS`.
 */

import { describeIapRejection, ingressHeaders } from "./ingress-auth.js";

export interface AdminPostOpts {
  readonly adminUrl: string;
  readonly token: string;
  /** Path under the admin origin, e.g. "/api/mcp/tool". */
  readonly path: string;
  readonly body: unknown;
  readonly timeoutMs: number;
}

/** The per-call default unless the operator set `CAELO_MCP_TIMEOUT_MS`. */
export function resolveTimeoutMs(defaultMs: number): number {
  const raw = process.env.CAELO_MCP_TIMEOUT_MS;
  if (!raw) return defaultMs;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
}

export async function postAdmin<T>(opts: AdminPostOpts): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const url = `${opts.adminUrl.replace(/\/+$/, "")}${opts.path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...(await ingressHeaders()),
        "content-type": "application/json",
        "x-caelo-mcp-token": opts.token,
      },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
    if (res.status === 429) throw new Error(await busyMessage(res));
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(
        describeIapRejection(res, body) ?? `HTTP ${res.status}: ${body || res.statusText}`,
      );
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(
        `timeout after ${opts.timeoutMs / 1000}s (override with CAELO_MCP_TIMEOUT_MS)`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * #1375 — the admin is at capacity and did not run the call. Its body says
 * so for the agent (wait, then send the same call again unchanged); the
 * `Retry-After` header carries the wait when the body is not ours (a proxy
 * in front of the admin answered).
 */
async function busyMessage(res: Response): Promise<string> {
  const retryAfter = res.headers.get("retry-after");
  const text = await safeText(res);
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.length > 0) return parsed.message;
  } catch {
    // Not the admin's JSON body: fall through to the header.
  }
  const wait = retryAfter && /^\d+$/.test(retryAfter) ? `${retryAfter} s` : "a few seconds";
  return `Caelo is at capacity right now (HTTP 429), so this call was not run. Wait ${wait}, then send the same call again unchanged.`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
