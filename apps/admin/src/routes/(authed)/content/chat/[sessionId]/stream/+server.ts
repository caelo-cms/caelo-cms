// SPDX-License-Identifier: MPL-2.0

/**
 * SSE endpoint for the editor chat. Body is JSON
 *   { content: string, chips: [...] }
 * Response is a text/event-stream of `data: <json>` lines per ClientEvent.
 *
 * Provider brand never appears in event payloads — the runner emits
 * abstract events (text-delta, tool-start, tool-result, …).
 *
 * Provider selection (in order):
 *   1. Header `x-caelo-test-provider: <name>` resolves a fixture from
 *      the in-memory test registry (Playwright). The registry is
 *      hard-disabled when NODE_ENV='production', so a deployed instance
 *      cannot be coerced into using a fake AI by setting the header.
 *   2. ProviderResolver (`getActiveProvider()`) — reads the active row
 *      in `ai_providers`, decrypts the stored key, falls back to the
 *      legacy `process.env[envNameFor(name)]` when no DB key is set.
 *   3. null → emits SSE error pointing the Owner at /security/ai.
 */

import { getActiveProvider, resolveTestProvider, runChatTurn } from "@caelo-cms/admin-core";
import { error } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

const AI_ACTOR_ID = "00000000-0000-0000-0000-000000000a1a";
const TEST_PROVIDER_HEADER = "x-caelo-test-provider";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  requirePermission(locals, "content.read");

  // Lightweight CSRF check via a dedicated header (the body is JSON, not
  // form-encoded, so the existing assertCsrfToken helper doesn't apply).
  const csrf = request.headers.get("x-csrf-token") ?? "";
  if (!locals.user) throw error(401, "Not authenticated");
  const { verifyCsrfToken } = await import("@caelo-cms/admin-core");
  if (!(await verifyCsrfToken(locals.user.csrfSecret, csrf))) {
    throw error(403, "CSRF token mismatch");
  }

  const body = (await request.json()) as {
    content: string;
    chips?: unknown[];
    activePageId?: string;
  };
  const { adapter, registry } = getQueryContext();

  let aiProvider: import("@caelo-cms/admin-core").AIProvider | null = null;
  // v0.2.53 — Per-provider output ceiling, sourced from
  // `ai_providers.config.maxOutputTokens`. Threads to runChatTurn which
  // hands it to provider.generate. undefined = chat-runner default.
  let maxOutputTokens: number | undefined;
  // Test-only temperature pin (e2e-livedit). Sourced from the resolver
  // which only honours it under NODE_ENV != production; production
  // callers see undefined and the chat-runner skips the field.
  let temperature: number | undefined;
  const testProviderName = request.headers.get(TEST_PROVIDER_HEADER);
  if (testProviderName) {
    aiProvider = resolveTestProvider(testProviderName);
    if (!aiProvider) {
      throw error(400, `unknown test provider: ${testProviderName}`);
    }
  }

  if (!aiProvider) {
    const resolved = await getActiveProvider();
    if (!resolved) {
      return new Response(
        `data: ${JSON.stringify({
          kind: "error",
          message: "AI provider not configured — visit /security/ai to set up an API key.",
        })}\n\ndata: ${JSON.stringify({ kind: "done" })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    aiProvider = resolved.provider;
    maxOutputTokens = resolved.maxOutputTokens;
    temperature = resolved.temperature;
  }
  const { createDefaultToolRegistry } = await import("@caelo-cms/admin-core");
  const tools = createDefaultToolRegistry();

  const aiCtx = {
    actorId: AI_ACTOR_ID,
    actorKind: "ai" as const,
    requestId: `chat-${params.sessionId}`,
  };

  // P5.2 #2: pipe the request abort signal into runChatTurn so closing
  // the browser tab mid-stream stops the loop and marks the in-flight
  // assistant message as 'interrupted'.
  const abortSignal = request.signal;
  // v0.2.58 — Forensics: track when the connection aborts + how many
  // events made it to the client before the connection closed. The
  // user reported "AI stops mid-plan with no error in the chat" — the
  // runner enters but the [chat-runner] loop log never fires, just an
  // AbortError. With this tracking we can tell whether the abort
  // came at byte 0 (proxy-side termination) or after N events (user
  // / browser closed the tab).
  const startedAt = Date.now();
  let lastEventKind: string | null = null;
  let eventsEnqueued = 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      // v0.2.59 — periodic SSE keep-alive. The Anthropic stream has
      // natural idle pauses (1-3s between content blocks; sometimes
      // longer between final text and the first tool_use). Without
      // bytes flowing, GCLB / IAP / Cloud Run treat the HTTP/2 stream
      // as idle and close it at ~14s (operator's reproducible
      // elapsedMs across multiple traces). The standard fix: write
      // a `:keepalive\n\n` SSE comment every 3s. Comments are part
      // of the SSE spec — clients ignore them, but the bytes flush
      // through proxies and reset their idle timers. Cleared when
      // the stream finishes via the finally block.
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // Stream torn down; the finally below will clear this
          // interval, so we don't accumulate dead writers.
        }
      }, 3000);
      // v0.5.20 — heartbeat event. Distinct from the SSE comment above
      // because comments don't reach the client's `EventSource` event
      // handler (they're proxy-idle-timeout traversal only). The
      // ChatPanel client watchdog tracks `lastEventAtMs` from event
      // arrivals; on long multi-tool builds (5× add_module_to_page,
      // 20-30s each, no streaming text between) the watchdog fires a
      // false-positive "stream stalled" banner. A real {kind:"heartbeat"}
      // event every 30s resets the timer client-side. ChatPanel's
      // existing event handler ignores unknown kinds harmlessly + the
      // lastEventAtMs reset (v0.5.13) fires regardless.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind: "heartbeat" })}\n\n`));
        } catch {
          // Stream torn down; finally clears.
        }
      }, 30_000);
      try {
        for await (const ev of runChatTurn(
          {
            adapter,
            registry,
            provider: aiProvider,
            tools,
            aiCtx,
            humanCtx: locals.ctx,
            abortSignal,
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
          },
          {
            chatSessionId: params.sessionId,
            content: body.content,
            chips: Array.isArray(body.chips)
              ? (body.chips as { moduleId: string; selector: string; label: string }[])
              : [],
            ...(typeof body.activePageId === "string" && body.activePageId.length > 0
              ? { activePageId: body.activePageId }
              : {}),
          },
        )) {
          if (abortSignal.aborted) break;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
          lastEventKind = ev.kind;
          eventsEnqueued++;
        }
      } catch (e) {
        const elapsedMs = Date.now() - startedAt;
        // v0.2.58 — distinguish abort sources. abortSignal.aborted ===
        // true means the request was cancelled (browser closed tab,
        // navigated away, sent a new message that aborted the prior
        // fetch, or upstream proxy / IAP terminated). aborted=false
        // with an exception means the runner threw — different bug
        // class entirely.
        console.error("[chat stream] exception", {
          sessionId: params.sessionId,
          aborted: abortSignal.aborted,
          elapsedMs,
          eventsEnqueued,
          lastEventKind,
          error: e,
        });
        // v0.2.58 — ALWAYS try to emit the error to the client. The
        // pre-v0.2.58 guard `if (!abortSignal.aborted)` made sense
        // when "abort always means the user closed the tab", but in
        // practice we see aborts from upstream sources (Cloud Run,
        // IAP, GCLB, browser auto-close on tab-suspend) where the
        // operator is still looking at the page and would benefit
        // from seeing "stream interrupted at <kind> after <ms>ms".
        // The enqueue itself can throw if the stream is fully closed;
        // wrap so the catch doesn't recurse.
        const message = e instanceof Error ? e.message : String(e);
        const isAbort =
          abortSignal.aborted ||
          (e instanceof Error &&
            (e.name === "AbortError" || message.includes("connection was closed")));
        const clientPayload = isAbort
          ? {
              kind: "error" as const,
              message: `Stream interrupted after ${elapsedMs}ms / ${eventsEnqueued} events (last: ${lastEventKind ?? "—"}). Likely the browser tab, a new send, or a proxy closed the connection. If the AI was streaming, what arrived above is partial.`,
            }
          : { kind: "error" as const, message: `Server error: ${message}` };
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(clientPayload)}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind: "done" })}\n\n`));
        } catch {
          // Stream is already fully torn down — nothing we can do.
        }
      } finally {
        clearInterval(keepAlive);
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // v0.2.59 — nginx-style hint to upstream proxies (including
      // GCLB + IAP) that this response must NOT be buffered. SSE
      // requires bytes to flush as they're produced; buffering would
      // batch them and the client would see chunks land in big bursts
      // (or never, if the buffer hits a size limit before the stream
      // ends). Standard convention; harmless if the proxy doesn't
      // recognise it.
      "x-accel-buffering": "no",
    },
  });
};
