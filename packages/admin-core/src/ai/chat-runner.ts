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

import type { DatabaseAdapter, OperationRegistry } from "@caelo/query-api";
import { execute } from "@caelo/query-api";
import type { ChatSendMessageInput, ExecutionContext } from "@caelo/shared";

import type { AIProvider, ChatMessageInput } from "./provider.js";
import { composeSystemPromptChunks } from "./system-prompt.js";
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
  | { kind: "error"; message: string };

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
}

const DEFAULT_INPUT_COST_PER_M = 15; // Opus 4.7 input rate, USD per 1M tokens
const DEFAULT_OUTPUT_COST_PER_M = 75;

function microcents(usd: number): number {
  // 1 USD = 1e8 microcents.
  return Math.round(usd * 1e8);
}

export async function* runChatTurn(
  options: ChatRunnerOptions,
  input: ChatSendMessageInput,
): AsyncIterable<ClientEvent> {
  const { adapter, registry, provider, tools, aiCtx, humanCtx, abortSignal } = options;
  const inputCost = options.inputCostPerMTok ?? DEFAULT_INPUT_COST_PER_M;
  const outputCost = options.outputCostPerMTok ?? DEFAULT_OUTPUT_COST_PER_M;
  const maxLoops = options.maxToolLoops ?? 5;
  const startedAt = Date.now();
  const aborted = (): boolean => abortSignal?.aborted === true;

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
    session: { chatBranchId: string };
    messages: {
      role: "user" | "assistant" | "tool";
      content: string;
      toolCalls: unknown;
      toolCallId: string | null;
    }[];
  };

  // Provider message history is everything in the chat now (the user
  // message we just appended is in there too).
  const baseMessages: ChatMessageInput[] = session.messages.map((m) => ({
    role: m.role,
    content: m.content,
    toolCalls: Array.isArray(m.toolCalls)
      ? (m.toolCalls as { id: string; name: string; arguments: unknown }[])
      : undefined,
    toolCallId: m.toolCallId ?? undefined,
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
  if (input.activePageId) {
    const pageR = await execute(registry, adapter, humanCtx, "pages.get_with_modules", {
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
        `Blocks (in render order): ${v.page.blocks.map((b) => b.blockName).join(", ") || "(none)"}`,
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
        "- set_nav_menu(slug, displayName, items) — replace a navigation menu by slug (`nav-menu` kind). Common slugs: `header-main`, `footer-main`. Pass the FULL desired item list (op replaces, not appends). For non-menu structured sets (taxonomies, tags, link lists, theme tokens), use `set_structured_set` instead.",
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
  const allPagesR = await execute(registry, adapter, humanCtx, "pages.list", {});
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
        }[];
      }
    ).pages;
    if (ps.length > 0) {
      allPagesBlock = [
        "# All pages on this site",
        "Use these (slug, locale) pairs as link targets — never invent a URL.",
        ...ps.map(
          (p) =>
            `- id=${p.id} name="${p.name}" title="${p.title}" url=${p.locale === "en" ? `/${p.slug}` : `/${p.locale}/${p.slug}`} status=${p.status}`,
        ),
      ].join("\n");
    }
  }

  let themeBlock: string | undefined;
  const themeR = await execute(registry, adapter, humanCtx, "structured_sets.get", {
    kind: "theme",
    slug: "site",
  });
  if (themeR.ok) {
    const set = (themeR.value as { set: { items: unknown } | null }).set;
    if (set && Array.isArray(set.items) && set.items.length > 0) {
      const tokens = set.items as { token: string; value: string }[];
      themeBlock = [
        "# Theme tokens (CSS variables on :root)",
        "Use `var(--<token>)` in generated HTML/CSS instead of raw hex codes when the user wants brand-consistent colors / fonts.",
        ...tokens.map((t) => `- --${t.token}: ${t.value}`),
        "",
        "Update with the `update_theme` tool: update_theme({tokens: {colorPrimary: '#0066ff'}}).",
      ].join("\n");
    }
  }

  let structuredSetsBlock: string | undefined;
  const setsR = await execute(registry, adapter, humanCtx, "structured_sets.list", {});
  if (setsR.ok) {
    const sets = (
      setsR.value as {
        sets: { kind: string; slug: string; displayName: string; items: unknown }[];
      }
    ).sets.filter((s) => s.kind !== "theme");
    if (sets.length > 0) {
      structuredSetsBlock = [
        "# Structured-data sets you can edit",
        "Each is a typed named list. Use `set_structured_set` to replace a set's items.",
        ...sets.map((s) => {
          const items = Array.isArray(s.items) ? (s.items as unknown[]) : [];
          return `- ${s.kind}/${s.slug} ("${s.displayName}") — ${items.length} item${items.length === 1 ? "" : "s"}`;
        }),
      ].join("\n");
    }
  }

  // P6.7.6 — layouts (site-wide chrome) + site_defaults so the AI knows
  // which layout/template to use when creating a page and which tool
  // surface (page / template / layout) is appropriate for a given
  // change request.
  let layoutsBlock: string | undefined;
  let siteDefaultsBlock: string | undefined;
  const layoutsR = await execute(registry, adapter, humanCtx, "layouts.list", {
    includeDeleted: false,
  });
  const tplsR = await execute(registry, adapter, humanCtx, "templates.list", {
    includeDeleted: false,
  });
  const defaultsR = await execute(registry, adapter, humanCtx, "site_defaults.get", {});
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
        ...layouts.map(
          (l) =>
            `- ${l.slug} ("${l.displayName}") — blocks: ${l.blocks.map((b) => b.name).join(", ")}`,
        ),
        "",
        "Three add-module surfaces — pick by intent:",
        "- one page only        → `add_module_to_page`",
        "- every page on a template → `add_module_to_template`",
        "- every page on the site (or a whole layout) → `add_module_to_layout` (e.g. layoutSlug='site-default', blockName='footer')",
        "",
        "`create_layout` and `set_site_defaults` are Owner-only — AI calls reject; surface the permission requirement instead of trying again.",
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
    const templateLines = tpls.map(
      (t) => `- ${t.slug} → ${layoutBySlug.get(t.layoutId) ?? "(unknown layout)"}`,
    );
    siteDefaultsBlock = [
      "# Site defaults (used when caller omits a layout/template)",
      defaults
        ? `- default layout: ${defaults.defaultLayoutSlug}\n- default template: ${defaults.defaultTemplateSlug}`
        : "- (none configured yet — Owner can set via /security/site-defaults)",
      "",
      "# Templates → layouts",
      ...(templateLines.length > 0 ? templateLines : ["- (no templates yet)"]),
    ].join("\n");
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

  const systemChunks = composeSystemPromptChunks(
    memory,
    tools.catalogue().map((t) => ({ name: t.name, description: t.description })),
    {
      chipsBlock,
      pageContextBlock,
      allPagesBlock,
      themeBlock,
      structuredSetsBlock,
      layoutsBlock,
      siteDefaultsBlock,
      mediaBlock,
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
  type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error";
  let stopReason: StopReason = "end_turn";
  let lastAssistantMessageId: string | null = null;

  for (let loop = 0; loop < maxLoops; loop++) {
    if (aborted()) break;
    const accumulatedText: string[] = [];
    const accumulatedToolCalls: { id: string; name: string; arguments: unknown }[] = [];
    let loopStop: StopReason = "end_turn";

    let providerErr = false;
    for await (const ev of provider.generate({
      systemPrompt: systemChunks,
      messages,
      tools: tools.catalogue(),
      abortSignal,
    })) {
      if (aborted()) break;
      if (ev.kind === "text-delta") {
        accumulatedText.push(ev.text);
        yield { kind: "text-delta", text: ev.text };
      } else if (ev.kind === "tool-call") {
        accumulatedToolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
      } else if (ev.kind === "usage") {
        totalIn += ev.inputTokens;
        totalOut += ev.outputTokens;
        totalCached += ev.cachedTokens;
      } else if (ev.kind === "done") {
        loopStop = ev.stopReason;
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
      status: aborted() ? "interrupted" : "complete",
    });
    if (assistantSave.ok) {
      lastAssistantMessageId = (assistantSave.value as { messageId: string }).messageId;
      yield {
        kind: "assistant-message-saved",
        messageId: lastAssistantMessageId,
      };
    }

    // Update messages history for the potential next loop iteration.
    messages = [
      ...messages,
      {
        role: "assistant",
        content: assistantContent,
        toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
      },
    ];

    if (aborted()) break;
    if (loopStop !== "tool_use" || accumulatedToolCalls.length === 0) {
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

      let result: { ok: boolean; content: string };
      if (cachedHit) {
        result = {
          ok: cachedHit.ok,
          content: cachedHit.content,
        };
        yield { kind: "tool-result-cached", toolCallId: call.id };
      } else {
        result = await tools.dispatch(call.name, call.arguments, aiCtxWithBranch, {
          adapter,
          registry,
          chatSessionId: input.chatSessionId,
          chatBranchId: session.session.chatBranchId,
        });
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
    costEstimateMicrocents: microcents(usdCost),
    durationMs: Date.now() - startedAt,
    succeeded: succeeded && stopReason !== "error" && !aborted(),
  });

  if (aborted()) {
    yield { kind: "interrupted", messageId: lastAssistantMessageId };
  }
  yield { kind: "done" };
}
