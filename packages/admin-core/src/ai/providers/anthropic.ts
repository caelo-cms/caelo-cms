// SPDX-License-Identifier: MPL-2.0

/**
 * Anthropic provider — v0.3.0+ uses the Vercel AI SDK
 * (`@ai-sdk/anthropic` + `ai`'s `streamText`) instead of a hand-rolled
 * fetch + SSE parser. Same public shape (`AnthropicProvider`
 * implements `AIProvider`); chat-runner doesn't notice the swap.
 *
 * What's Anthropic-specific in this file (vs. the shared SDK code in
 * `_sdk-shared.ts`):
 *   - The `cacheControl` system-prompt encoding for ephemeral
 *     prompt-cache breakpoints — only Anthropic supports per-message
 *     cache control through `providerOptions.anthropic.cacheControl`.
 *   - The `thinking` body parameter for extended thinking — only
 *     Anthropic supports the `{type:"enabled", budgetTokens}` shape.
 *   - The `createAnthropic` factory + `_modelOverride` test hook.
 *
 * What we DON'T use from the SDK: the auto-tool-loop. Caelo's
 * chat-runner manages snapshot emission, audit, cost cap, subagent
 * spawning, allowlist narrowing — all between provider calls. We
 * hand the SDK the tool catalog (so the API request includes it
 * correctly) but never provide `execute` callbacks; the SDK emits
 * `tool-call` events and yields control to chat-runner.
 *
 * Provider-brand strings stay scoped to this file + the registry
 * factory; chat-runner sees only the abstract `ProviderEvent` union
 * (CLAUDE.md §4).
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { anthropic as anthropicGlobal, createAnthropic } from "@ai-sdk/anthropic";
import type { ModelMessage, SystemModelMessage } from "ai";

import type {
  AIProvider,
  ChatMessageInput,
  GenerateInput,
  GenerateObjectInput,
  GenerateObjectResult,
  ProviderEvent,
  ProviderName,
} from "../provider.js";
import { runSDKGenerateObject, runSDKStream, toSDKMessages } from "./_sdk-shared.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * Debug wire tap. When `CAELO_DEBUG_AI_WIRE=1`, every provider call
 * appends its FULL outgoing request (system prompt + messages + the
 * loaded/deferred tool split) and the raw incoming response (thinking +
 * text + tool calls with args + stop reason) to the file named by
 * `CAELO_AI_WIRE_LOG` (default `ai-wire.log` in the cwd). Zero cost when
 * the flag is unset — the tap is skipped entirely. Never enable in
 * production: prompts + tool args are written verbatim in the clear.
 */
function wirePath(): string | null {
  if (process.env.CAELO_DEBUG_AI_WIRE !== "1") return null;
  return process.env.CAELO_AI_WIRE_LOG ?? "ai-wire.log";
}

/**
 * Raw-wire fetch interceptor. When the wire tap is on, wraps `fetch` so
 * the COMPLETE HTTP request body sent to Anthropic and the COMPLETE
 * response body received are written verbatim (1:1, no reconstruction)
 * to a `<wireLog>.raw.jsonl` sidecar — one JSON object per line:
 * `{dir:"request", ...body}` then `{dir:"response", status, ...body}`.
 * This is the actual provider payload (system array with cache_control,
 * provider tools with defer_loading, etc.), NOT the human-readable
 * reconstruction dumpWireRequest emits. Streaming responses are teed so
 * the SDK still consumes the stream; the raw SSE text is captured
 * alongside. Same production caveat as the tap: never enable live.
 */
