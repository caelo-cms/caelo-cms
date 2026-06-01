// SPDX-License-Identifier: MPL-2.0

/**
 * Orchestrates a single user→AI turn:
 *   1. Persist the user message + chips.
 *   2. Build messages history + system prompt (chunked for prompt-cache).
 *   3. Loop:
 *      - call provider.generate (signal-aware)
 *      - relay text deltas to the client (yielded events)
 *      - persist any assistant text + tool_calls
 *      - dispatch each tool (skip + replay cached if dup id) and
 *        persist the tool result
 *      - if the model said `stop_reason=tool_use`, loop again with the
 *        new transcript so the model can read the tool result and reply
 *      - else exit
 *   4. Record one ai_calls row aggregating usage across the loop.
 *
 * P5.2 additions:
 *  - `abortSignal` propagates to the provider stream and to every
 *    yield site; on abort the in-flight assistant message is marked
 *    `status='interrupted'` and tool dispatch stops mid-loop.
 *  - Tool-call dispatch is deduped by (chat_session_id, tool_call_id)
 *    via `chat.lookup_tool_result` / `chat.cache_tool_result` so a
 *    runner re-entry (retry, restart, double-fire) cannot mutate the
 *    same module twice.
 *  - `composeSystemPromptChunks` returns ordered chunks the Anthropic
 *    adapter caches selectively — chips/skills (volatile) sit after
 *    the cached prefix so changing them doesn't bust the cache.
 */

import {
  pluginPromptContextRegistry,
  pluginToolsRegistry,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import {
  type CandidateSkill,
  type ChatEngagement,
  type ChatSendMessageInput,
  type ExecutionContext,
  formatThemeSummary,
  listThemeCssVarNames,
  matchSkills,
  resolveEngagements,
  skillAutoEngagementHints,
  type Theme,
  type ThemeDocument,
} from "@caelo-cms/shared";

import { tryAutoRecover } from "./auto-recovery.js";
import type { AIProvider, ChatMessageInput } from "./provider.js";
import {
  composeSystemPromptChunks,
  formatContentLibraryBlock,
  formatModulesBlock,
  formatSiteIdentityBlock,
  formatStructuredSetsBlock,
  formatThemeBlock,
} from "./system-prompt.js";
import {
  buildToolDescribeState,
  type ToolDescribeStateActivePage,
} from "./tools/describe-state.js";
import type { ToolRegistry } from "./tools/index.js";

export type ClientEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "tool-start"; toolCallId: string; name: string; arguments: unknown }
  | { kind: "tool-result"; toolCallId: string; ok: boolean; content: string }
  | { kind: "tool-result-cached"; toolCallId: string }
  | { kind: "assistant-message-saved"; messageId: string }
  | { kind: "interrupted"; messageId: string | null }
  | { kind: "usage"; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number }
  | { kind: "done" }
  | { kind: "error"; message: string }
  /**
   * v0.5.9 — non-fatal observability signal. Surfaces conditions that
   * aren't errors but the operator likely wants to see. Distinct kind
   * so ChatPanel can render warnings differently from hard errors. Code
   * field lets future warnings differentiate.
   */
  | { kind: "warning"; code: string; message: string }
  /**
   * v0.2.54 — extended-thinking text deltas; ChatPanel renders into a
   * collapsed details block above the assistant message. UI can ignore
   * these when extended thinking is off.
   */
  | { kind: "thinking-delta"; text: string }
  /**
   * v0.2.54 — fired when one thinking content_block ends. Includes the
   * full block + its cryptographic signature for completeness; the UI
   * doesn't need to do anything with it (rendering uses thinking-delta
   * accumulation), but the runner uses it to persist + round-trip.
   */
  | { kind: "thinking-stop"; thinking: string; signature: string }
  /**
   * P10.5 #1 — wraps a child chat-runner's event when emitted from
   * inside a spawn_subagent / spawn_subagents tool dispatch. The UI
   * renders one collapsible card per role so the user sees the
   * subagent's progress live instead of a 5-30s frozen wait.
   */
  | {
      kind: "subagent-event";
      batchId: string;
      role: string;
      subagentChatSessionId: string;
      inner: Exclude<ClientEvent, { kind: "subagent-event" }>;
    };

export interface ChatRunnerOptions {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly provider: AIProvider;
  readonly tools: ToolRegistry;
  /** AI actor identity used for tool dispatches (writes hit DB as `ai`). */
  readonly aiCtx: ExecutionContext;
  /** Human identity used for user-message persistence + the chat row. */
  readonly humanCtx: ExecutionContext;
  /** Optional cost-per-million-tokens (USD). Falls back to a P5 default. */
  readonly inputCostPerMTok?: number;
  readonly outputCostPerMTok?: number;
  readonly maxToolLoops?: number;
  /** P5.2 #2 — propagated to the provider; aborts halt the loop cleanly. */
  readonly abortSignal?: AbortSignal;
  /**
   * P10.5 — names of tools to STRIP from the tool catalogue for THIS
   * invocation. The `spawn_subagent` tool handler passes
   * `{spawn_subagent, spawn_subagents}` when invoking runChatTurn for
   * the child — that's the depth cap, expressed as plain config. The
   * runner itself doesn't branch on "is this a subagent"; it just
   * filters its catalogue.
   */
  readonly excludedToolNames?: ReadonlySet<string>;
  /**
   * P10.5 #3 — soft cost cap per turn (microcents). After each
   * provider call's `usage` event, the loop checks accumulated cost;
   * if it exceeds this cap, the loop aborts with stopReason='error'
   * and emits an error event. spawn_subagent passes its spec's
   * maxCostMicrocents through here so the cap fires BEFORE the next
   * provider call instead of post-hoc.
   */
  readonly costCapMicrocents?: number;
  /**
   * v0.2.53 — Per-turn output ceiling. SSE handler reads this from
   * `getActiveProvider().maxOutputTokens` (set on `ai_providers.config`
   * at /security/ai). Falls back to MAX_OUTPUT_TOKENS_DEFAULT when the
   * operator hasn't tuned it.
   */
  readonly maxOutputTokens?: number;
  /**
   * Per-turn sampling temperature. SSE handler reads this from
   * `getActiveProvider().temperature` (currently sourced from the
   * test-only `CAELO_CHAT_TEMPERATURE` env hook in provider-resolver).
   * Undefined ⇒ provider default (Anthropic ≈ 1.0). The
   * e2e-livedit suite pins `0` for determinism; production callers
   * pass nothing and behaviour is unchanged.
   */
  readonly temperature?: number;
}

const DEFAULT_INPUT_COST_PER_M = 15; // Opus 4.7 input rate, USD per 1M tokens
const DEFAULT_OUTPUT_COST_PER_M = 75;
/**
 * v0.2.53 — Default output-token ceiling per provider call.
 * 16384 covers compose-page-style turns (text + multi-tool_use batches +
 * post-tool summary) on every modern Claude / GPT-4o / Gemini 2.5 model.
 * The pre-v0.2.53 4096 default was Sonnet-3 era and routinely truncated
 * tool_use blocks mid-stream on Opus 4.7 / Sonnet 4.6. Operators can
 * tune higher (up to 200k) per provider via /security/ai.
 */
const MAX_OUTPUT_TOKENS_DEFAULT = 16384;

/**
 * issue #106 — in-memory nudge re-prompted to the model when it narrates an
 * imminent action but ends the turn without emitting the tool call. NOT
 * persisted to chat history, so the operator never sees a synthetic turn —
 * they only see the model self-correct into the real tool call.
 */
const PASSIVE_ACTION_NUDGE =
  "You described an action you were about to take but did not emit any tool call, so nothing actually happened. If you intended to perform it, call the appropriate tool now with the concrete arguments. If you genuinely need information or a decision from the operator first, ask one direct question instead.";

/**
 * issue #106 — detect the "announced an action, then ended the turn without
 * emitting the tool call it announced" failure (step-13 footer regression).
 * Per CLAUDE.md §4 this is a real defect in our layer, not model
 * nondeterminism, so the chat-runner recovers with a single nudge-and-retry
 * instead of leaving the operator to type "go ahead".
 *
 * Deliberately narrow: returns true only for a near-future first-person
 * commitment to act ("I'll add the footer", "adding it now") that is NOT a
 * clarifying question. The broad v0.5.9 detector was removed because it
 * false-fired on every legitimate question-asking / summarizing turn; this
 * one must not reintroduce that noise, so clarifying questions and
 * conditional/advisory phrasing ("I'd add…", "you could…") are excluded.
 */
