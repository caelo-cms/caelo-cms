// SPDX-License-Identifier: MPL-2.0

/**
 * One turn of a visitor conversation (#1654): `POST /api/plugin/<slug>/<op>`
 * of a declared `ai-chat` operation, answered as Server-Sent Events. Core
 * code only: the declaration comes from the plugin's signed manifest, the
 * prompt from its released configuration, and no plugin code runs.
 *
 * Request (JSON, at most {@link AI_CHAT_MAX_BODY_BYTES}):
 *
 *   { "question": "…", "lang": "de", "history": ["<turn>", …],
 *     "captcha": { "challenge": "…", "nonce": "…" } }
 *
 * `history` is the `turn` of every earlier `done`, in order; a first
 * question has none and needs the captcha: a proof of work solved for
 * `<slug>.<op>` (`GET /api/captcha/challenge`), once per conversation.
 *
 * Response: `text/event-stream`, events in this order:
 *
 *   event: delta    data: {"text":"…"}                      the answer, as it comes
 *   event: sources  data: {"sources":[{n,url,title,anchor,cited}]}
 *   event: done     data: {"usage":{inputTokens,outputTokens},"turn":"<signed>",
 *                         "conversation":{"turn":<n>,"maxTurns":<m>}}
 *   event: error    data: {"kind":"…","message":"…"}       instead of done
 *
 * A refusal before the stream starts is the same stream with one `error`
 * event and the matching HTTP status: Invalid 400, CaptchaRequired 403,
 * Forbidden 403, TooLong 413, RateLimited 429, BudgetExhausted 503,
 * Unavailable 503. `message` is for the visitor; the reason stays in the
 * log under the request id.
 *
 * Order of the gates: the cheap, memory-only ones first (origin, body,
 * shape, per-client streams), then the published settings and the key,
 * the history's signatures, the captcha, and last the ledger's reservation
 * — nothing reaches the provider before the turn's worst case is reserved.
 * No database row is written per request beyond the ledger's.
 */

import { randomBytes } from "node:crypto";
import type { AiChatOperationManifest, ConfigLeaf } from "@caelo-cms/plugin-sdk";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import {
  computeAiCallCostMicrocents,
  type PricingRow,
  promptTokenBound,
  worstCaseTextMicrocents,
} from "@caelo-cms/shared";
import { type ModelMessage, stepCountIs, streamText } from "ai";
import { z } from "zod";
import { type LedgerRefusal, releaseTurn, reserveTurn, settleTurn } from "./ledger.js";
import { systemPrompt } from "./prompt.js";
import { readVisitorAiKey, visitorAiModel } from "./provider.js";
import { loadVisitorAi, loadVisitorConfig, pricingNow } from "./published.js";
import { resolveAiChatTools } from "./route.js";
import {
  buildTools,
  type ResolvedTool,
  TOOL_CALL_MAX_BYTES,
  TOOL_RESULT_MAX_BYTES,
  type ToolRuntime,
  TurnSources,
} from "./tools.js";
import { type SignedTurn, signTurn, turnKey, verifyHistory } from "./turns.js";

/** The largest request: a full history of long answers fits, nothing more. */
export const AI_CHAT_MAX_BODY_BYTES = 256 * 1024;

/** Streams one client address may hold open on one gateway instance. */
const STREAMS_PER_CLIENT = 2;

/** A turn's deadline: the provider's time included. */
const TURN_DEADLINE_MS = 90_000;

/** Tool calls one turn may make; later ones get a refusal (and the worst case counts them). */
export const MAX_TOOL_CALLS_PER_TURN = 6;

const openStreams = new Map<string, number>();

/** What the route needs from the gateway. */
export interface AiChatContext {
  readonly adapter: DatabaseAdapter;
  readonly environment: "live" | "staging";
  readonly plugin: {
    readonly pluginId: string;
    readonly slug: string;
    readonly config: ReadonlyMap<string, ConfigLeaf["field"]>;
  };
  readonly op: AiChatOperationManifest;
  /** The declared tools, resolved to active plugins' search/read operations; null with why one is not. */
  readonly tools:
    | { readonly ok: true; readonly tools: readonly ResolvedTool[] }
    | { readonly ok: false; readonly problem: string };
  readonly runtime: ToolRuntime;
  /** The origins this environment's pages are served from (published), the only ones a turn is taken from. */
  readonly siteOrigins: readonly string[];
  readonly verifyCaptcha: (proof: {
    challenge: string;
    nonce: string;
  }) => Promise<{ ok: boolean; reason?: string }>;
  readonly clientKey: string;
  readonly requestId: string;
}

