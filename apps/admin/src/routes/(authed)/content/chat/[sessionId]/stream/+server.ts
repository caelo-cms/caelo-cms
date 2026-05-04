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
 *   2. The configured Anthropic adapter with ANTHROPIC_API_KEY.
 */

import { resolveTestProvider, runChatTurn } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

const AI_ACTOR_ID = "00000000-0000-0000-0000-000000000a1a";
const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
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
  const testProviderName = request.headers.get(TEST_PROVIDER_HEADER);
  if (testProviderName) {
    aiProvider = resolveTestProvider(testProviderName);
    if (!aiProvider) {
      throw error(400, `unknown test provider: ${testProviderName}`);
    }
  }

  if (!aiProvider) {
    const apiKey = process.env[ANTHROPIC_API_KEY_ENV];
    if (!apiKey) {
      return new Response(
        `data: ${JSON.stringify({
          kind: "error",
          message: `${ANTHROPIC_API_KEY_ENV} not set`,
        })}\n\ndata: ${JSON.stringify({ kind: "done" })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    const providersResult = await execute(registry, adapter, locals.ctx, "ai_providers.list", {});
    const provider = providersResult.ok
      ? (
          providersResult.value as {
            providers: { name: string; config: Record<string, unknown> }[];
          }
        ).providers.find((p) => p.name === "anthropic")
      : undefined;
    const model =
      (provider?.config && typeof provider.config.model === "string"
        ? (provider.config.model as string)
        : null) ?? "claude-opus-4-7";

    const { makeProvider } = await import("@caelo-cms/admin-core");
    aiProvider = makeProvider({ name: "anthropic", apiKey, model });
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
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
        }
      } catch (e) {
        if (!abortSignal.aborted) {
          const message = e instanceof Error ? e.message : String(e);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ kind: "error", message })}\n\n`),
          );
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind: "done" })}\n\n`));
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
};