export function looksLikeAnnouncedAction(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // A clarifying question is a legitimate text-only turn — never nudge it.
  if (/\?\s*$/.test(t)) return false;
  if (/\b(would you|should i|do you want|want me to|shall i)\b/i.test(t)) return false;
  // Near-future first-person commitment to perform an action.
  return (
    /\b(i'?ll|i will|let me|i'?m going to|i'?m about to)\b/i.test(t) ||
    /\b(i'?m|i am)\s+(adding|creating|placing|updating|attaching|building|setting up)\b/i.test(t) ||
    /\b(adding|creating|placing|updating|attaching)\b[^.?!]*\bnow\b/i.test(t)
  );
}

function microcents(usd: number): number {
  // 1 USD = 1e8 microcents.
  return Math.round(usd * 1e8);
}

/**
 * v0.12.0 — pull the module usage signal that the `## Modules`
 * decision-support block consumes. Wraps `modules.list_usage` and
 * returns the Map shape formatModulesBlock expects. Tolerates a
 * read failure (returns empty map; block renders modules as
 * "unplaced") so a flake here doesn't block the chat turn.
 */
async function loadModuleUsageSignal(
  registry: import("@caelo-cms/query-api").OperationRegistry,
  adapter: import("@caelo-cms/query-api").DatabaseAdapter,
  ctx: ExecutionContext,
): Promise<ReadonlyMap<string, { placementCount: number; sampleSlugs: readonly string[] }>> {
  const r = await execute(registry, adapter, ctx, "modules.list_usage", {});
  if (!r.ok) return new Map();
  const { usage } = r.value as {
    usage: { moduleId: string; placementCount: number; sampleSlugs: string[] }[];
  };
  return new Map(
    usage.map((u) => [
      u.moduleId,
      { placementCount: u.placementCount, sampleSlugs: u.sampleSlugs },
    ]),
  );
}

export async function* runChatTurn(
  options: ChatRunnerOptions,
  input: ChatSendMessageInput,
): AsyncIterable<ClientEvent> {
  const { adapter, registry, provider, tools, aiCtx, humanCtx, abortSignal } = options;
  const inputCost = options.inputCostPerMTok ?? DEFAULT_INPUT_COST_PER_M;
  const outputCost = options.outputCostPerMTok ?? DEFAULT_OUTPUT_COST_PER_M;
  // v0.3.20 — raised from 5 to 25. Multi-section authoring sessions
  // (homepage build with theme setup + modules + SEO + layout binding)
  // routinely need >5 tool-use round-trips. The old cap silently
  // truncated those builds mid-flight with no UI signal — see the
  // cap-exhaustion notice below the for-loop for the visible-signal
  // half of the fix.
  const maxLoops = options.maxToolLoops ?? 25;
  const startedAt = Date.now();
  const aborted = (): boolean => abortSignal?.aborted === true;
  // v0.2.57 — entry breadcrumb. v0.2.55 added per-loop console.info(),
  // but Cloud Run's stdout sink wasn't capturing it (Bun's adapter +
  // SvelteKit prerender stack swallows console.info/log; only
  // console.error reliably reaches the stderr stream). This entry
  // line + the loop trace below both use console.error so they're
  // guaranteed visible in the log explorer. Cost: a non-error log
  // line shows with severity=ERROR in the Cloud Logging UI, which is
  // ugly but workable and unambiguous.
  // v0.2.58 — also emit when thinking is on so we can correlate
  // long-streaming sessions ("AI stops mid-plan after 16s") with
  // thinking budget — extended thinking turns can block on the
  // model for 10-30s before the first text-delta lands; that window
  // is where browser/proxy aborts tend to fire.
  console.error("[chat-runner] enter", {
    chatSessionId: input.chatSessionId,
    actorKind: aiCtx.actorKind,
    maxLoops,
    maxOutputTokens: options.maxOutputTokens,
  });

  // 1. Persist the user message.
  const userContent =
    input.chips.length > 0
      ? [
          input.content,
          "",
          "Element references attached to this message:",
          ...input.chips.map(
            (c) => `  - ${c.label} (module=${c.moduleId.slice(0, 8)}, selector=${c.selector})`,
          ),
        ].join("\n")
      : input.content;

  const userMsg = await execute(registry, adapter, humanCtx, "chat.append_message", {
    chatSessionId: input.chatSessionId,
    role: "user",
    content: userContent,
  });
  if (!userMsg.ok) {
    yield { kind: "error", message: "failed to persist user message" };
    yield { kind: "done" };
    return;
  }

  // 2. Load memory + history.
  const memoryResult = await execute(registry, adapter, humanCtx, "ai_memory.list", {});
  const memory = memoryResult.ok
    ? (memoryResult.value as { memory: { slot: string; body: string }[] }).memory
    : [];

  const sessionResult = await execute(registry, adapter, humanCtx, "chat.get_session", {
    chatSessionId: input.chatSessionId,
  });
  if (!sessionResult.ok) {
    yield { kind: "error", message: "failed to load session" };
    yield { kind: "done" };
    return;
  }
  const session = sessionResult.value as {
    session: {
      chatBranchId: string;
      extendedThinkingEnabled: boolean;
      extendedThinkingBudgetTokens: number | null;
    };
    // v0.9.0 — branched-create reads. The catalog fetches below
    // (layouts.list / templates.list / pages.list) must include the
    // chat's own branched-create entities, otherwise the AI's
    // describe() state misses them and tools like bootstrap_site_scaffold
    // re-propose a layout that's already mid-create on this chat.
    // Constructed here right after the session lookup so it's
    // available for every downstream catalog read.
    messages: {
      role: "user" | "assistant" | "tool";
      content: string;
      toolCalls: unknown;
      toolCallId: string | null;
      thinkingBlocks: { thinking: string; signature: string }[] | null;
    }[];
  };

  // v0.9.0 — branch-aware ctx for every downstream read so the AI's
  // pages.list / layouts.list / templates.list / pages.get etc.
  // include the chat's own branched-create entities (the v0.5.7-
  // attempt that v0.5.19 reverted — now properly retrofitted with
  // the read overlay in place). Defined right after sessionResult so
  // every subsequent fetch below uses it.
  const humanCtxWithBranch: ExecutionContext = {
    ...humanCtx,
    chatBranchId: session.session.chatBranchId,
    chatTaskId: input.chatSessionId,
  };

  // v0.2.54 — Resolve extended-thinking config for THIS turn.
  // Per-chat-session toggle wins; budget falls back to a sensible
  // default that fits comfortably under the 32k max_tokens floor.
  // 10000 leaves ~22k for the response + tool_use, which covers
  // every realistic compose-page-style turn.
  const thinkingEnabled = session.session.extendedThinkingEnabled;
  const thinkingBudget = thinkingEnabled
    ? (session.session.extendedThinkingBudgetTokens ?? 10000)
    : null;
  // v0.2.58 — per-session forensics. Session is resolved here so we
  // can correlate "AI stops mid-plan after 16s" with thinking config
  // + history size + chip count. Important: extended thinking on a
  // 10k budget can block the provider stream for 10-30s before the
  // first text-delta lands — that window is where browser/proxy
  // aborts tend to fire. If this log shows thinkingBudget=10000 +
  // [chat stream] exception within 30s, the operator can flip the
  // 🐞 Debug toggle off and verify the abort goes away.
  console.error("[chat-runner] session", {
    chatSessionId: input.chatSessionId,
    thinkingEnabled,
    thinkingBudget,
    historyLen: session.messages.length,
    chips: input.chips.length,
  });

  // Provider message history is everything in the chat now (the user
  // message we just appended is in there too). v0.2.54 — thinking
  // blocks from prior assistant turns are included so Anthropic can
  // verify the cryptographic signatures across tool-use boundaries.
  const baseMessages: ChatMessageInput[] = session.messages.map((m) => ({
    role: m.role,
    content: m.content,
    toolCalls: Array.isArray(m.toolCalls)
      ? (m.toolCalls as { id: string; name: string; arguments: unknown }[])
      : undefined,
    toolCallId: m.toolCallId ?? undefined,
    ...(m.thinkingBlocks && m.thinkingBlocks.length > 0
      ? { thinkingBlocks: m.thinkingBlocks }
      : {}),
  }));

  // P5.2 #4 — chunked system prompt. Chips render as a volatile chunk
  // so they don't bust the cache prefix (BASE + memory + tools).
  const chipsBlock =
    input.chips.length > 0
      ? [
          "# Element references in this turn",
          ...input.chips.map((c) => `- ${c.label} (module=${c.moduleId}, selector=${c.selector})`),
        ].join("\n")
      : undefined;

  // P6.7.3 — Current-page volatile chunk. When the live-edit surface
  // sends `activePageId`, we load the page + its modules + the
  // template's blocks and surface that as a per-call context block so
  // the AI knows what's on the page and which tool to use ("I want a
  // button at the top" → add_module_to_page; "make the hero red" →
  // edit_module on the matching module-id).
  let pageContextBlock: string | undefined;
  // v0.12.3 (issue #106) — captured for ToolDescribeState so the
  // add_module_to_page / move_module describeSchema can pin blockName to
  // a generation-time enum of THIS page's actual template blocks.
  let activePageForState: ToolDescribeStateActivePage | null = null;
  if (input.activePageId) {
    const pageR = await execute(registry, adapter, humanCtxWithBranch, "pages.get_with_modules", {
      pageId: input.activePageId,
    });
    if (pageR.ok) {
      const v = pageR.value as {
        page: {
          id: string;
          slug: string;
          locale: string;
          title: string;
          status: string;
          templateId: string;
          blocks: {
            blockName: string;
            modules: { moduleId: string; slug: string; displayName: string; html: string }[];
          }[];
        };
      };
      activePageForState = {
        id: v.page.id,
        templateId: v.page.templateId,
        blockNames: v.page.blocks.map((b) => b.blockName),
      };
      // P6.7.4 — render the page like a visitor would see it, with each
      // module's full HTML wrapped in BEGIN/END markers carrying the
      // module id + slug + block + position. The AI gets both the
      // visual structure ("make the headline more meaningful for this
      // landing page" works) and the module boundaries (so edit_module
      // / add_module_to_page calls reference a real id).
      const lines: string[] = [
        "# Current page",
        `Page: ${v.page.slug} (locale=${v.page.locale}, status=${v.page.status}, id=${v.page.id})`,
        `Template id: ${v.page.templateId}`,
        // v0.12.3 (issue #106) — this list is AUTHORITATIVE + EXHAUSTIVE.
        // `blockName` for add_module_to_page / move_module MUST be one of
        // these exact strings — do not invent others. A block name is NOT
        // the same thing as a module `kind` (chrome/hero/content/cta/
        // utility): `kind` classifies a module, a block name is a slot on
        // THIS page's template. e.g. a "hero" module goes INTO whichever
        // block exists below, often `content` — there is usually no block
        // literally named "hero".
        `Blocks on this page's template (the ONLY valid blockName values — exhaustive): ${
          v.page.blocks.map((b) => `\`${b.blockName}\``).join(", ") || "(none)"
        }`,
        "",
        "## Page content (rendered with module boundaries)",
        "",
      ];
      for (const b of v.page.blocks) {
        if (b.modules.length === 0) {
          lines.push(`<!-- block=${b.blockName} (empty) -->`);
          continue;
        }
        for (let i = 0; i < b.modules.length; i++) {
          const m = b.modules[i];
          if (!m) continue;
          const safeName = m.displayName.replace(/"/g, '\\"');
          lines.push(
            `<!-- BEGIN module=${m.moduleId} slug=${m.slug} block=${b.blockName} position=${i} displayName="${safeName}" -->`,
          );
          lines.push(m.html);
          lines.push(`<!-- END module=${m.moduleId} -->`);
        }
      }
      lines.push("");
      lines.push(
        "Tool guidance (module / page level):",
        "- edit_module — change an existing module's content (always reference a real module id from a BEGIN marker above).",
        "- add_module_to_page — insert a NEW module into a block on THIS page only. Use for one-off content (a CTA on the homepage, an FAQ on /about). Position is 'top', 'bottom', or a 0-based index.",
        '- add_module_to_template — create a NEW module and fan it out to EVERY page using this template at the same block + position. Use only when the user explicitly asks for site-wide content ("add a footer to every page", "a header banner across the site"). Pass the Template id above.',
        "- remove_module_from_page — drop a module from a page's layout (the module row stays for re-use elsewhere).",
        "",
        "Tool guidance (page lifecycle — three independent identifiers):",
        "- A page has THREE separately-editable identifiers. Never silently substitute one for another:",
        "  * `name`  — the editor's friendly label (page picker, breadcrumbs). Internal-only.",
        "  * `title` — the HTML <title> tag (browser tab, search-engine SERP). Public.",
        "  * `slug`  — the URL path component. Public, indexed, every link points at it.",
        "- create_page(name, title, slug, templateId, ...) — make a new page.",
        '- rename_page(pageId, newName) — internal label only. Use when the user says "rename" without mentioning URL or tab.',
        '- set_page_title(pageId, newTitle) — HTML <title> only. Use when the user mentions "browser tab", "<title>", or "SERP".',
        "- change_page_slug(pageId, newSlug, redirectFromOld=auto) — URL only. Auto-creates a 301 from the old URL. Use only when the user explicitly mentions changing the URL / slug / path.",
        "- delete_page(pageId, disposition='404'|'redirect', redirectTo?) — soft-delete. ALWAYS confirm with the user which behaviour they want for the dead URL; suggest a redirect target (parent section, sibling, or /) when proposing redirect.",
        '- When a request is ambiguous (e.g. just "rename to About"), ASK: "Should I update only the internal name, the <title> tag, or the URL too?"',
        "",
        "Tool guidance (content ops, P6.7.7):",
        "- duplicate_page(sourcePageId, newSlug, newName?, newTitle?, targetTemplateId?) — clone a page including its module layout. Modules carry by reference (edits propagate to both pages). If targetTemplateId differs from the source's template, block names must align — otherwise modules in unmatched blocks orphan and you should follow with `change_template` to migrate or drop them.",
        "- change_template(pageId, newTemplateId, orphanDisposition) — re-point a page to a different template (page-type). Modules in matching block names migrate; orphans drop or relocate per `orphanDisposition` (`{kind:'drop'}` or `{kind:'preserve-as-block', blockName}`). CONFIRM with the user before passing `{kind:'drop'}` if it would lose modules. The response carries `migratedBlocks` and `droppedModules` — surface both back in your reply.",
        "- move_module(pageId, moduleId, toBlockName, position) — move an EXISTING module across blocks (e.g. content → header). Use this, NOT `add_module_to_page`, when the module already exists on the page.",
        "- reorder_module(pageId, moduleId, direction) — change a module's position WITHIN its current block. Direction is 'up' / 'down' / a 0-based absolute index. Use this, NOT `move_module`, when the destination is the same block.",
        "- set_structured_set(kind, slug, displayName, items) — upsert a structured-data set (nav-menu, tags, taxonomy, theme, link-list, language-selector). Pass the FULL desired item list — op REPLACES, not appends. For partial updates (one theme token, one link rename), call `get_structured_set` first to read current items, mutate in JS, then `set_structured_set` with the merged array. The system-prompt block above already inlines nav-menu items (up to 30/menu) at session start; copy them and modify, don't re-invent.",
        "",
        'When the user asks for a copy change like "make the headline more meaningful" or "rewrite the welcome paragraph", read the surrounding modules in this block to keep the new copy coherent across the whole page.',
      );
      pageContextBlock = lines.join("\n");
    }
  }

  // P6.7.5 — All-pages, Theme, Structured-sets, Dead-links volatile
  // chunks. Each is short and skipped when empty so a fresh install
  // doesn't drown in placeholders.
  let allPagesBlock: string | undefined;
  const allPagesR = await execute(registry, adapter, humanCtxWithBranch, "pages.list", {});
  if (allPagesR.ok) {
    const ps = (
      allPagesR.value as {
        pages: {
          id: string;
          slug: string;
          locale: string;
          name: string;
          title: string;
          status: string;
          // v0.12.0 — joined from templates.kind so the AI groups pages
          // by intent. Optional because pre-0096 templates have NULL.
          kind?: "home" | "landing" | "product" | "blog" | "doc" | "content" | "utility";
        }[];
      }
    ).pages;
    if (ps.length > 0) {
      // v0.12.0 — group pages by kind so the AI scans intent-first
      // ("which product pages already exist?"). Pages without a kind
      // (templates pre-0096) fall under `content`.
      const KIND_ORDER = [
        "home",
        "landing",
        "product",
        "blog",
        "doc",
        "content",
        "utility",
      ] as const;
      const byKind = new Map<(typeof KIND_ORDER)[number], typeof ps>();
      for (const k of KIND_ORDER) byKind.set(k, [] as unknown as typeof ps);
      for (const p of ps) {
        const k = (p.kind ?? "content") as (typeof KIND_ORDER)[number];
        const bucket = byKind.get(k) as unknown as (typeof ps)[number][];
        bucket.push(p);
      }
      const lines: string[] = [
        "# All pages on this site",
        "Pages grouped by `kind` (inherited from the template). Treat repetition within a group as a pattern — e.g. three modules on three `product` pages = a product-page convention you should follow, not a coincidence.",
        "Use these (slug, locale) pairs as link targets — never invent a URL.",
        "",
      ];
      for (const k of KIND_ORDER) {
        const bucket = byKind.get(k) as unknown as (typeof ps)[number][];
        if (bucket.length === 0) continue;
        lines.push(`### kind=${k}`);
        for (const p of bucket) {
          lines.push(
            `- id=${p.id} name="${p.name}" title="${p.title}" url=${p.locale === "en" ? `/${p.slug}` : `/${p.locale}/${p.slug}`} status=${p.status}`,
          );
        }
      }
      allPagesBlock = lines.join("\n");
    }
  }

  // v0.11.0 (#45) — themes primitive. Load the active theme (one row,
  // is_active=true) and render the dedicated ## Theme system-prompt
  // block via formatThemeBlock. Replaces the pre-v0.11 prose that
  // referenced the legacy `structured_sets WHERE kind='theme'` row.
  let themeBlock: string | undefined;
  const activeThemeR = await execute(registry, adapter, humanCtx, "themes.get_active", {});
  if (activeThemeR.ok) {
    // Round-2 opt §3: cast to the typed Theme aggregate (op output schema)
    // instead of a hand-rolled partial; surfaces compile-time errors if
    // themes.get_active's output ever drifts.
    const { theme } = activeThemeR.value as { theme: Theme | null };
    if (theme) {
      themeBlock = formatThemeBlock({
        slug: theme.slug,
        displayName: theme.displayName,
        // Round-2 opt §4: surface the operator-supplied description so
        // multi-theme installs (v0.11.1+) let the AI pick the right slug
        // by intent (e.g. "Brand Orange — campaign-page variant").
        description: theme.description,
        // v0.11.4 (issue #76 follow-up) — surface provenance so the AI
        // knows whether to evolve (`seed`) or preserve (`ai`/`operator`).
        origin: theme.origin,
        // v0.11.1 (issue #76) — formatThemeSummary replaces the v0.11.0
        // category-count `summarizeTokens` so the system prompt carries
        // the palette/font/radius shorthand the AI actually uses to pick
        // matching module styling.
        tokensSummary: formatThemeSummary(theme.tokens as ThemeDocument),
        // v0.11.4 (issue #76 follow-up) — list the actual CSS var names
        // the renderer emits for this theme. Without this the AI guesses
        // names (--color-text, --color-surface) that don't exist in
        // shadcn-style themes, and module CSS falls through to hardcoded
        // slate/white fallbacks. With this, the AI uses real var names.
        cssVarNames: listThemeCssVarNames(theme.tokens as ThemeDocument),
      });
    } else {
      themeBlock = formatThemeBlock(null);
    }
  }

  let structuredSetsBlock: string | undefined;
  const setsR = await execute(registry, adapter, humanCtx, "structured_sets.list", {});
  if (setsR.ok) {
    const sets = (
      setsR.value as {
        sets: { kind: string; slug: string; displayName: string; items: unknown }[];
      }
    ).sets;
    structuredSetsBlock = formatStructuredSetsBlock(sets);
  }

  // v0.12.0 — `## Modules` decision-support catalog. Per CLAUDE.md §1A
  // the AI picks modules by intent (kind + description), so this
  // block sorts by kind and surfaces description + REAL placement
  // usage + a short field summary per module.
  let modulesBlock: string | undefined;
  const modulesR = await execute(registry, adapter, humanCtxWithBranch, "modules.list", {});
  if (modulesR.ok) {
    const { modules: mods } = modulesR.value as {
      modules: {
        id: string;
        slug: string;
        displayName: string;
        description: string;
        kind: "chrome" | "hero" | "content" | "cta" | "utility";
        // v0.12.3 (issue #106) — surfaced so the `## Modules` block shows
        // each module's stable type + each nested field's allowedModuleTypes.
        type: string;
        fields: { name: string; kind: string; allowedModuleTypes?: string[] }[];
      }[];
    };
    // Real usage signal: one query joins page_modules → pages,
    // groups by module_id, returns count + a deterministic top-3
    // page slugs per module. The result is a Map the block formatter
    // consumes; modules with zero placements stay out of the map and
    // the formatter renders them as "unplaced".
    const usageByModuleId = await loadModuleUsageSignal(registry, adapter, humanCtxWithBranch);
    modulesBlock = formatModulesBlock(mods, usageByModuleId);
  }

  // v0.12.0 — content_instances inventory block. Branch-aware so chats
  // see their own in-flight branched-create instances. Per CLAUDE.md
  // §1A this block carries decision-support context (purpose +
  // placementCount + sample slugs) so the AI can decide reuse vs
  // fork vs mint new without round-tripping back to the operator.
  let contentLibraryBlock: string | undefined;
  const instancesR = await execute(
    registry,
    adapter,
    humanCtxWithBranch,
    "content_instances.list",
    {},
  );
  if (instancesR.ok) {
    const { instances } = instancesR.value as {
      instances: {
        id: string;
        moduleSlug: string;
        moduleKind?: "chrome" | "hero" | "content" | "cta" | "utility";
        slug: string | null;
        displayName: string | null;
        purpose?: string | null;
        placementCount: number;
      }[];
    };
    contentLibraryBlock = formatContentLibraryBlock(instances);
  }

  // P6.7.6 — layouts (site-wide chrome) + site_defaults so the AI knows
  // which layout/template to use when creating a page and which tool
  // surface (page / template / layout) is appropriate for a given
  // change request. v0.9.0 — uses humanCtxWithBranch (defined above)
  // so the AI sees its own in-flight branched-create layouts +
  // templates.
  let layoutsBlock: string | undefined;
  let siteDefaultsBlock: string | undefined;
  // v0.11.4 (issue #76 follow-up) — site identity block reads from the
  // same site_defaults row.
  let siteIdentityBlock: string | undefined;
  const layoutsR = await execute(registry, adapter, humanCtxWithBranch, "layouts.list", {
    includeDeleted: false,
  });
  const tplsR = await execute(registry, adapter, humanCtxWithBranch, "templates.list", {
    includeDeleted: false,
  });
  const defaultsR = await execute(registry, adapter, humanCtxWithBranch, "site_defaults.get", {});
  // v0.11.4 (issue #76 follow-up) — always render the ## Site identity
  // block. When defaults are null or both fields are empty, the block
  // carries cold-start instructions telling the AI to capture identity
  // from the first user prompt via `set_site_identity` BEFORE authoring
  // modules. That's the chat-first replacement for the removed
  // /onboarding tour.
  const identityDefaults = defaultsR.ok
    ? (
        defaultsR.value as {
          defaults: { siteName: string | null; sitePurpose: string | null } | null;
        }
      ).defaults
    : null;
  const identityRender = formatSiteIdentityBlock(identityDefaults);
  if (identityRender) siteIdentityBlock = identityRender;
  if (layoutsR.ok) {
    const layouts = (
      layoutsR.value as {
        layouts: {
          id: string;
          slug: string;
          displayName: string;
          blocks: { name: string; displayName: string }[];
        }[];
      }
    ).layouts;
    if (layouts.length > 0) {
      layoutsBlock = [
        "# Layouts on this site (site-wide chrome)",
        "Layouts wrap every page on every template bound to them. The `content` block always holds the rendered template; other blocks (header, footer, nav) are filled by `add_module_to_layout`.",
        // P18 — include each layout's UUID so the AI can pass `layoutId`
        // to `create_template` / `set_template_layout` without a
        // `layouts.list` round-trip. (`create_template.layoutId` is
        // optional + falls back to site_defaults; this surfaces the
        // non-default options.)
        ...layouts.map(
          (l) =>
            `- ${l.slug} (id=${l.id}) "${l.displayName}" — blocks: ${l.blocks.map((b) => b.name).join(", ")}`,
        ),
        "",
        "Three add-module surfaces — pick by intent:",
        "- one page only        → `add_module_to_page`",
        "- every page on a template → `add_module_to_template`",
        "- every page on the site (or a whole layout) → `add_module_to_layout` (e.g. layoutSlug='site-default', blockName='footer')",
        "",
        "Adding a plugin's output (comments, contact form, ratings, newsletter) to a page → `add_plugin_to_page` (per-page placeholder; the static-generator + Web Component handle the rest). Plugins must be installed + active — see `# Plugins` for available slugs.",
        "",
        "`create_layout` is Owner-only (AI calls reject; surface the permission requirement). `set_site_defaults` is AI-callable directly — use it on a fresh install where `# Site defaults` shows '(none configured yet)'.",
      ].join("\n");
    }
  }
  if (defaultsR.ok && tplsR.ok) {
    const defaults = (
      defaultsR.value as {
        defaults: {
          defaultLayoutSlug: string;
          defaultTemplateSlug: string;
        } | null;
      }
    ).defaults;
    const tpls = (tplsR.value as { templates: { id: string; slug: string; layoutId: string }[] })
      .templates;
    const layoutBySlug = new Map<string, string>();
    if (layoutsR.ok) {
      for (const l of (layoutsR.value as { layouts: { id: string; slug: string }[] }).layouts) {
        layoutBySlug.set(l.id, l.slug);
      }
    }
    // P18 — include each template's UUID so the AI can pass it as
    // `templateId` to `create_page` / `change_template` without a
    // separate `templates.list` round-trip. Same for the layout it
    // binds to. (`create_page.templateId` is optional and resolves to
    // site_defaults; this is for the "use a non-default template" path.)
    const templateLines = tpls.map(
      (t) =>
        `- ${t.slug} (id=${t.id}) → ${layoutBySlug.get(t.layoutId) ?? "(unknown layout)"} (id=${t.layoutId})`,
    );
    siteDefaultsBlock = [
      "# Site defaults (used when caller omits a layout/template)",
      defaults
        ? `- default layout: ${defaults.defaultLayoutSlug}\n- default template: ${defaults.defaultTemplateSlug}`
        : "- (none configured yet — call `set_site_defaults({defaultLayoutSlug, defaultTemplateSlug})` directly to set them, or omit `templateId`/`layoutId` on individual creates to get a structured 'no defaults' error)",
      "",
      "# Templates → layouts",
      ...(templateLines.length > 0 ? templateLines : ["- (no templates yet)"]),
      "",
      // Action sentence anchored to the data above. Reduces AI
      // hedging like "I only have its slug, paste the UUID" — the
      // UUIDs ARE in the lines above; restating the action loop
      // here makes the model use them.
      templateLines.length > 0
        ? `To create a page on a specific template, call create_page with templateId=<UUID from above>. To use the site default, omit templateId entirely. The lines above carry every UUID you need — do NOT ask the operator to paste it.`
        : // v0.5.10 — fresh-install bootstrap path. Pre-v0.5.10 this text
          // primed passive behavior ("ask the operator"). New text names
          // the exact tools and forbids the passive ask explicitly.
          "No templates or layouts exist yet. Bootstrap them yourself: call create_layout to make a layout with three blocks (header, content, footer), then create_template pointing at that layout, then set_site_defaults. Do NOT ask the operator to do this — these tools are available to you. After bootstrap, proceed with the user's original request in the same turn.",
    ].join("\n");
    // Optional debug telemetry. Gated behind CAELO_DEBUG_PROMPT so it
    // costs nothing in production but can be flipped on for one Cloud
    // Run revision to confirm what the AI actually sees.
    if (process.env.CAELO_DEBUG_PROMPT === "1") {
      console.log(
        `[chat-runner] siteDefaultsBlock len=${siteDefaultsBlock.length} preview=${JSON.stringify(siteDefaultsBlock.slice(0, 600))}`,
      );
    }
  } else if (process.env.CAELO_DEBUG_PROMPT === "1") {
    console.log(
      `[chat-runner] siteDefaultsBlock SKIPPED — defaultsR.ok=${defaultsR.ok} tplsR.ok=${tplsR.ok}`,
    );
  }

  // P7 — recent + most-used media so the AI can pick existing assets
  // before suggesting an upload. URLs use the WebP-800 variant for
  // raster images, `orig` for SVG / PDF / video. The composed page is
  // already in `pageContextBlock` with literal /_caelo/media/... URLs;
  // this block surfaces the *catalogue* of what's available beyond
  // what the page currently uses.
  let mediaBlock: string | undefined;
  const mediaR = await execute(registry, adapter, humanCtx, "media.recent_for_ai", { limit: 30 });
  if (mediaR.ok) {
    const assets = (
      mediaR.value as {
        assets: {
          id: string;
          mime: string;
          alt: string;
          width: number | null;
          height: number | null;
          originalName: string;
          usageCount: number;
        }[];
      }
    ).assets;
    if (assets.length > 0) {
      const RASTER = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);
      const lines = assets.map((a) => {
        const variant = RASTER.has(a.mime) ? "webp-800" : "orig";
        const dims = a.width && a.height ? `, ${a.width}x${a.height}` : "";
        const alt = a.alt ? `, alt="${a.alt}"` : "";
        const used = a.usageCount > 0 ? ` (used ${a.usageCount}×)` : "";
        return `- ${a.originalName} (${a.mime}${dims}${alt})${used} → /_caelo/media/${a.id}/${variant}`;
      });
      mediaBlock = [
        "# Media (recent + frequently used)",
        'Drop these URLs straight into module HTML via `<img src="..." alt="...">`. Always include a meaningful alt; if alt is empty above, ask the user or call `set_media_alt` if you have visual context. To search beyond this slice, call `find_media({ query, mime?, limit? })`. If nothing matches, ask the user to upload via /content/media.',
        ...lines,
      ].join("\n");
    }
  }

  // P8 AI-first review pass — `## Redirects` context block. Lets the
  // AI plan slug-change conversations + bulk cleanup without a
  // `find_redirects` round-trip when the table is small. Caps at 30
  // most-recent rows; AI calls `find_redirects` for fuller search.
  let redirectsBlock: string | undefined;
  const redirR = await execute(registry, adapter, humanCtx, "redirects.list", { limit: 30 });
  if (redirR.ok) {
    const rows = redirR.value as {
      redirects: { fromPath: string; toPath: string; statusCode: number }[];
      totalCount: number;
    };
    if (rows.redirects.length > 0) {
      const lines = rows.redirects.map((r) => `- ${r.fromPath} → ${r.toPath} (${r.statusCode})`);
      redirectsBlock = [
        `# Redirects (showing ${rows.redirects.length} of ${rows.totalCount})`,
        "For more, call `find_redirects({ query?, statusCode?, limit? })`. To create / delete in bulk, prefer `bulk_create_redirects` / `bulk_delete_redirects` over multiple single-row tool calls.",
        ...lines,
      ].join("\n");
    }
  }

  // P9 — `## Locales` context block. Lists every locale with its URL
  // strategy and surfaces pending proposals so the AI doesn't re-queue
  // a change the Owner is already reviewing.
  let localesBlock: string | undefined;
  const localesR = await execute(registry, adapter, humanCtx, "locales.list", {});
  if (localesR.ok) {
    const rows = localesR.value as {
      locales: {
        code: string;
        displayName: string;
        urlStrategy: string;
        urlHost: string | null;
        isDefault: boolean;
      }[];
    };
    if (rows.locales.length > 0) {
      const lines = rows.locales.map((l) => {
        const def = l.isDefault ? " (DEFAULT)" : "";
        const host = l.urlHost ? ` host=${l.urlHost}` : "";
        return `- ${l.code} "${l.displayName}" — ${l.urlStrategy}${host}${def}`;
      });
      const pendingR = await execute(registry, adapter, humanCtx, "locales.list_pending", {
        status: "pending",
      });
      const pendingLines: string[] = [];
      if (pendingR.ok) {
        const p = pendingR.value as {
          proposals: { id: string; actionKind: string; payload: unknown }[];
        };
        for (const pr of p.proposals.slice(0, 10)) {
          pendingLines.push(
            `  pending: ${pr.actionKind} ${JSON.stringify(pr.payload)} (id=${pr.id})`,
          );
        }
      }
      localesBlock = [
        "# Locales",
        // v0.5.10 — dropped "per CLAUDE.md §11.A" citation. The AI can't
        // access that file; the citation made it sound like a referenceable
        // external doc. The rule itself stays.
        "Adding/removing/retargeting a locale is a TWO-STEP propose/execute flow. You propose via `propose_add_locale` / `propose_remove_locale` / `propose_set_default_locale` / `propose_update_locale_strategy`; an Owner clicks Approve at /security/locales/pending to apply. Do not claim the action was applied — tell the user the proposal is queued.",
        ...lines,
        ...(pendingLines.length > 0 ? ["Your pending proposals:", ...pendingLines] : []),
      ].join("\n");
    }
  }

  // v0.2.32 + v0.2.38 — `## Pending proposals` block, AI-self-filtered.
  // Surfaces ONLY proposals the AI itself queued in any prior turn so it
  // doesn't re-queue them (CLAUDE.md §11.A). Other actors' proposals get
  // a one-line count so the AI knows the operator has other things in
  // flight without flooding the context.
  let pendingProposalsBlock: string | undefined;
  const pendingR = await execute(registry, adapter, humanCtx, "pending_proposals.list", {
    limit: 200,
  });
  if (pendingR.ok) {
    const v = pendingR.value as {
      items: Array<{
        domain: string;
        kind: string;
        proposalId: string;
        summary: string;
        proposedBy: string;
        proposedAt: string;
      }>;
      byDomain: Record<string, number>;
      total: number;
    };
    const aiActorId = aiCtx.actorId;
    const own = v.items.filter((i) => i.proposedBy === aiActorId);
    const othersCount = v.total - own.length;
    if (own.length > 0 || othersCount > 0) {
      const lines = own
        .slice(0, 30)
        .map(
          (i) =>
            `- [${i.domain}.${i.kind}] ${i.summary} (id=${i.proposalId.slice(0, 8)}, ${i.proposedAt.slice(0, 10)})`,
        );
      const headerParts: string[] = [];
      if (own.length > 0) headerParts.push(`${own.length} of your own`);
      if (othersCount > 0) headerParts.push(`${othersCount} from other actors`);
      pendingProposalsBlock = [
        `# Pending proposals (${headerParts.join(", ")})`,
        ...(own.length > 0
          ? [
              "Your queued proposals — DO NOT re-propose any of these. Tell the user they're already pending, or use `cancel_proposal` to withdraw.",
              // v0.2.64 — chat UI surfaces these proposals as a sticky
              // strip at the top of the transcript with inline
              // Approve / Reject buttons (shipped v0.2.62 / v0.2.63).
              // When the operator asks "where's the approve button?",
              // tell them: "scroll to the top of THIS chat — there's
              // an amber 'Pending your approval' strip with the
              // Approve button right there." Do NOT direct them to
              // /security/<domain>/pending unless they explicitly
              // want the full preview view; the strip is the fast
              // path. Pre-v0.2.62 instances may not have the strip,
              // so /security/pending is the safe fallback.
              "When directing the operator to approve a queued proposal: tell them to look for the amber 'Pending your approval' strip at the top of this chat panel — each row has inline Approve / Reject buttons. They don't need to navigate to /security/<domain>/pending; the strip and the original tool-card both have one-click approve. If the strip isn't visible after a recent upgrade, ask the operator to hard-refresh.",
              ...lines,
            ]
          : []),
        ...(othersCount > 0
          ? [
              `(${othersCount} more pending from other actors — operator can review at /security/pending.)`,
            ]
          : []),
      ].join("\n");
    }
  }

  // v0.2.38 — `## Users` / `## Roles` / `## AI providers` / `## Domains`
  // inventory blocks (CLAUDE.md §11: "new domains should ship a
  // corresponding context block when the data fits in <2 KB"). Each
  // block lets the AI plan domain-targeting work without a *.list
  // round-trip per turn. Best-effort — if a list call fails the block
  // is omitted, never blocks the turn.
  let usersBlock: string | undefined;
  const usersListR = await execute(registry, adapter, humanCtx, "users.list", {});
  if (usersListR.ok) {
    const users = (
      usersListR.value as {
        users: Array<{ id: string; email: string; displayName: string; roles: string[] }>;
      }
    ).users;
    if (users.length > 0) {
      usersBlock = [
        `# Users (${users.length})`,
        "Use `propose_create_user` to invite, `propose_set_user_roles` to change roles, `propose_delete_user` to soft-delete.",
        ...users
          .slice(0, 40)
          .map(
            (u) =>
              `- ${u.email} "${u.displayName}" — ${u.roles.length > 0 ? u.roles.join("+") : "(no roles)"} (id=${u.id.slice(0, 8)})`,
          ),
      ].join("\n");
    }
  }

  let rolesBlock: string | undefined;
  const rolesListR = await execute(registry, adapter, humanCtx, "roles.list", {});
  if (rolesListR.ok) {
    const roles = (
      rolesListR.value as {
        roles: Array<{
          id: string;
          name: string;
          description: string;
          isBuiltin: boolean;
          permissions: string[];
        }>;
      }
    ).roles;
    if (roles.length > 0) {
      rolesBlock = [
        `# Roles (${roles.length})`,
        "Use `propose_create_role` for new roles, `propose_update_role_permissions` to modify, `propose_delete_role` to remove (built-in roles cannot be deleted).",
        ...roles.map(
          (r) =>
            `- ${r.name}${r.isBuiltin ? " [builtin]" : ""} — ${r.permissions.length} permission${r.permissions.length === 1 ? "" : "s"} (id=${r.id.slice(0, 8)})`,
        ),
      ].join("\n");
    }
  }

  let aiProvidersBlock: string | undefined;
  const providersR = await execute(registry, adapter, humanCtx, "ai_providers.list", {});
  if (providersR.ok) {
    const providers = (
      providersR.value as {
        providers: Array<{
          name: string;
          displayName: string;
          isActive: boolean;
          apiKeySource: "db" | "env" | null;
        }>;
      }
    ).providers;
    if (providers.length > 0) {
      aiProvidersBlock = [
        "# AI providers",
        "Use `propose_set_ai_provider` to add or modify config (Owner pastes apiKey at approve), `propose_clear_ai_provider_key` to wipe a stored key.",
        ...providers.map(
          (p) =>
            `- ${p.name} "${p.displayName}" — active=${p.isActive}, key=${p.apiKeySource ?? "none"}`,
        ),
      ].join("\n");
    }
  }

  let domainsBlock: string | undefined;
  const domainsR = await execute(registry, adapter, humanCtx, "domains.list", {});
  if (domainsR.ok) {
    const domains = (
      domainsR.value as {
        domains: Array<{
          id: string;
          hostname: string;
          kind: string;
          tlsStatus: string;
        }>;
      }
    ).domains;
    if (domains.length > 0) {
      domainsBlock = [
        `# Domains (${domains.length})`,
        "Use `propose_add_domain` for new hostnames, `propose_remove_domain` to drop. Use `domains.verify` (read-only DNS lookup) to preflight DNS resolution before proposing an add.",
        ...domains.map(
          (d) => `- ${d.hostname} (${d.kind}) — TLS=${d.tlsStatus} (id=${d.id.slice(0, 8)})`,
        ),
      ].join("\n");
    }
  }

  // P10A — load active skills + the user's pinned defaults + the
  // chat's manual overrides; resolve the engaged set; compose a
  // `## Engaged skills` system-prompt chunk + intersect tool
  // catalogue against the union of engaged skills' allowlists.
  let skillsBlock: string | undefined;
  let allowedToolNames: Set<string> | null = null;
  let engagedSkills: ChatEngagement[] = [];
  const skillsListResult = await execute(registry, adapter, humanCtx, "skills.list", {
    status: "active",
  });
  if (skillsListResult.ok) {
    const activeSkills = (
      skillsListResult.value as {
        skills: {
          id: string;
          slug: string;
          displayName: string;
          body: string;
          allowlistedTools: string[];
          hints: unknown;
        }[];
      }
    ).skills;
    const candidates: CandidateSkill[] = activeSkills.map((s) => {
      const parsed = skillAutoEngagementHints.safeParse(s.hints);
      return {
        id: s.id,
        slug: s.slug,
        displayName: s.displayName,
        hints: parsed.success ? parsed.data : { keywords: [], chipTrigger: false, alwaysOn: false },
      };
    });
    const autoMatches = matchSkills({
      userMessage: input.content,
      chipCount: input.chips.length,
      skills: candidates,
    });
    const pinnedR = await execute(registry, adapter, humanCtx, "skills.list_pin_defaults", {});
    const pinned = pinnedR.ok
      ? (
          pinnedR.value as {
            pinDefaults: { skillId: string; slug: string; displayName: string }[];
          }
        ).pinDefaults
      : [];
    // Manual overrides on the chat session row. NULL or {} → no overrides yet.
    const sessRows = (await adapter.rawAdmin().begin(async (tx) => {
      await tx.unsafe(`SET LOCAL caelo.actor_kind = 'system'`);
      return await tx`SELECT engaged_skills FROM chat_sessions
        WHERE id = ${input.chatSessionId}::uuid LIMIT 1`;
    })) as unknown as { engaged_skills: unknown }[];
    const stored = sessRows[0]?.engaged_skills;
    const manualOverrides: Array<{
      skillId: string;
      slug: string;
      displayName: string;
      intent: "engage" | "disengage";
    }> | null = Array.isArray(stored)
      ? (stored as {
          skillId: string;
          slug: string;
          displayName: string;
          intent: "engage" | "disengage";
        }[])
      : null;
    engagedSkills = resolveEngagements({
      autoMatches,
      manualOverrides,
      pinnedSkills: pinned,
    });

    if (engagedSkills.length > 0) {
      // Concatenate skill bodies, tagged with the slug + source so the
      // AI knows which guidance is which.
      const bodyById = new Map(activeSkills.map((s) => [s.id, s.body]));
      const lines = engagedSkills.map((e) => {
        const body = bodyById.get(e.skillId) ?? "";
        return `## Skill: ${e.slug} (${e.source}${e.rationale ? ` — ${e.rationale}` : ""})\n${body}`;
      });
      skillsBlock = ["# Engaged skills", ...lines].join("\n\n");

      // Allowlist intersection: when ANY engaged skill defines an
      // allowlist, the AI's tool catalogue narrows to the UNION of
      // those allowlists. When none do, the full catalogue stays.
      //
      // v0.2.48 — alwaysOn-only engagements DO NOT contribute to the
      // narrowing. An alwaysOn skill engages on every turn; if it
      // declares a narrow allowlist (e.g. brand-voice-guard's
      // [site_memory_propose]), every chat where no other skill
      // engages would be restricted to that single tool — the AI
      // ends up unable to do real work. alwaysOn allowlists are
      // treated as advisory: the skill body still loads, but tool
      // access stays wide.
      //
      // Detection: matchSkills sets `rationale = "always-on"` exactly
      // when only the alwaysOn flag fired (no chip trigger, no
      // keyword match). When other reasons fire, they're appended
      // with "; " separators, so any rationale ≠ "always-on"
      // indicates a real signal beyond the alwaysOn floor.
      const allowlists = engagedSkills
        .filter((e) => !(e.source === "auto" && e.rationale === "always-on"))
        .map((e) => activeSkills.find((s) => s.id === e.skillId)?.allowlistedTools ?? [])
        .filter((arr) => arr.length > 0);
      if (allowlists.length > 0) {
        allowedToolNames = new Set(allowlists.flat());
      }
    }
  }

  // v0.6.0 W1 — assemble ToolDescribeState from the layouts/templates/
  // site_defaults values we already fetched above for the system-prompt
  // blocks. Tools with optional describe() callbacks use this to emit
  // state-aware descriptions ("layoutId REQUIRED on fresh install"
  // instead of "layoutId optional"). Tools without describe() ignore
  // the state and use their static description.
  const toolDescribeState = buildToolDescribeState({
    actor: { actorId: aiCtx.actorId, actorKind: aiCtx.actorKind },
    layoutsValue: layoutsR.ok ? layoutsR.value : null,
    templatesValue: tplsR.ok ? tplsR.value : null,
    siteDefaultsValue: defaultsR.ok ? defaultsR.value : null,
    // v0.12.3 (issue #106) — feeds the per-page blockName enum.
    activePage: activePageForState,
  });

  // P10A skill allowlist intersection ∪ P10.5 subagent exclusion. The
  // exclusion list is how the spawn handler enforces the depth cap (it
  // passes {spawn_subagent, spawn_subagents}); chat-runner itself
  // doesn't branch on "is this a subagent."
  const excluded = options.excludedToolNames;
  const builtinTools = tools.catalogue(toolDescribeState).filter((t) => {
    if (allowedToolNames && !allowedToolNames.has(t.name)) return false;
    if (excluded?.has(t.name)) return false;
    return true;
  });
  // P11.5 commit 2 — fold Tier-1 plugin-registered tools into the catalogue.
  // Plugins declare their tools in `manifest.tools[]`; the host loader
  // registers them into `pluginToolsRegistry` at activation. The chat-runner
  // discovers them per turn so disabling a plugin removes its tools from
  // the AI's catalogue on the next call.
  const pluginTools = pluginToolsRegistry.list().filter(({ spec }) => {
    if (allowedToolNames && !allowedToolNames.has(spec.name)) return false;
    if (excluded?.has(spec.name)) return false;
    return true;
  });
  const filteredTools = [
    ...builtinTools,
    ...pluginTools.map(({ spec }) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputJsonSchema,
    })),
  ];

  // P10.5 #5 — subagents hint chunk. Emitted when (a) spawn tools are
  // visible in this turn's catalogue (so we never tell the AI to use
  // a tool it can't see — subagents themselves don't get the hint
  // because their own catalogue strips spawn_subagent) AND (b) the
  // user's message contains parallel-work cues OR an engaged skill
  // body mentions spawn_subagent. Pure text guidance; the AI decides
  // whether to act.
  let subagentsBlock: string | undefined;
  const spawnVisible =
    !excluded?.has("spawn_subagent") &&
    !excluded?.has("spawn_subagents") &&
    filteredTools.some((t) => t.name === "spawn_subagent" || t.name === "spawn_subagents");
  if (spawnVisible) {
    const lowered = input.content.toLowerCase();
    const cuewords = [
      "audit",
      "review",
      "in parallel",
      "fan out",
      "qa",
      "categorize",
      "categorise",
      "restructure",
      "draft an article",
      "write an article",
    ];
    const matched = cuewords.some((w) => lowered.includes(w));
    const skillMentionsSubagents = skillsBlock?.toLowerCase().includes("spawn_subagent");
    if (matched || skillMentionsSubagents) {
      subagentsBlock = [
        "# Subagents",
        "You can fan out parallel reasoning angles via `spawn_subagent` (single) or `spawn_subagents` (parallel batch). Each child is its own chat-runner turn with its own auto-engaged skill — its task wording drives which skill engages (e.g. role='qa', task='QA the article' → engages qa-check; role='menu-auditor' → engages menu-auditor).",
        "Use when the work has multiple distinct perspectives that benefit from isolated context (audit + propose, QA + legal + brand-voice, US-perspective + EU-perspective).",
        "DO NOT use for one-line edits or quick lookups — those are regular tool calls. Subagents earn their cost when each angle is multi-step.",
        "Each subagent returns a parsed verdict (or tree, or freeform). Ingest the results, then decide your next move.",
      ].join("\n");
    }
  }

  // P11 opt 4 — surface AI's own pending + rejected plugin submissions
  // so it doesn't re-propose what's already in the queue and reads
  // the Owner's rejection reason before resubmitting. Renders only
  // when at least one pending/rejected row exists.
  let pluginsBlock: string | undefined;
  try {
    const pendingResult = await execute(registry, adapter, aiCtx, "plugins.list_pending", {
      submittedBy: aiCtx.actorId,
    });
    if (pendingResult.ok) {
      const rows = (
        pendingResult.value as {
          plugins: Array<{
            slug: string;
            version: string;
            status: string;
            validationErrorCount: number;
            rejectionReason: string | null;
          }>;
        }
      ).plugins;
      if (rows.length > 0) {
        const lines = rows.map((p) => {
          if (p.status === "rejected") {
            return `- ${p.slug} v${p.version} — REJECTED${p.rejectionReason ? ` (reason: ${p.rejectionReason})` : ""}. Read the reason, revise, and submit a new version.`;
          }
          if (p.status === "draft") {
            return `- ${p.slug} v${p.version} — validation failed (${p.validationErrorCount} error${p.validationErrorCount === 1 ? "" : "s"}). Fix per the structured hints and resubmit.`;
          }
          return `- ${p.slug} v${p.version} — awaiting Owner approval at /security/plugins. DO NOT re-submit.`;
        });
        pluginsBlock = [
          "# Your pending plugin submissions",
          "These plugins you previously submitted are still in the queue. Do NOT re-submit duplicates; read the status before issuing a new submit_plugin call.",
          ...lines,
        ].join("\n");
      }
    }
  } catch {
    // Best-effort context block; never block the turn on a context-fetch failure.
  }

  // P11.5 audit fix #1 — render Tier-1 plugin promptContext blocks. Each
  // active plugin's `promptContext: [{label, render}]` array contributes
  // a slice; non-empty slices are concatenated into the system prompt.
  // Disabled plugins are filtered at the registry level.
  let pluginContextBlock: string | undefined;
  try {
    const blocks = await pluginPromptContextRegistry.renderAll();
    if (blocks.length > 0) pluginContextBlock = blocks.join("\n\n");
  } catch {
    // Best-effort: never block the turn on a renderer error.
  }

  const systemChunks = composeSystemPromptChunks(
    memory,
    filteredTools.map((t) => ({ name: t.name, description: t.description })),
    {
      chipsBlock,
      pageContextBlock,
      allPagesBlock,
      siteIdentityBlock,
      themeBlock,
      structuredSetsBlock,
      modulesBlock,
      contentLibraryBlock,
      layoutsBlock,
      siteDefaultsBlock,
      mediaBlock,
      redirectsBlock,
      localesBlock,
      pendingProposalsBlock,
      usersBlock,
      rolesBlock,
      aiProvidersBlock,
      domainsBlock,
      skillsBlock,
      subagentsBlock,
      pluginsBlock,
      pluginContextBlock,
    },
  );

  // AI calls all run with chatBranchId set so the snapshot lands tagged.
  const aiCtxWithBranch: ExecutionContext = {
    ...aiCtx,
    chatBranchId: session.session.chatBranchId,
    chatTaskId: input.chatSessionId,
  };

  let messages = [...baseMessages];
  let totalIn = 0;
  let totalOut = 0;
  let totalCached = 0;
  let succeeded = true;
  type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error" | "max_loops" | "session_gone";
  let stopReason: StopReason = "end_turn";
  let lastAssistantMessageId: string | null = null;
  // v0.3.20 — track the most recent loopStop so we can detect the
  // cap-exhaustion case (for-loop ran to completion without breaking
  // on end_turn / max_tokens / error). Without this, hitting maxLoops
  // looks identical to a normal end_turn finish — the UI shows no
  // signal, and the user thinks the AI just stopped for no reason.
  let lastLoopStop: StopReason | null = null;
  // issue #106 — one-shot guard for the passive-turn nudge (see
  // looksLikeAnnouncedAction). At most one automatic re-prompt per turn so
  // a model that stays passive can't spin the loop.
  let passiveNudged = false;

  for (let loop = 0; loop < maxLoops; loop++) {
    if (aborted()) break;
    const accumulatedText: string[] = [];
    const accumulatedToolCalls: { id: string; name: string; arguments: unknown }[] = [];
    // v0.2.54 — accumulate thinking blocks emitted on this turn for
    // persistence + round-trip on the next loop's provider call.
    const accumulatedThinking: { thinking: string; signature: string }[] = [];
    let loopStop: StopReason = "end_turn";

    let providerErr = false;
    // v0.10.17 — populated by the `done` event when the underlying
    // adapter forwards provider stop metadata. Read by the empty-
    // response detector below to log Anthropic's raw stop_reason etc.
    let stoppingDiagnostics: {
      rawFinishReason: string | null;
      warnings: unknown;
      providerMetadata: unknown;
      responseMessageId: string | null;
      responseModelId: string | null;
    } | null = null;
    for await (const ev of provider.generate({
      systemPrompt: systemChunks,
      messages,
      tools: filteredTools,
      abortSignal,
      maxTokens: options.maxOutputTokens ?? MAX_OUTPUT_TOKENS_DEFAULT,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(thinkingBudget !== null ? { thinking: { budgetTokens: thinkingBudget } } : {}),
    })) {
      if (aborted()) break;
      if (ev.kind === "text-delta") {
        accumulatedText.push(ev.text);
        yield { kind: "text-delta", text: ev.text };
      } else if (ev.kind === "thinking-delta") {
        // Stream-through: client renders progressively in the
        // collapsed thinking block. Final text is captured at
        // thinking-stop; mid-stream we don't accumulate here to avoid
        // double-buffering.
        yield { kind: "thinking-delta", text: ev.text };
      } else if (ev.kind === "thinking-stop") {
        accumulatedThinking.push({ thinking: ev.thinking, signature: ev.signature });
        yield { kind: "thinking-stop", thinking: ev.thinking, signature: ev.signature };
      } else if (ev.kind === "tool-call") {
        accumulatedToolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
      } else if (ev.kind === "usage") {
        totalIn += ev.inputTokens;
        totalOut += ev.outputTokens;
        totalCached += ev.cachedTokens;
        // P10.5 #3 — soft cost cap. spawn_subagent passes the spec's
        // maxCostMicrocents through; runner aborts before the next
        // provider call instead of letting the budget overrun.
        if (options.costCapMicrocents !== undefined) {
          const usdSoFar =
            ((totalIn - totalCached) / 1_000_000) * inputCost + (totalOut / 1_000_000) * outputCost;
          if (microcents(usdSoFar) > options.costCapMicrocents) {
            providerErr = true;
            succeeded = false;
            yield {
              kind: "error",
              message: `cost cap reached: spent ~${microcents(usdSoFar)} µ¢ / cap ${options.costCapMicrocents} µ¢`,
            };
          }
        }
      } else if (ev.kind === "done") {
        loopStop = ev.stopReason;
        // v0.10.17 — stash provider diagnostics so the empty-response
        // detector below can include them in stderr. These are the
        // ONLY fields that explain why the model returned empty
        // (Anthropic's stop_reason, SDK warnings, finishReason).
        if (ev.stoppingDiagnostics) {
          stoppingDiagnostics = ev.stoppingDiagnostics;
        }
      } else if (ev.kind === "error") {
        providerErr = true;
        succeeded = false;
        yield { kind: "error", message: ev.message };
      }
    }
    if (providerErr) {
      stopReason = "error";
      break;
    }

    const assistantContent = accumulatedText.join("");
    const assistantSave = await execute(registry, adapter, humanCtx, "chat.append_message", {
      chatSessionId: input.chatSessionId,
      role: "assistant",
      content: assistantContent,
      toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : null,
      // v0.2.54 — persist thinking blocks alongside the assistant
      // turn. chat.get_session reads them back; this turn's continuation
      // (after tool_results) replays them in the messages array so
      // Anthropic can verify the cryptographic signatures.
      thinkingBlocks: accumulatedThinking.length > 0 ? accumulatedThinking : null,
      status: aborted() ? "interrupted" : "complete",
    });
    if (assistantSave.ok) {
      lastAssistantMessageId = (assistantSave.value as { messageId: string }).messageId;
      yield {
        kind: "assistant-message-saved",
        messageId: lastAssistantMessageId,
      };
    } else {
      // PR #61 follow-up — chat.append_message returns the
      // `session_gone` sentinel when the session row vanished mid-stream
      // (user clicked Discard, the test harness reset fixtures, a
      // cascade delete fired). That's a normal race, not a bug. Log it
      // softly and terminate the loop without an SSE error banner — no
      // operator is on the other end of this stream anymore.
      const e = assistantSave.error;
      const isSessionGone = e.kind === "HandlerError" && e.message.startsWith("session_gone");
      if (isSessionGone) {
        console.warn("[chat-runner] session gone mid-stream; terminating quietly", {
          chatSessionId: input.chatSessionId,
        });
        stopReason = "session_gone";
        succeeded = false;
        break;
      }
      // v0.2.52 — Don't silently proceed to tool dispatch when the
      // anchor message wasn't persisted. Pre-v0.2.52 this branch
      // dropped through to tool-dispatch, tool rows persisted, and the
      // assistant text only existed in the browser's streamingText
      // state — on reload the AI message vanished while orphan tool
      // rows remained. Surfacing the persist failure as an SSE error
      // gives the operator a banner + Cloud Run a stderr breadcrumb.
      console.error("[chat-runner] failed to persist assistant message", {
        chatSessionId: input.chatSessionId,
        error: assistantSave.error,
      });
      const persistErrMsg = (() => {
        switch (e.kind) {
          case "UnknownOperation":
            return `unknown op: ${e.name}`;
          case "ValidationFailed":
            return `validation failed: ${JSON.stringify(e.issues)}`;
          case "ActorScopeRejected":
            return `actor scope rejected (${e.actorKind} on ${e.operation})`;
          case "RateLimited":
            return `rate limited on ${e.operation}`;
          case "RLSDenied":
            return `RLS denied on ${e.operation}: ${e.detail}`;
          case "HandlerError":
            return `${e.operation}: ${e.message}`;
          case "Locked":
            return `${e.operation}: ${e.message}`;
        }
      })();
      yield {
        kind: "error",
        message: `Failed to save assistant message: ${persistErrMsg}`,
      };
      stopReason = "error";
      succeeded = false;
      break;
    }

    // Update messages history for the potential next loop iteration.
    messages = [
      ...messages,
      {
        role: "assistant",
        content: assistantContent,
        toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
        // v0.2.54 — round-trip thinking blocks. Anthropic verifies
        // the signatures on the next provider call when this turn
        // is followed by tool_results; stripping returns 400.
        ...(accumulatedThinking.length > 0 ? { thinkingBlocks: accumulatedThinking } : {}),
      },
    ];

    // v0.2.55 — Per-loop trace for postmortem. Cloud Run captures
    // stdout/stderr; grep the chatSessionId to reconstruct exactly
    // what happened across loops. Rationale: operators repeatedly
    // hit "AI does step 1, says 'now I'll do step 2', then stops".
    // The pattern is the model emitting end_turn after a tool result
    // — invisible from the UI and previously silent in logs.
    // v0.2.57 — bumped to console.error so Bun + SvelteKit's stdout
    // path (which swallows console.info / console.log in production)
    // doesn't drop it. Severity=ERROR in Cloud Logging is loud but
    // beats invisibility.
    console.error("[chat-runner] loop", {
      chatSessionId: input.chatSessionId,
      loop,
      loopStop,
      toolCalls: accumulatedToolCalls.length,
      // PR #61 follow-up — surface tool NAMES (not just count) so
      // admin.log inspection during e2e debugging can answer "which
      // tools did the AI actually call on this loop?" without having
      // to grep the chat_messages table after the run. Names only
      // (no args) keeps the log line bounded.
      toolNames: accumulatedToolCalls.map((c) => c.name),
      textChars: accumulatedText.join("").length,
      thinkingBlocks: accumulatedThinking.length,
      tokensIn: totalIn,
      tokensOut: totalOut,
    });

    // v0.10.16 — narrow the v0.5.9 passive-response detector to the
    // genuinely-broken case only. Original v0.5.9 surfaced a warning
    // whenever the AI ended its first loop without calling any tool —
    // intended to catch "AI describes work but doesn't do it." But
    // text-only is ALSO the right answer when the AI asks a
    // clarifying question ("Want me to build out sections 01-05?")
    // or summarizes findings; the warning then fired as a false
    // positive on every legitimate question-asking turn and trained
    // operators to ignore it.
    //
    // New rule: only warn when the AI returned NOTHING — 0 text +
    // 0 thinking + 0 tools. That's the actual broken case (provider
    // glitch, rate-limit, internal filter) and worth surfacing.
    // Legitimate text-only replies pass through silently.
    if (loop === 0 && accumulatedToolCalls.length === 0 && loopStop === "end_turn" && !aborted()) {
      const textChars = accumulatedText.join("").length;
      const thinkingChars = accumulatedThinking.reduce(
        (sum, t) => sum + (t.thinking?.length ?? 0),
        0,
      );
      if (textChars + thinkingChars === 0) {
        // v0.10.17 — log provider-side stop diagnostics so we can
        // identify why the model returned empty. Without this we see
        // only loopStop='end_turn' + zero output, which is ambiguous:
        //   - Anthropic stop_reason 'refusal' → safety filter
        //   - Anthropic stop_reason 'pause_turn' → 200k context exhausted mid-turn
        //   - Vercel SDK finishReason 'content-filter' → blocked
        //   - SDK warnings about malformed messages → history bug
        //   - All four together null → genuine provider hiccup (retry)
        console.error("[chat-runner] empty-response", {
          chatSessionId: input.chatSessionId,
          tokensIn: totalIn,
          tokensOut: totalOut,
          rawFinishReason: stoppingDiagnostics?.rawFinishReason ?? null,
          providerMetadata: stoppingDiagnostics?.providerMetadata ?? null,
          warnings: stoppingDiagnostics?.warnings ?? null,
          responseMessageId: stoppingDiagnostics?.responseMessageId ?? null,
          responseModelId: stoppingDiagnostics?.responseModelId ?? null,
        });
        yield {
          kind: "warning",
          code: "empty-response",
          message:
            "The AI returned an empty response — likely a provider transient (rate limit, safety filter, or internal error). Resend your last message; if it persists, start a fresh chat.",
        };
      }
      // v0.10.21 — widened diagnostic. When the AI emitted SOME text
      // but still zero tool calls on loop 0, log stoppingDiagnostics
      // anyway. No user-facing warning (that's the v0.10.16 noise
      // we deliberately removed) — just stderr so the next time an
      // operator reports "the AI said 'I'll look up X' and then
      // stopped," we have Anthropic's raw stop_reason in Cloud Run
      // logs to distinguish:
      //   - end_turn after intent text → model gave up planning
      //     (usually fixable by improving the system prompt)
      //   - refusal → safety filter triggered mid-stream
      //   - pause_turn → context window exhausted
      //   - SDK warnings → message-array shape bug
      else if (textChars > 0) {
        console.error("[chat-runner] passive-response-diag", {
          chatSessionId: input.chatSessionId,
          tokensIn: totalIn,
          tokensOut: totalOut,
          textChars,
          thinkingChars,
          rawFinishReason: stoppingDiagnostics?.rawFinishReason ?? null,
          providerMetadata: stoppingDiagnostics?.providerMetadata ?? null,
          warnings: stoppingDiagnostics?.warnings ?? null,
          responseMessageId: stoppingDiagnostics?.responseMessageId ?? null,
          responseModelId: stoppingDiagnostics?.responseModelId ?? null,
        });
      }
      // else: AI replied with thinking-only or empty + thinking >0
      // — covered by the empty branch above (textChars + thinking
      // === 0 captures the all-zero case; mixed cases are rare and
      // not worth a third branch).
    }

    if (aborted()) break;
    lastLoopStop = loopStop;
    if (loopStop !== "tool_use" || accumulatedToolCalls.length === 0) {
      // issue #106 — passive-turn recovery (CLAUDE.md §4). The model
      // sometimes narrates an imminent action ("...adding the footer
      // now.") and then ends the turn WITHOUT emitting the tool call
      // (loopStop='end_turn', zero tool calls) — the footer-path
      // regression step 13 caught, where the operator had to type
      // "go ahead" to get the add_module_to_layout call to fire. Nudge
      // once and re-run. The nudge rides in-memory only (never persisted),
      // so the visible chat shows the model self-correcting into the real
      // tool call rather than a synthetic operator turn. Gated to a single
      // retry, to turns with tools available, and to commitment-to-act text
      // (not clarifying questions) so it never re-creates the v0.5.9
      // false-positive noise on legitimate text-only replies.
      if (
        !passiveNudged &&
        loopStop === "end_turn" &&
        accumulatedToolCalls.length === 0 &&
        filteredTools.length > 0 &&
        !aborted() &&
        looksLikeAnnouncedAction(accumulatedText.join(""))
      ) {
        passiveNudged = true;
        console.error("[chat-runner] passive-action-nudge", {
          chatSessionId: input.chatSessionId,
          textChars: accumulatedText.join("").length,
          rawFinishReason: stoppingDiagnostics?.rawFinishReason ?? null,
        });
        messages = [...messages, { role: "user", content: PASSIVE_ACTION_NUDGE }];
        continue;
      }
      stopReason = loopStop;
      break;
    }

    // Dispatch each tool call sequentially and append a tool result.
    // P5.2 #3 — dedupe by (chat_session_id, tool_call_id).
    for (const call of accumulatedToolCalls) {
      if (aborted()) break;
      yield {
        kind: "tool-start",
        toolCallId: call.id,
        name: call.name,
        arguments: call.arguments,
      };

      const cachedLookup = await execute(registry, adapter, humanCtx, "chat.lookup_tool_result", {
        chatSessionId: input.chatSessionId,
        toolCallId: call.id,
      });
      const cachedHit =
        cachedLookup.ok &&
        (cachedLookup.value as { cached: { ok: boolean; content: string } | null }).cached;

      let result: {
        ok: boolean;
        content: string;
        image?: {
          base64: string;
          mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
        };
        // v0.6.0 W3 — propagated from ToolResult.nextAction so the
        // auto-recovery branch can inspect the structured recovery hint.
        nextAction?: {
          tool: string;
          args?: Record<string, unknown>;
          reason: string;
          autoExecute?: boolean;
          retryWithArgs?: { argName: string; fromValuePath: string };
        };
        // v0.6.0 alpha.2 — structured payload propagated from
        // ToolResult.value. Consumed by the W3 retry path to
        // extract a field at nextAction.retryWithArgs.fromValuePath.
        value?: unknown;
      };
      if (cachedHit) {
        result = {
          ok: cachedHit.ok,
          content: cachedHit.content,
        };
        yield { kind: "tool-result-cached", toolCallId: call.id };
      } else {
        // P10.5 #1 — buffer + waker so the spawn handler can stream
        // child events to the parent's generator while its dispatch is
        // still in flight. Tool handlers that don't push events leave
        // the queue empty and the loop is a no-op.
        const eventBuffer: ClientEvent[] = [];
        let resolveWaker: (() => void) | null = null;
        const wakeReader = (): void => {
          const r = resolveWaker;
          resolveWaker = null;
          r?.();
        };
        const pushClientEvent = (event: unknown): void => {
          eventBuffer.push(event as ClientEvent);
          wakeReader();
        };

        // P11.5 commit 2 — Tier-1 plugin tools route through plugin-host's
        // runPluginOperation. Built-in tools fall through to tools.dispatch.
        const pluginTool = pluginToolsRegistry.resolve(call.name);
        type DispatchValue = {
          ok: boolean;
          content: string;
          image?: {
            base64: string;
            mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
          };
          // v0.6.0 W3 — propagated from ToolResult.nextAction so the
          // auto-recovery branch below can read it without an extra cast.
          nextAction?: {
            tool: string;
            args?: Record<string, unknown>;
            reason: string;
            autoExecute?: boolean;
            retryWithArgs?: { argName: string; fromValuePath: string };
          };
          // v0.6.0 alpha.2 — see ToolResult.value.
          value?: unknown;
        };
        const dispatchPromise: Promise<DispatchValue> = pluginTool
          ? runPluginOperation({
              pluginSlug: pluginTool.pluginSlug,
              operationName: pluginTool.spec.operationName,
              args: call.arguments,
            }).then((r) =>
              r.ok
                ? { ok: true, content: JSON.stringify(r.value) }
                : { ok: false, content: `${r.error.kind}: ${r.error.message}` },
            )
          : tools.dispatch(call.name, call.arguments, aiCtxWithBranch, {
              adapter,
              registry,
              chatSessionId: input.chatSessionId,
              chatBranchId: session.session.chatBranchId,
              // P10.5 — expose provider + tools + humanCtx + a child-turn
              // factory so the spawn_subagent handler can invoke runChatTurn
              // recursively for the child without a circular import. The
              // factory always passes excludedToolNames including the spawn
              // tools, so the depth cap is enforced by configuration, not a
              // runtime branch.
              provider,
              tools,
              humanCtx,
              pushClientEvent,
              spawnChildChatTurn: ({
                chatInput,
                aiCtx: childAiCtx,
                humanCtx: childHumanCtx,
                excludedToolNames,
                costCapMicrocents,
                abortSignal: childAbort,
              }) =>
                runChatTurn(
                  {
                    adapter,
                    registry,
                    provider,
                    tools,
                    aiCtx: childAiCtx,
                    humanCtx: childHumanCtx,
                    inputCostPerMTok: options.inputCostPerMTok,
                    outputCostPerMTok: options.outputCostPerMTok,
                    maxToolLoops: options.maxToolLoops,
                    excludedToolNames,
                    costCapMicrocents,
                    abortSignal: childAbort,
                  },
                  chatInput,
                ),
            });
        let dispatchDone = false;
        const finalDispatch = dispatchPromise.then(
          (r) => {
            dispatchDone = true;
            wakeReader();
            return { ok: true as const, value: r };
          },
          (e: unknown) => {
            dispatchDone = true;
            wakeReader();
            return { ok: false as const, error: e };
          },
        );

        // Drain the event buffer concurrently with the dispatch.
        while (!dispatchDone || eventBuffer.length > 0) {
          while (eventBuffer.length > 0) {
            const ev = eventBuffer.shift();
            if (ev) yield ev;
          }
          if (!dispatchDone) {
            await new Promise<void>((resolve) => {
              resolveWaker = resolve;
            });
          }
        }
        const settled = await finalDispatch;
        if (settled.ok) {
          result = settled.value;
          // v0.6.0 W3 — auto-recover from structured failures. When a
          // bootstrap-flow op fails with `nextAction.autoExecute=true`
          // and the suggested tool is read-only, the helper dispatches
          // the recovery + (optionally) re-dispatches the original
          // with rewritten args. AI sees a clean result in either
          // success-with-retry or fold-into-content shape. See
          // auto-recovery.ts for the full flow + safety guards.
          if (!result.ok && result.nextAction?.autoExecute) {
            result = await tryAutoRecover({
              failed: result,
              originalCall: { name: call.name, arguments: call.arguments },
              tools,
              aiCtx: aiCtxWithBranch,
              toolCtx: {
                adapter,
                registry,
                chatSessionId: input.chatSessionId,
                chatBranchId: session.session.chatBranchId,
                provider,
                tools,
                humanCtx,
              },
              chatSessionId: input.chatSessionId,
            });
          }
        } else {
          // v0.2.52 — A tool handler rejected (Zod runtime, plugin error,
          // DB constraint, "Cannot read X of undefined"). Surface as a
          // failed tool_result instead of aborting the turn: the AI sees
          // the failure on the next provider call and decides whether to
          // retry, switch tools, or give up gracefully. Pre-v0.2.52 this
          // line threw, the generator aborted mid-loop, the SSE handler
          // caught + emitted error+done, and tool_result rows for the
          // failing + remaining tools were never persisted. Stderr is
          // captured by Cloud Run so the next regression in this class is
          // debuggable from logs alone.
          console.error("[chat-runner] tool dispatch threw", {
            chatSessionId: input.chatSessionId,
            toolName: call.name,
            toolCallId: call.id,
            error: settled.error,
          });
          const errMsg =
            settled.error instanceof Error ? settled.error.message : String(settled.error);
          result = { ok: false, content: `tool error: ${errMsg}` };
        }
        await execute(registry, adapter, humanCtx, "chat.cache_tool_result", {
          chatSessionId: input.chatSessionId,
          toolCallId: call.id,
          toolName: call.name,
          ok: result.ok,
          content: result.content,
        });
      }

      yield {
        kind: "tool-result",
        toolCallId: call.id,
        ok: result.ok,
        content: result.content,
      };
      await execute(registry, adapter, humanCtx, "chat.append_message", {
        chatSessionId: input.chatSessionId,
        role: "tool",
        content: result.content,
        toolCallId: call.id,
      });
      messages.push({ role: "tool", content: result.content, toolCallId: call.id });
      // v0.3.0 — when the tool returned an image (screenshot_page is
      // the only producer today), append a multimodal user message
      // so the AI sees the image alongside the text result on its
      // next provider call. Image content is NOT persisted to
      // chat_messages — it's runtime-only. After publish, the chat
      // history shows only the text result; the image was consumed
      // by the AI for that turn.
      if (result.image) {
        messages.push({
          role: "user",
          content: `[Screenshot returned by ${call.name}; analyse it for the operator's request.]`,
          additionalContent: [
            { type: "image", base64: result.image.base64, mediaType: result.image.mediaType },
          ],
        });
      }
    }
  }

  // v0.3.20 — cap-exhaustion notice. If the for-loop ran to completion
  // (i.e. didn't break) AND the last iteration ended with the AI still
  // wanting to call more tools, we hit `maxLoops`. Surface a clear
  // user-visible message so the chat doesn't appear to silently die.
  // The user can reply "continue" to resume the build in a fresh turn.
  if (lastLoopStop === "tool_use" && !aborted()) {
    stopReason = "max_loops";
    const notice =
      `Paused at the tool-loop limit (${maxLoops} iterations). The build was still in progress — ` +
      `reply "continue" to resume.`;
    console.error("[chat-runner] max_loops cap hit", {
      chatSessionId: input.chatSessionId,
      maxLoops,
    });
    yield { kind: "text-delta", text: notice };
    const noticeSave = await execute(registry, adapter, humanCtx, "chat.append_message", {
      chatSessionId: input.chatSessionId,
      role: "assistant",
      content: notice,
      status: "complete",
    });
    if (noticeSave.ok) {
      lastAssistantMessageId = (noticeSave.value as { messageId: string }).messageId;
      yield { kind: "assistant-message-saved", messageId: lastAssistantMessageId };
    }
  }

  if (aborted() && lastAssistantMessageId) {
    await execute(registry, adapter, humanCtx, "chat.mark_message_interrupted", {
      messageId: lastAssistantMessageId,
    });
  }

  const usdCost = (totalIn / 1_000_000) * inputCost + (totalOut / 1_000_000) * outputCost;
  yield {
    kind: "usage",
    inputTokens: totalIn,
    outputTokens: totalOut,
    cachedTokens: totalCached,
    cost: usdCost,
  };

  await execute(registry, adapter, humanCtx, "chat.record_ai_call", {
    chatSessionId: input.chatSessionId,
    provider: provider.name,
    model: provider.model,
    inputTokens: totalIn,
    outputTokens: totalOut,
    cachedTokens: totalCached,
    // P16 — cost lookup happens inside the op via ai_pricing table.
    // Chat-runner's `microcents(usdCost)` is kept only for the
    // streaming `usage` event above + soft cap pre-flight; the DB row
    // gets the canonical price from the pricing table so a mid-month
    // rate update doesn't silently mis-cost active chats.
    durationMs: Date.now() - startedAt,
    succeeded: succeeded && stopReason !== "error" && !aborted(),
    // P10.5 — when this turn is a subagent invocation, the spawn
    // handler put the parent attribution on the aiCtx. Existing
    // ai_calls writer already takes them as input.
    parentChatSessionId: aiCtx.parentChatSessionId,
    parentAiCallId: aiCtx.parentAiCallId,
    // P16 — request_id flows through aiCtx if hooks.server.ts threaded it.
    requestId: aiCtx.requestId ?? null,
  });

  if (aborted()) {
    yield { kind: "interrupted", messageId: lastAssistantMessageId };
  }
  yield { kind: "done" };
}

// v0.6.0 alpha.4 Fix W — extractAtPath + the W3 retry logic moved
// to packages/admin-core/src/ai/auto-recovery.ts.