const requestBody = z
  .object({
    question: z.string().max(4000),
    lang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/),
    history: z.array(z.string().max(64_000)).max(20).default([]),
    captcha: z
      .object({ challenge: z.string().max(200), nonce: z.string().max(200) })
      .strict()
      .optional(),
  })
  .strict();

/** The error kinds a visitor's page can see. */
export type AiChatErrorKind =
  | "Invalid"
  | "CaptchaRequired"
  | "Forbidden"
  | "TooLong"
  | "RateLimited"
  | "BudgetExhausted"
  | "Unavailable";

const STATUS: Record<AiChatErrorKind, number> = {
  Invalid: 400,
  CaptchaRequired: 403,
  Forbidden: 403,
  TooLong: 413,
  RateLimited: 429,
  BudgetExhausted: 503,
  Unavailable: 503,
};

const MESSAGES: Record<AiChatErrorKind, string> = {
  Invalid: "The conversation could not be continued. Please start a new one.",
  CaptchaRequired: "Please confirm you are not a script, then ask again.",
  Forbidden: "This assistant answers on its own website only.",
  TooLong: "That is too long for this assistant.",
  RateLimited: "Too many questions at once. Please wait a moment and ask again.",
  BudgetExhausted: "The assistant has answered all it can for now. Please try again later.",
  Unavailable: "The assistant is not available right now.",
};

/** One SSE event. */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The headers of every ai-chat answer; CORS only for an allowed origin. */
function headers(origin: string | null, requestId: string): Headers {
  const h = new Headers({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    // Proxies that buffer by default stream this one (nginx, some CDNs).
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Request-Id": requestId,
  });
  if (origin !== null) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
    h.set("Cross-Origin-Resource-Policy", "cross-origin");
  }
  return h;
}

/** The allowed origin of a request, or null. */
function allowedOrigin(req: Request, siteOrigins: readonly string[]): string | null {
  const origin = req.headers.get("origin");
  return origin !== null && siteOrigins.includes(origin) ? origin : null;
}

/** A refusal: one `error` event and the matching status. */
export function aiChatRefusal(
  kind: AiChatErrorKind,
  origin: string | null,
  requestId: string,
  log?: string,
  retryAfterSec?: number,
): Response {
  if (log) console.warn(`[api-gateway] request ${requestId}: ai-chat ${kind}: ${log}`);
  const h = headers(origin, requestId);
  if (retryAfterSec !== undefined) h.set("Retry-After", String(retryAfterSec));
  return new Response(sseEvent("error", { kind, message: MESSAGES[kind] }), {
    status: STATUS[kind],
    headers: h,
  });
}

/**
 * The CORS preflight of an ai-chat operation: on gcp-firebase the widget
 * calls the gateway's own run.app origin (the Firebase rewrite buffers
 * streams), so the browser asks first. Only the site's own origins pass.
 */
export function aiChatPreflight(
  req: Request,
  siteOrigins: readonly string[],
  requestId: string,
): Response {
  const origin = allowedOrigin(req, siteOrigins);
  if (origin === null)
    return new Response(null, { status: 403, headers: { "X-Request-Id": requestId } });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
      "X-Request-Id": requestId,
    },
  });
}

function refusalOf(r: LedgerRefusal): { kind: AiChatErrorKind; log: string } {
  return { kind: r.kind, log: `ledger refused: ${r.kind} (${r.scope})` };
}

/** The messages of a verified history plus the new question. */
function messagesOf(turns: readonly SignedTurn[], question: string): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const t of turns) {
    out.push({ role: "user", content: t.q });
    out.push({ role: "assistant", content: t.a });
  }
  out.push({ role: "user", content: question });
  return out;
}

/**
 * The most a turn of up to `maxSteps` steps can cost. Step i's prompt is
 * bounded by the first request's (system, messages, tool definitions) plus
 * what earlier steps added: each step's output (at most its token ceiling,
 * plus room for refused tool calls' results) and the tool results, at most
 * {@link MAX_TOOL_CALLS_PER_TURN} of {@link TOOL_RESULT_MAX_BYTES} each.
 */