function makeWireFetch(rawPath: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const stamp = new Date().toISOString();
    if (init?.body && typeof init.body === "string") {
      try {
        appendFileSync(
          rawPath,
          `${JSON.stringify({ dir: "request", stamp, body: JSON.parse(init.body) })}\n`,
        );
      } catch {
        appendFileSync(
          rawPath,
          `${JSON.stringify({ dir: "request", stamp, rawBody: init.body })}\n`,
        );
      }
    }
    const res = await fetch(input as RequestInfo, init);
    const ct = res.headers.get("content-type") ?? "";
    // Non-streaming JSON: read the clone body directly. Streaming SSE:
    // tee the stream, capture one branch as text, hand the other back.
    if (ct.includes("application/json")) {
      const text = await res.clone().text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
      appendFileSync(
        rawPath,
        `${JSON.stringify({ dir: "response", stamp, status: res.status, body: parsed })}\n`,
      );
      return res;
    }
    if (res.body) {
      const [a, b] = res.body.tee();
      void (async () => {
        try {
          const chunks: string[] = [];
          const reader = a.getReader();
          const dec = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(dec.decode(value, { stream: true }));
          }
          appendFileSync(
            rawPath,
            `${JSON.stringify({ dir: "response", stamp, status: res.status, sse: chunks.join("") })}\n`,
          );
        } catch {
          /* best-effort capture */
        }
      })();
      return new Response(b, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }
    return res;
  }) as typeof fetch;
}

function dumpWireRequest(path: string, model: string, input: GenerateInput): void {
  const stamp = new Date().toISOString();
  const sys =
    typeof input.systemPrompt === "string"
      ? input.systemPrompt
      : input.systemPrompt
          .map(
            (c) =>
              `--- chunk [${c.label ?? "?"}]${c.cacheable ? " (cacheable)" : ""} ---\n${c.body}`,
          )
          .join("\n");
  const loaded = input.tools.filter((t) => t.alwaysLoaded).map((t) => t.name);
  const deferred = input.tools.filter((t) => !t.alwaysLoaded).map((t) => t.name);
  const lines = [
    `\n\n=================== >>> REQUEST ${stamp}  model=${model} ===================`,
    `----- SYSTEM PROMPT (${sys.length} chars) -----`,
    sys,
    `----- MESSAGES (${input.messages.length}) -----`,
    ...input.messages.map((m, i) => {
      const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      // Tool-only assistant turns used to render as a bare `[assistant]`
      // line (the dump printed only text content), leaving the [tool]
      // results below visually orphaned. Emit the RAW wire-shape JSON of
      // every tool_use block instead — no summarising, no truncation —
      // and stamp tool results with the toolCallId they answer, so
      // call ↔ result pairs are matchable by id alone.
      const callLines = [
        ...(m.serverToolCalls ?? []).map(
          (c) =>
            `\n[assistant.server_tool_use] ${JSON.stringify({ id: c.id, name: c.name, input: c.arguments, result: c.result })}`,
        ),
        ...(m.toolCalls ?? []).map(
          (c) =>
            `\n[assistant.tool_use] ${JSON.stringify({ id: c.id, name: c.name, input: c.arguments })}`,
        ),
      ].join("");
      const roleLabel = m.role === "tool" && m.toolCallId ? `tool_result ${m.toolCallId}` : m.role;
      // 2026-07 (run B4 forensics) — screenshots are ephemeral, so a
      // doubted capture was unauditable. Save every image part as a
      // sidecar file next to the wire log and reference it inline.
      let imageNote = "";
      for (const [j, part] of (m.additionalContent ?? []).entries()) {
        if (part.type !== "image") continue;
        const ext = part.mediaType === "image/png" ? "png" : "jpg";
        const file = `${path}.msg${i}-img${j}.${ext}`;
        try {
          writeFileSync(file, Buffer.from(part.base64, "base64"));
          imageNote += ` [image saved: ${file} (${Math.round((part.base64.length * 3) / 4 / 1024)} kB)]`;
        } catch {
          imageNote += ` [image: ${Math.round((part.base64.length * 3) / 4 / 1024)} kB — sidecar write failed]`;
        }
      }
      return `[${roleLabel}] ${body}${imageNote}${callLines}`;
    }),
    `----- TOOLS (${input.tools.length}): ${loaded.length} loaded, ${deferred.length} deferred -----`,
    `loaded:   ${loaded.join(", ")}`,
    `deferred: ${deferred.join(", ")}`,
  ];
  appendFileSync(path, `${lines.join("\n")}\n`);
}

