// SPDX-License-Identifier: MPL-2.0

/**
 * HTTP bridge — translates a `caelo_chat` MCP call into a single POST
 * against the admin install's `/api/mcp/chat` endpoint. The endpoint
 * dispatches `mcp.send_chat` (system-only op) which resolves the
 * bearer to a Caelo actor and drives `runChatTurn`.
 *
 * 30-second client-side timeout — chat-runner turns longer than that
 * are likely stuck (the runner has its own provider-call timeouts).
 * MCP clients see a clean error instead of a hung connection.
 */

export interface SendChatOpts {
  readonly adminUrl: string;
  readonly token: string;
  readonly message: string;
  readonly chatSessionId?: string;
  readonly pageId?: string;
}

export interface SendChatResult {
  readonly chatSessionId: string;
  readonly requestId: string;
  readonly assistant: string;
  readonly toolCalls: ReadonlyArray<{ name: string; summary: string; succeeded: boolean }>;
  readonly pendingProposals: number;
  readonly costMicrocents: number;
}

const TIMEOUT_MS = 30_000;

export async function sendChat(opts: SendChatOpts): Promise<SendChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${opts.adminUrl.replace(/\/+$/, "")}/api/mcp/chat`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-caelo-mcp-token": opts.token,
      },
      body: JSON.stringify({
        message: opts.message,
        chatSessionId: opts.chatSessionId,
        pageId: opts.pageId,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
    }
    const json = (await res.json()) as SendChatResult;
    return json;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`timeout after ${TIMEOUT_MS / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