export function turnWorstCase(
  pricing: PricingRow,
  firstRequest: readonly unknown[],
  maxSteps: number,
  maxAnswerTokens: number,
): number {
  const base = promptTokenBound(...firstRequest);
  const results = MAX_TOOL_CALLS_PER_TURN * (TOOL_RESULT_MAX_BYTES + TOOL_CALL_MAX_BYTES);
  let total = 0;
  for (let i = 0; i < maxSteps; i += 1) {
    const prompt = base + i * maxAnswerTokens * 13 + (i > 0 ? results : 0);
    total +=
      worstCaseTextMicrocents(pricing, {
        promptTokens: prompt,
        maxOutputTokens: maxAnswerTokens,
      }) ?? 0;
  }
  return total;
}

/**
 * Why a conversation cannot answer now, or null: what the widget asks
 * before a visitor types, so it can say "unavailable" at once. The same
 * checks every turn makes, without the visitor's input.
 */
export async function aiChatAvailable(
  adapter: DatabaseAdapter,
  chat: { readonly pluginId: string; readonly op: AiChatOperationManifest },
): Promise<string | null> {
  if (!resolveAiChatTools(chat.op).ok) return "a tool's plugin is not active";
  const loaded = await loadVisitorAi(adapter);
  const s = loaded.settings;
  if (!s) return loaded.problem ?? "no settings";
  if (!s.enabled) return "switched off";
  if (s.keyProvider !== s.provider) return `no ${s.provider} key is stored`;
  if (!pricingNow(s)) return `${s.provider}/${s.model} is unpriced`;
  const key = await readVisitorAiKey();
  if (!key.ok) return key.problem;
  if (key.provider !== s.provider) return `the key is for ${key.provider}`;
  return null;
}