function dumpWireResponse(
  path: string,
  parts: {
    thinking: string;
    text: string;
    calls: { name: string; args: unknown }[];
    stop: string;
    elapsedMs: number;
  },
): void {
  const stamp = new Date().toISOString();
  const lines = [
    `----- RESPONSE ${stamp} stop=${parts.stop} elapsed=${(parts.elapsedMs / 1000).toFixed(1)}s -----`,
  ];
  if (parts.thinking) lines.push(`[thinking] ${parts.thinking}`);
  if (parts.text) lines.push(`[text] ${parts.text}`);
  for (const c of parts.calls) lines.push(`[tool-call] ${c.name}(${JSON.stringify(c.args)})`);
  appendFileSync(path, `${lines.join("\n")}\n`);
}

/**
 * v0.6.0 W2 — Anthropic Tool Search. When `toolSearch` is set to a
 * non-"off" value, the provider tags every caelo tool with
 * `providerOptions.anthropic.deferLoading: true` and injects the
 * matching `anthropic.tools.toolSearchBm25_20251119()` (or regex
 * variant) as a discovery surface. Claude calls the search tool
 * server-side, the SDK loads the matching deferred tools into
 * context, and Claude then emits a regular tool_use block — which
 * caelo's chat-runner handles via its existing ToolRegistry path.
 *
 * Anthropic released this with Opus 4.5 / Sonnet 4.5 (Nov 2025); newer
 * models inherit the capability. ON by default (`bm25`) since the
 * catalogue crossed 100 tools — the operator can opt out (or switch
 * algorithm) via `CAELO_ANTHROPIC_TOOL_SEARCH={off|bm25|regex}`.
 * Core workflow tools stay fully loaded (see tools/core-tools.ts);
 * only the long tail defers behind the search surface.
 */
export type AnthropicToolSearchMode = "off" | "bm25" | "regex";

interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  /**
   * v0.6.0 W2 — server-side Tool Search drops per-turn tool-description
   * tokens for the deferred long tail. Defaults to `bm25` via
   * `resolveAnthropicToolSearchMode`; opt out (or switch algorithm) with
   * the `CAELO_ANTHROPIC_TOOL_SEARCH={off|bm25|regex}` env var.
   */
  readonly toolSearch?: AnthropicToolSearchMode;
  /**
   * Test hook — pre-resolved LanguageModel instance. When set, the
   * SDK's Anthropic-provider lookup is skipped and `streamText` runs
   * against this model directly. Production code never passes this.
   */
  readonly _modelOverride?: import("ai").LanguageModel;
}

/**
 * Anthropic rejects requests carrying more than 4 `cache_control`
 * breakpoints. A breakpoint caches the ENTIRE prefix before it, so when
 * the composer emits more cacheable chunks than the limit, tagging only
 * the LAST 4 loses nothing: the untagged leading chunks are still
 * inside every later breakpoint's cached prefix — they just stop being
 * standalone fallback prefixes of their own.
 */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * The 4-breakpoint budget, split per Anthropic's documented tool-search +
 * caching pattern (docs: "Tool use with prompt caching"):
 *   - 1 TOOL breakpoint on the last non-deferred tool (see the tools
 *     transform) — caches the tool-definitions prefix as its own entry, so
 *     it survives changes to the system tail. `defer_loading` tools cannot
 *     carry `cache_control` (400), so it MUST land on a non-deferred tool.
 *   - 2 SYSTEM breakpoints on the last cacheable system chunks — keeps the
 *     stable head cached even when skills/chips at the system tail change
 *     across turns.
 *   - 1 CONVERSATION breakpoint rolling on the last message — caches the
 *     growing message history so each call pays full price only for the
 *     newest content.
 * Discovered (deferred) tools load as `tool_reference` blocks in the
 * MESSAGES, leaving the tools/system prefix untouched — so tool search
 * does not invalidate these caches (verified at the wire level).
 */
