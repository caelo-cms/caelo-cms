// SPDX-License-Identifier: MPL-2.0

/**
 * SSE endpoint for the editor chat. Body is JSON
 *   { content: string, chips: [...] }
 * Response is a text/event-stream of `data: <json>` lines per ClientEvent.
 *
 * Provider brand never appears in event payloads — the runner emits
 * abstract events (text-delta, tool-start, tool-result, …).
 */

import { runChatTurn } from "@caelo/admin-core";
import { execute } from "@caelo/query-api";
import { error } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

const AI_ACTOR_ID = "00000000-0000-0000-0000-000000000a1a";
const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
/**
 * P5.1 fixture-replay mode. When CAELO_AI_FIXTURE is set to a JSONL
 * file path (one ProviderEvent per line), the SSE endpoint constructs a
 * FixtureProvider instead of hitting the live API. Lets Playwright
 * exercise chat flows end-to-end without ANTHROPIC_API_KEY.
 *
 * The fixture file may also be a JSON array of arrays (one inner array
 * per loop iteration) — used for tool-use → continuation flows. The
 * loader sniffs the first non-whitespace character to decide.
 */
const AI_FIXTURE_PATH_ENV = "CAELO_AI_FIXTURE";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  requirePermission(locals, "content.read");

  // Lightweight CSRF check via a dedicated header (the body is JSON, not
  // form-encoded, so the existing assertCsrfToken helper doesn't apply).
  const csrf = request.headers.get("x-csrf-token") ?? "";
  if (!locals.user) throw error(401, "Not authenticated");
  // verifyCsrfToken via @caelo/admin-core.
  const { verifyCsrfToken } = await import("@caelo/admin-core");
  if (!(await verifyCsrfToken(locals.user.csrfSecret, csrf))) {
    throw error(403, "CSRF token mismatch");
  }

  const body = (await request.json()) as { content: string; chips?: unknown[] };

  const { adapter, registry } = getQueryContext();

  // Provider selection:
  //   1. If CAELO_AI_FIXTURE points at a readable file, use FixtureProvider
  //      (Playwright + dev). The env var can stay set globally — only
  //      requests where the file actually exists go down the fixture path,
  //      so production deployments without the file fall through to the
  //      live adapter.
  //   2. Else use the configured Anthropic adapter with ANTHROPIC_API_KEY.
  const fixturePath = process.env[AI_FIXTURE_PATH_ENV];
  const { existsSync, readFileSync } = await import("node:fs");
  const fixtureAvailable = Boolean(fixturePath && existsSync(fixturePath));
  let aiProvider: import("@caelo/admin-core").AIProvider;
  if (fixtureAvailable && fixturePath) {
    const raw = readFileSync(fixturePath, "utf8").trim();
    const { MultiFixtureProvider, FixtureProvider } = await import("@caelo/admin-core");
    if (raw.startsWith("[")) {
      const parsed = JSON.parse(raw) as
        | import("@caelo/admin-core").ProviderEvent[]
        | import("@caelo/admin-core").ProviderEvent[][];
      // Sniff: array of arrays → multi-loop fixture; flat array → single shot.
      const isMulti = Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0]);
      aiProvider = isMulti
        ? new MultiFixtureProvider(parsed as import("@caelo/admin-core").ProviderEvent[][])
        : new FixtureProvider(parsed as import("@caelo/admin-core").ProviderEvent[]);
    } else {
      // JSONL: one ProviderEvent per line (single-shot only).
      const events = raw
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as import("@caelo/admin-core").ProviderEvent);
      aiProvider = new FixtureProvider(events);
    }
  } else {
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
      (provider?.config && typeof provider.config["model"] === "string"
        ? (provider.config["model"] as string)
        : null) ?? "claude-opus-4-7";

    const { makeProvider } = await import("@caelo/admin-core");
    aiProvider = makeProvider({ name: "anthropic", apiKey, model });
  }
  const { createDefaultToolRegistry } = await import("@caelo/admin-core");
  const tools = createDefaultToolRegistry();

  const aiCtx = {
    actorId: AI_ACTOR_ID,
    actorKind: "ai" as const,
    requestId: `chat-${params.sessionId}`,
  };

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
          },
          {
            chatSessionId: params.sessionId,
            content: body.content,
            chips: Array.isArray(body.chips)
              ? (body.chips as { moduleId: string; selector: string; label: string }[])
              : [],
          },
        )) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ kind: "error", message })}\n\n`),
        );
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind: "done" })}\n\n`));
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