/** Answer one ai-chat request. */
export async function aiChatResponse(req: Request, c: AiChatContext): Promise<Response> {
  const origin = allowedOrigin(req, c.siteOrigins);
  // A page of another site (or none) never starts a paid turn.
  if (origin === null)
    return aiChatRefusal(
      "Forbidden",
      null,
      c.requestId,
      `origin ${req.headers.get("origin") ?? "none"}`,
    );
  if (
    (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return aiChatRefusal("Invalid", origin, c.requestId, "not JSON");
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > AI_CHAT_MAX_BODY_BYTES)
    return aiChatRefusal("TooLong", origin, c.requestId, `body ${length} bytes`);
  let text: string;
  try {
    text = await req.text();
  } catch {
    return aiChatRefusal("Invalid", origin, c.requestId, "body unreadable");
  }
  if (Buffer.byteLength(text, "utf8") > AI_CHAT_MAX_BODY_BYTES)
    return aiChatRefusal("TooLong", origin, c.requestId, "body too large");
  let body: z.infer<typeof requestBody>;
  try {
    const parsed = requestBody.safeParse(JSON.parse(text));
    if (!parsed.success)
      return aiChatRefusal("Invalid", origin, c.requestId, parsed.error.issues[0]?.message);
    body = parsed.data;
  } catch {
    return aiChatRefusal("Invalid", origin, c.requestId, "body is not JSON");
  }
  const question = body.question.trim();
  if (question === "") return aiChatRefusal("Invalid", origin, c.requestId, "empty question");

  // Published settings, the key and the plugin's configuration.
  const loaded = await loadVisitorAi(c.adapter);
  const s = loaded.settings;
  if (!s) return aiChatRefusal("Unavailable", origin, c.requestId, loaded.problem ?? "no settings");
  if (!s.enabled)
    return aiChatRefusal(
      "Unavailable",
      origin,
      c.requestId,
      "the Owner switched the visitor AI off",
    );
  if (s.keyProvider !== s.provider)
    return aiChatRefusal(
      "Unavailable",
      origin,
      c.requestId,
      `no ${s.provider} key is stored for ${c.environment}`,
    );
  const limits = {
    maxTurns: Math.min(c.op.limits.maxTurns, s.maxTurns ?? Number.POSITIVE_INFINITY),
    maxQuestionChars: Math.min(
      c.op.limits.maxQuestionChars,
      s.maxQuestionChars ?? Number.POSITIVE_INFINITY,
    ),
    maxAnswerTokens: Math.min(
      c.op.limits.maxAnswerTokens,
      s.maxAnswerTokens ?? Number.POSITIVE_INFINITY,
    ),
  };
  if (question.length > limits.maxQuestionChars)
    return aiChatRefusal(
      "TooLong",
      origin,
      c.requestId,
      `question of ${question.length} characters`,
    );
  if (body.history.length >= limits.maxTurns)
    return aiChatRefusal("TooLong", origin, c.requestId, `history of ${body.history.length} turns`);
  const pricing = pricingNow(s);
  if (!pricing)
    return aiChatRefusal(
      "Unavailable",
      origin,
      c.requestId,
      `${s.provider}/${s.model} has no ai_pricing row: a budget cannot count it`,
    );
  const key = await readVisitorAiKey();
  if (!key.ok) return aiChatRefusal("Unavailable", origin, c.requestId, key.problem);
  if (key.provider !== s.provider)
    return aiChatRefusal(
      "Unavailable",
      origin,
      c.requestId,
      `the key file is for ${key.provider}, the settings name ${s.provider}`,
    );
  if (!c.tools.ok) return aiChatRefusal("Unavailable", origin, c.requestId, c.tools.problem);
  const config = await loadVisitorConfig(c.adapter, c.plugin.pluginId);
  const system = systemPrompt(c.op.prompt.fields, c.plugin.config, config ?? {});
  if (!system.ok) return aiChatRefusal("Unavailable", origin, c.requestId, system.problem);

  // The history, then the captcha of a new conversation.
  const signing = turnKey(key.apiKey, c.environment);
  const history = verifyHistory(signing, body.history, {
    environment: c.environment,
    plugin: c.plugin.slug,
    operation: c.op.name,
  });
  if (!history.ok)
    return aiChatRefusal("Invalid", origin, c.requestId, `history ${history.problem}`);
  let conversationId: string;
  let startedAt: number;
  const first = history.turns[0];
  if (first) {
    conversationId = first.c;
    startedAt = first.t0;
  } else {
    if (!body.captcha) return aiChatRefusal("CaptchaRequired", origin, c.requestId);
    const proof = await c.verifyCaptcha(body.captcha);
    if (!proof.ok) return aiChatRefusal("CaptchaRequired", origin, c.requestId, proof.reason);
    conversationId = randomBytes(16).toString("base64url");
    startedAt = Date.now();
  }

  // Per instance, before the ledger: a client holds at most two streams.
  const open = openStreams.get(c.clientKey) ?? 0;
  if (open >= STREAMS_PER_CLIENT)
    return aiChatRefusal("RateLimited", origin, c.requestId, "client streams", 5);
  openStreams.set(c.clientKey, open + 1);
  const closeStream = () => {
    const left = (openStreams.get(c.clientKey) ?? 1) - 1;
    if (left <= 0) openStreams.delete(c.clientKey);
    else openStreams.set(c.clientKey, left);
  };

  const sources = new TurnSources();
  let toolCalls = 0;
  const tools = buildTools(c.tools.tools, c.runtime, sources, {
    lang: body.lang,
    siteOrigins: c.siteOrigins,
    mayCall: () => {
      toolCalls += 1;
      return toolCalls <= MAX_TOOL_CALLS_PER_TURN;
    },
  });
  const messages = messagesOf(history.turns, question);
  const definitions = Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
  }));
  const amount = turnWorstCase(
    pricing,
    [system.prompt, messages, definitions, c.tools.tools.map((t) => t.op)],
    c.op.maxSteps,
    limits.maxAnswerTokens,
  );
  let reserved: Awaited<ReturnType<typeof reserveTurn>>;
  try {
    reserved = await reserveTurn(c.adapter, {
      pluginId: c.plugin.pluginId,
      operation: c.op.name,
      conversationId,
      model: s.model,
      amountMicrocents: amount,
      caps: {
        dailyMicrocents: s.dailyCapMicrocents,
        monthlyMicrocents: s.monthlyCapMicrocents,
        conversationMicrocents: s.conversationCapMicrocents,
        maxConcurrent: s.maxConcurrent,
        maxTurns: limits.maxTurns,
      },
    });
  } catch (e) {
    closeStream();
    throw e;
  }
  if (!reserved.ok) {
    closeStream();
    const r = refusalOf(reserved.refused);
    return aiChatRefusal(
      r.kind,
      origin,
      c.requestId,
      r.log,
      r.kind === "RateLimited" ? 5 : undefined,
    );
  }

  const deadline = AbortSignal.any([req.signal, AbortSignal.timeout(TURN_DEADLINE_MS)]);
  const encoder = new TextEncoder();
  const ledgerId = reserved.id;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(sseEvent(event, data)));
        } catch {
          // The visitor left; the turn still settles below.
        }
      };
      let answer = "";
      let answered = false;
      let steps = 0;
      let largestPrompt = 0;
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let failure: unknown = null;
      try {
        const result = streamText({
          model: visitorAiModel(s.provider, s.model, key.apiKey),
          instructions: system.prompt,
          messages,
          tools,
          stopWhen: stepCountIs(c.op.maxSteps),
          maxOutputTokens: limits.maxAnswerTokens,
          abortSignal: deadline,
          maxRetries: 1,
        });
        for await (const part of result.fullStream) {
          // Anything the provider sent back means it may have billed.
          if (
            part.type !== "start" &&
            part.type !== "start-step" &&
            part.type !== "error" &&
            part.type !== "abort"
          )
            answered = true;
          if (part.type === "text-delta") {
            if (answer.length < 40_000) {
              answer += part.text;
              send("delta", { text: part.text });
            }
          } else if (part.type === "finish-step") {
            steps += 1;
            const u = part.usage;
            usage.input += u.inputTokens ?? 0;
            usage.output += u.outputTokens ?? 0;
            usage.cacheRead += u.inputTokenDetails?.cacheReadTokens ?? 0;
            usage.cacheWrite += u.inputTokenDetails?.cacheWriteTokens ?? 0;
            largestPrompt = Math.max(largestPrompt, u.inputTokens ?? 0);
          } else if (part.type === "error") {
            failure = part.error;
          } else if (part.type === "abort") {
            failure = new Error(part.reason ?? "aborted");
          }
        }
      } catch (e) {
        failure = e;
      }
      try {
        if (failure !== null && !answered) {
          // The provider never answered: it billed nothing.
          await releaseTurn(c.adapter, ledgerId);
        } else if (failure !== null) {
          // Part of a turn ran; what the unfinished step billed is unknown, so it
          // keeps its worst case (the reservation), never less.
          const known = cost(pricing, usage, largestPrompt);
          await settleTurn(c.adapter, ledgerId, {
            costMicrocents: Math.max(known, amount),
            inputTokens: usage.input,
            outputTokens: usage.output,
            steps,
          });
        } else {
          await settleTurn(c.adapter, ledgerId, {
            costMicrocents: cost(pricing, usage, largestPrompt),
            inputTokens: usage.input,
            outputTokens: usage.output,
            steps,
          });
        }
      } catch (e) {
        // The reservation stays: overstated, never under.
        console.error(
          `[api-gateway] request ${c.requestId}: ai-chat ledger settle failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      closeStream();
      if (failure !== null || answer.trim() === "") {
        console.warn(
          `[api-gateway] request ${c.requestId}: ai-chat turn failed: ${failure instanceof Error ? `${failure.name}: ${failure.message}` : failure === null ? "empty answer" : "error"}`,
        );
        send("error", { kind: "Unavailable", message: MESSAGES.Unavailable });
      } else {
        const final = sources.final(answer);
        send("sources", { sources: final });
        const turn = signTurn(signing, {
          v: 1,
          e: c.environment,
          p: c.plugin.slug,
          o: c.op.name,
          c: conversationId,
          n: history.turns.length,
          q: question,
          a: answer,
          s: final,
          t0: startedAt,
        });
        send("done", {
          usage: { inputTokens: usage.input, outputTokens: usage.output },
          turn,
          conversation: { turn: history.turns.length + 1, maxTurns: limits.maxTurns },
        });
      }
      try {
        controller.close();
      } catch {
        // already closed by a departed visitor
      }
    },
  });
  return new Response(stream, { status: 200, headers: headers(origin, c.requestId) });
}

function cost(
  pricing: PricingRow,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
  largestPrompt: number,
): number {
  return computeAiCallCostMicrocents(pricing, {
    operationType: "text",
    inputTokens: usage.input,
    outputTokens: usage.output,
    cachedTokens: usage.cacheRead,
    cacheCreationTokens: usage.cacheWrite,
    largestPromptTokens: largestPrompt,
    imageCount: 0,
  }).costMicrocents;
}