const TOOL_CACHE_BREAKPOINTS = 1;
const CONVERSATION_CACHE_BREAKPOINTS = 1;
const SYSTEM_CACHE_BREAKPOINTS =
  MAX_CACHE_BREAKPOINTS - TOOL_CACHE_BREAKPOINTS - CONVERSATION_CACHE_BREAKPOINTS;

/** Ephemeral cache_control provider option, merged onto existing keys. */
function withCacheControl<T extends { providerOptions?: Record<string, unknown> }>(o: T): T {
  const existing = o.providerOptions;
  return {
    ...o,
    providerOptions: {
      ...(existing ?? {}),
      anthropic: {
        ...((existing?.anthropic as Record<string, unknown> | undefined) ?? {}),
        cacheControl: { type: "ephemeral" },
      },
    },
  };
}

/**
 * Roll a cache breakpoint onto the LAST message so Anthropic caches the
 * whole conversation prefix (tools + system + every prior turn); the next
 * provider call reads it from cache and pays full price only for the
 * newest content.
 *
 * The breakpoint goes on the last CONTENT PART, not the message. The AI
 * SDK's Anthropic conversion checks a part's own `cacheControl`
 * UNCONDITIONALLY but only applies a MESSAGE-level `cacheControl` to the
 * part when it is `isLastPart` — and empirically that message-level
 * fallback is dropped when the last message ends in multiple `tool_result`
 * parts (parallel tool calls). Since our loops fan out tool calls
 * constantly, a message-level breakpoint silently vanished on those turns,
 * so the growing conversation went UNCACHED and every following call
 * re-read only the tools+system prefix (wire-verified). Part-level is
 * reliable regardless of block count. No-op for non-Anthropic providers.
 */
function tagConversationForCache(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const out = [...messages];
  const lastIdx = out.length - 1;
  const last = out[lastIdx];
  if (!last) return messages;
  if (Array.isArray(last.content) && last.content.length > 0) {
    const parts = [...last.content];
    const lp = parts.length - 1;
    parts[lp] = withCacheControl(
      parts[lp] as { providerOptions?: Record<string, unknown> },
    ) as (typeof parts)[number];
    out[lastIdx] = { ...last, content: parts } as ModelMessage;
  } else {
    // String content (a plain user text message) — no parts to tag, so the
    // message-level breakpoint is correct and reliable here.
    out[lastIdx] = withCacheControl(
      last as ModelMessage & { providerOptions?: Record<string, unknown> },
    ) as ModelMessage;
  }
  return out;
}

/**
 * System prompt → SDK system shape. The SDK accepts a string OR
 * (via the messages array) `SystemModelMessage` entries with
 * per-part `providerOptions.anthropic.cacheControl` — that's how we
 * keep the cache prefix warm across turns when chips/skills change
 * at the tail (P5.2 #4 / v0.2.x). The last conversation message also gets a
 * rolling breakpoint so the growing history caches incrementally.
 */
function buildSystemAndMessages(
  prompt: GenerateInput["systemPrompt"],
  cacheBreakpoints: GenerateInput["cacheBreakpoints"],
  inputMessages: readonly ChatMessageInput[],
): { system?: string; messages: ModelMessage[] } {
  const userMessages = tagConversationForCache(toSDKMessages(inputMessages));
  if (typeof prompt === "string") {
    if (cacheBreakpoints?.includes("system")) {
      const sysMsg: SystemModelMessage = {
        role: "system",
        content: prompt,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      };
      return { messages: [sysMsg, ...userMessages] };
    }
    return { system: prompt, messages: userMessages };
  }
  // Chunked prompt — each cacheable chunk gets its own SystemModelMessage
  // with anthropic.cacheControl, capped at SYSTEM_CACHE_BREAKPOINTS so the
  // rolling message breakpoint fits inside the API's 4-breakpoint limit.
  const cacheableIndices = prompt.flatMap((c, i) => (c.cacheable ? [i] : []));
  const tagged = new Set(cacheableIndices.slice(-SYSTEM_CACHE_BREAKPOINTS));
  const sysMessages: SystemModelMessage[] = prompt.map((c, i) => ({
    role: "system",
    content: c.body,
    ...(tagged.has(i)
      ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
      : {}),
  }));
  return { messages: [...sysMessages, ...userMessages] };
}

/**
 * Claude 4.6+ models (Sonnet 5, Opus 4.6/4.7/4.8, Fable, Mythos) drop
 * the pre-4.6 sampling/thinking knobs: they reject `budget_tokens` AND
 * `temperature` with a 400 and take adaptive thinking instead. Older
 * models still accept both. Centralised here so every param that these
 * models deprecate is gated on ONE predicate.
 */
export function isAdaptiveModel(model: string): boolean {
  return /sonnet-5|opus-4-7|opus-4-8|opus-4-6|sonnet-4-6|fable|mythos/.test(model);
}

/**
 * Maps Caelo's provider-neutral thinking request onto the shape the
 * target Anthropic model accepts (see {@link isAdaptiveModel}).
 */
export function resolveThinkingOption(
  model: string,
  budgetTokens: number,
): { type: "adaptive" } | { type: "enabled"; budgetTokens: number } {
  return isAdaptiveModel(model) ? { type: "adaptive" } : { type: "enabled", budgetTokens };
}

export class AnthropicProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model: string;
  readonly #model: import("ai").LanguageModel;
  readonly #toolSearch: AnthropicToolSearchMode;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.#toolSearch = options.toolSearch ?? "off";
    if (options._modelOverride) {
      this.#model = options._modelOverride;
      return;
    }
    // Raw-wire capture: when the tap is on, inject a fetch that writes
    // the verbatim request + response bodies to <wireLog>.raw.jsonl.
    const wire = wirePath();
    const provider = createAnthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl && options.baseUrl !== DEFAULT_BASE_URL
        ? { baseURL: options.baseUrl }
        : {}),
      ...(wire ? { fetch: makeWireFetch(`${wire}.raw.jsonl`) } : {}),
    });
    // Cast through `string` for forward-compat with new model ids.
    this.#model = provider(options.model as Parameters<typeof provider>[0]);
  }

  async *generate(input: GenerateInput): AsyncIterable<ProviderEvent> {
    const systemAndMessages = buildSystemAndMessages(
      input.systemPrompt,
      input.cacheBreakpoints,
      input.messages,
    );
    // v0.2.54 — extended thinking. Anthropic-specific provider
    // option; OpenAI/Gemini don't have an equivalent body param.
    const extraOptions: Record<string, unknown> = {};
    if (input.thinking) {
      extraOptions.providerOptions = {
        anthropic: {
          thinking: resolveThinkingOption(this.model, input.thinking.budgetTokens),
        },
      };
    }
    // v0.6.0 W2 — Tool Search transform. Skip when (a) operator hasn't
    // opted in, OR (b) catalogue is below the threshold where Tool
    // Search wins (small catalogues lose more on the search-tool
    // overhead than they gain on description token reduction).
    // Threshold defaults to 10; tunable via
    // CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD env so deployments with
    // catalog growth or shrinkage can adjust without a code change.
    const thresholdRaw = process.env.CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD;
    const threshold =
      thresholdRaw && Number.isFinite(Number(thresholdRaw))
        ? Math.max(1, Number(thresholdRaw))
        : 10;
    const useToolSearch = this.#toolSearch !== "off" && input.tools.length >= threshold;
    // Core workflow tools (ToolDefinition.alwaysLoaded, set from
    // CORE_TOOL_NAMES) keep their full definition in every request so a
    // routine edit never needs a discovery round-trip; only the long
    // tail defers behind the search tool.
    const alwaysLoadedNames = new Set(input.tools.filter((t) => t.alwaysLoaded).map((t) => t.name));
    if (this.#toolSearch !== "off" && process.env.CAELO_DEBUG_TOOL_SEARCH === "1") {
      // Telemetry: log whether the transform engaged this turn AND the
      // loaded-vs-deferred split, so the operator can confirm BM25 fired
      // (and that the core set stayed loaded) without tracing the
      // wire-level Anthropic request.
      console.log("[anthropic.toolSearch]", {
        mode: this.#toolSearch,
        toolCount: input.tools.length,
        threshold,
        engaged: useToolSearch,
        alwaysLoaded: alwaysLoadedNames.size,
        deferred: useToolSearch ? input.tools.length - alwaysLoadedNames.size : 0,
        alwaysLoadedNames: [...alwaysLoadedNames].sort(),
      });
    }
    const toolsTransform = useToolSearch
      ? (built: Record<string, unknown>): Record<string, unknown> => {
          // Mark every non-core caelo tool as deferred so its
          // description does NOT ship in the first request body —
          // Claude calls the search tool to discover it.
          let lastCoreName: string | undefined;
          for (const [name, def] of Object.entries(built)) {
            if (alwaysLoadedNames.has(name)) {
              // Non-deferred (core) tool — track the last one so the tool
              // cache breakpoint lands on it below.
              lastCoreName = name;
              continue;
            }
            if (def && typeof def === "object") {
              const existing = (def as { providerOptions?: Record<string, unknown> })
                .providerOptions;
              (def as { providerOptions?: Record<string, unknown> }).providerOptions = {
                ...(existing ?? {}),
                anthropic: {
                  ...((existing?.anthropic as Record<string, unknown> | undefined) ?? {}),
                  deferLoading: true,
                },
              };
            }
          }
          // TOOL cache breakpoint (Anthropic docs: "put the cache breakpoint
          // on a non-deferred tool"). On the LAST core tool so the whole
          // core-tool prefix caches as its own entry — surviving system-tail
          // changes, and never on a deferred tool (400). Skipped only if,
          // implausibly, no core tool exists (then the system breakpoint
          // still caches the tools via its prefix).
          if (lastCoreName) {
            const def = built[lastCoreName] as
              | { providerOptions?: Record<string, unknown> }
              | undefined;
            if (def && typeof def === "object") {
              const existing = def.providerOptions;
              def.providerOptions = {
                ...(existing ?? {}),
                anthropic: {
                  ...((existing?.anthropic as Record<string, unknown> | undefined) ?? {}),
                  cacheControl: { type: "ephemeral" },
                },
              };
            }
          }
          // Inject the search tool. Two algorithms: BM25 (natural-
          // language scoring — default; better when descriptions are
          // prose-y) and regex (exact-pattern; better when tools share
          // a strict naming convention).
          //
          // The dict KEY must be the tool's CANONICAL wire name
          // (`tool_search_tool_bm25` / `tool_search_tool_regex` — the
          // adapter hardcodes that `name` on the request regardless of
          // key). Under the old alias key `toolSearch`, incoming events
          // and replayed history carried "toolSearch" while the wire
          // knew only the canonical name — so when the model imitated
          // the alias from history, Anthropic treated it as a CLIENT
          // tool and our dispatcher failed it with `unknown tool:
          // toolSearch` (live-edit run B3). Matching names end the class.
          const searchTool =
            this.#toolSearch === "regex"
              ? anthropicGlobal.tools.toolSearchRegex_20251119()
              : anthropicGlobal.tools.toolSearchBm25_20251119();
          const searchToolName =
            this.#toolSearch === "regex" ? "tool_search_tool_regex" : "tool_search_tool_bm25";
          return { ...built, [searchToolName]: searchTool };
        }
      : undefined;
    // Claude 4.6+ models reject `temperature` with a 400 ("temperature
    // is deprecated for this model") — the request dies before the model
    // runs. Strip it for the adaptive class so a caller-supplied
    // temperature (e.g. the e2e harness's CAELO_CHAT_TEMPERATURE=0, or an
    // operator sampling setting) can't 400 the whole turn. Older Anthropic
    // models keep it.
    const effectiveInput =
      input.temperature !== undefined && isAdaptiveModel(this.model)
        ? { ...input, temperature: undefined }
        : input;
    const stream = runSDKStream({
      model: this.#model,
      input: effectiveInput,
      systemAndMessages,
      extraOptions,
      ...(toolsTransform ? { toolsTransform } : {}),
    });
    const wire = wirePath();
    if (!wire) {
      yield* stream;
      return;
    }
    // Wire tap: dump the outgoing request, then accumulate the streamed
    // response so it can be dumped alongside on the terminal `done`.
    dumpWireRequest(wire, this.model, input);
    const startedAt = Date.now();
    let text = "";
    let thinking = "";
    const calls: { name: string; args: unknown }[] = [];
    for await (const ev of stream) {
      if (ev.kind === "text-delta") text += ev.text;
      else if (ev.kind === "thinking-delta") thinking += ev.text;
      else if (ev.kind === "tool-call") calls.push({ name: ev.name, args: ev.arguments });
      else if (ev.kind === "server-tool-call")
        calls.push({ name: `[server] ${ev.name}`, args: ev.arguments });
      else if (ev.kind === "done")
        dumpWireResponse(wire, {
          thinking,
          text,
          calls,
          stop: ev.stopReason,
          elapsedMs: Date.now() - startedAt,
        });
      yield ev;
    }
  }

  async generateObject(input: GenerateObjectInput): Promise<GenerateObjectResult> {
    // Claude 4.6+ reject `temperature` with a 400 (see isAdaptiveModel).
    // moduleize passes temperature:0, so strip it for the adaptive class
    // exactly as `generate` does — otherwise the structured call 400s.
    const temperature =
      input.temperature !== undefined && isAdaptiveModel(this.model)
        ? undefined
        : input.temperature;
    return runSDKGenerateObject({
      model: this.#model,
      modelId: this.model,
      systemAndMessages: buildSystemAndMessages(input.systemPrompt, undefined, input.messages),
      rawJsonSchema: input.jsonSchema,
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
  }
}

/**
 * Fixture-driven provider for tests. Replays a pre-recorded ProviderEvent
 * stream so PR CI can exercise the chat / tool-dispatch path without
 * hitting the live API. Real-provider tests (gated behind `bun run
 * test:live`) use AnthropicProvider directly.
 */
export class FixtureProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";
  readonly model: string;
  readonly #events: readonly ProviderEvent[];

  constructor(events: readonly ProviderEvent[], model = "claude-opus-4-7") {
    this.#events = events;
    this.model = model;
  }

  async *generate(_input: GenerateInput): AsyncIterable<ProviderEvent> {
    for (const e of this.#events) yield e;
  }

  // FixtureProvider scripts the streaming (generate) path only. Tests that
  // need structured output script their own generateObject (see
  // moduleize.test.ts) — fail loud if this stub is reached (CLAUDE.md §2).
  async generateObject(_input: GenerateObjectInput): Promise<GenerateObjectResult> {
    throw new Error("FixtureProvider.generateObject is not scripted — use a structured fixture");
  }
}

/**
 * Multi-loop fixture for tool-use → continuation flows. The chat runner
 * calls `generate()` once per loop iteration: first call returns the
 * queue's first sub-array (typically ending in stopReason `tool_use`),
 * second call returns the continuation after the tool result lands. Past
 * the queue, returns a single end_turn event so the runner exits cleanly.
 */
export class MultiFixtureProvider extends FixtureProvider {
  readonly #queue: readonly (readonly ProviderEvent[])[];
  #idx = 0;

  constructor(queue: readonly (readonly ProviderEvent[])[], model = "claude-opus-4-7") {
    super([], model);
    this.#queue = queue;
  }

  override async *generate(_input: GenerateInput): AsyncIterable<ProviderEvent> {
    const events = this.#queue[this.#idx] ?? [
      { kind: "done", stopReason: "end_turn" } as ProviderEvent,
    ];
    this.#idx += 1;
    for (const e of events) yield e;
  }
}
