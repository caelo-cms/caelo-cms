// SPDX-License-Identifier: MPL-2.0

/**
 * `query_page_html` — pull SPECIFIC structure out of a page without ever
 * putting the whole HTML in the main chat's context
 * (docs/inspect-tooling-redesign.md §2.2).
 *
 * Four modes (exactly one per call):
 *   - `keyword`     — deterministic text search; returns the HTML window(s)
 *                     around each match (snapped to tag boundaries).
 *   - `cssSelector` /
 *     `xpath`       — return matching elements' outerHTML, via the reused
 *                     Playwright page (setContent on the cached HTML — no
 *                     re-fetch). Needs Playwright; falls back with a clear
 *                     message when absent.
 *   - `describe`    — natural language ("the pricing table", "each product
 *                     card's title + price"). A SMALL model (Haiku) reads the
 *                     cached HTML one-shot and returns only the extraction.
 *                     This replaces a separate large-HTML subagent: the big
 *                     HTML lives in the cheap model's single call, not the
 *                     parent chat.
 *
 * `pageRef` (from a prior inspect_external_page) is the primary input —
 * the cached page is reused with NO re-fetch. `url` is the fallback:
 * fetch on demand (spends the external-fetch budget) and cache it.
 */

import { execute } from "@caelo-cms/query-api";
import { isExternalUrlBlockedError, safeExternalFetch } from "@caelo-cms/site-importer";
import { z } from "zod";
import { getActiveProviderForModel } from "../provider-resolver.js";
import { externalFetchAllowedHosts, takeExternalFetchBudget } from "./_external-fetch-budget.js";
import { getExternalScreenshotter } from "./_external-screenshotter.js";
import { getPageInspection, putPageInspection } from "./_page-inspection-cache.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

/** The cheap extraction model for `describe`. Anthropic Haiku 4.5. */
const SMALL_MODEL = "claude-haiku-4-5";
/** HTML handed to the small model is capped so it fits comfortably. */
const DESCRIBE_HTML_CAP = 150_000;
const DEFAULT_MAX_MATCHES = 5;
const DEFAULT_CONTEXT_CHARS = 800;

const input = z
  .object({
    pageRef: z.string().min(1).optional(),
    url: z.string().url().optional(),
    keyword: z.string().min(1).optional(),
    cssSelector: z.string().min(1).optional(),
    xpath: z.string().min(1).optional(),
    describe: z.string().min(1).optional(),
    maxMatches: z.number().int().positive().max(20).optional(),
    contextChars: z.number().int().positive().max(4000).optional(),
  })
  .strict();
type Input = z.infer<typeof input>;

/** Text search → HTML windows around each hit, snapped to tag boundaries. */
export function keywordWindows(
  html: string,
  keyword: string,
  maxMatches: number,
  contextChars: number,
): string[] {
  const out: string[] = [];
  const lower = html.toLowerCase();
  const kw = keyword.toLowerCase();
  let from = 0;
  while (out.length < maxMatches) {
    const idx = lower.indexOf(kw, from);
    if (idx === -1) break;
    let start = Math.max(0, idx - contextChars);
    let end = Math.min(html.length, idx + kw.length + contextChars);
    // Snap outward to the nearest tag boundary so we don't cut mid-tag.
    const lt = html.lastIndexOf("<", start);
    if (lt !== -1 && start - lt < contextChars) start = lt;
    const gt = html.indexOf(">", end - 1);
    if (gt !== -1 && gt - end < contextChars) end = gt + 1;
    out.push(html.slice(start, end));
    from = idx + kw.length;
  }
  return out;
}

/** Resolve the page HTML: cached pageRef (no re-fetch) or fetch the url. */
async function resolveHtml(
  toolInput: Input,
  sessionId: string,
): Promise<{ ok: true; url: string; html: string } | { ok: false; content: string }> {
  if (toolInput.pageRef) {
    const cached = getPageInspection(toolInput.pageRef);
    if (cached) {
      // Prefer the rendered (JS-applied) DOM when a screenshot/tokens
      // render populated it; fall back to the static fetched HTML.
      return { ok: true, url: cached.url, html: cached.renderedHtml ?? cached.html };
    }
    if (!toolInput.url) {
      return {
        ok: false,
        content: `query_page_html: page handle "${toolInput.pageRef}" is not cached (expired). Pass a \`url\` too, or re-run inspect_external_page.`,
      };
    }
  }
  if (!toolInput.url) {
    return { ok: false, content: "query_page_html requires a `pageRef` or a `url`." };
  }
  const budget = takeExternalFetchBudget(sessionId);
  if (!budget.ok) {
    return {
      ok: false,
      content:
        "External-fetch budget exhausted for this session. Reuse a `pageRef` from a prior inspect_external_page instead of re-fetching.",
    };
  }
  const allowedHosts = externalFetchAllowedHosts();
  try {
    const res = await safeExternalFetch(toolInput.url, { allowedHosts, maxBytes: 2 * 1024 * 1024 });
    if (!res.ok) {
      return {
        ok: false,
        content: `query_page_html: ${toolInput.url} answered HTTP ${res.status}.`,
      };
    }
    if (!res.contentType.includes("text/html")) {
      return { ok: false, content: `query_page_html: ${toolInput.url} is not an HTML page.` };
    }
    // Cache so a follow-up query/read reuses it.
    putPageInspection(sessionId, { url: res.finalUrl, html: res.bodyText, markdown: "" });
    return { ok: true, url: res.finalUrl, html: res.bodyText };
  } catch (e) {
    if (isExternalUrlBlockedError(e)) return { ok: false, content: e.message };
    return {
      ok: false,
      content: `query_page_html could not fetch ${toolInput.url}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

const DESCRIBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["found", "result"],
  properties: {
    found: {
      type: "boolean",
      description: "Whether the requested content is present on the page.",
    },
    result: {
      type: "string",
      description:
        "The extracted HTML fragment(s) verbatim (or the extracted info if that's what was asked). Empty string when found=false.",
    },
  },
} as const;

export const queryPageHtmlTool: ToolDefinitionWithHandler<Input> = {
  name: "query_page_html",
  description:
    "Pull a SPECIFIC part of an external page's HTML — without loading the whole page into context. Reuses a `pageRef` from a prior inspect_external_page (no re-fetch); pass `url` only if you have no handle. " +
    'Pick ONE mode: `keyword` (exact text — HTML around each hit), `cssSelector` / `xpath` (return matching elements\' outerHTML), or `describe` (natural language like "the pricing table" or "each product card\'s title + price" — a small fast model reads the full HTML and returns just that, so the big HTML never enters your context). ' +
    "Use this instead of inspect_external_page's `markup` facet when you need one section, not the whole page.",
  schema: input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pageRef: {
        type: "string",
        description: "Handle from a prior inspect_external_page (preferred — no re-fetch).",
      },
      url: {
        type: "string",
        description: "Absolute public URL — fallback when you have no pageRef.",
      },
      keyword: {
        type: "string",
        description: "Exact text to locate; returns the HTML window(s) around each hit.",
      },
      cssSelector: {
        type: "string",
        description: "CSS selector; returns matching elements' outerHTML (needs Playwright).",
      },
      xpath: {
        type: "string",
        description: "XPath expression; returns matching elements' outerHTML (needs Playwright).",
      },
      describe: {
        type: "string",
        description:
          "Natural-language description of what you need (e.g. 'the main nav structure', 'the pricing table'). A small model extracts it from the full HTML and returns only that.",
      },
      maxMatches: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "keyword mode: max windows (default 5).",
      },
      contextChars: {
        type: "integer",
        minimum: 1,
        maximum: 4000,
        description: "keyword mode: chars around each hit (default 800).",
      },
    },
  },
  handler: async (_ctx, toolInput, toolCtx) => {
    const modes = [
      toolInput.keyword,
      toolInput.cssSelector,
      toolInput.xpath,
      toolInput.describe,
    ].filter((m) => m !== undefined);
    if (modes.length !== 1) {
      return {
        ok: false,
        content:
          "query_page_html needs EXACTLY ONE of `keyword`, `cssSelector`, `xpath`, or `describe`.",
      };
    }
    const sessionId = toolCtx.chatSessionId ?? "no-session";
    const page = await resolveHtml(toolInput, sessionId);
    if (!page.ok) return page;

    if (toolInput.cssSelector !== undefined || toolInput.xpath !== undefined) {
      const screenshotter = await getExternalScreenshotter({
        allowedHosts: externalFetchAllowedHosts(),
      });
      if (!screenshotter) {
        return {
          ok: false,
          content:
            "query_page_html(css/xpath) needs Playwright/Chromium, which is not installed in this runtime. Use `keyword` or `describe` instead.",
        };
      }
      let matches: string[];
      try {
        matches = await screenshotter.query(page.html, {
          ...(toolInput.cssSelector !== undefined ? { cssSelector: toolInput.cssSelector } : {}),
          ...(toolInput.xpath !== undefined ? { xpath: toolInput.xpath } : {}),
          maxMatches: toolInput.maxMatches ?? DEFAULT_MAX_MATCHES,
        });
      } catch (e) {
        return {
          ok: false,
          content: `query_page_html selector failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      } finally {
        await screenshotter.dispose().catch(() => undefined);
      }
      const sel = toolInput.cssSelector ?? `xpath=${toolInput.xpath}`;
      if (matches.length === 0) {
        return {
          ok: true,
          content: `query_page_html: no elements match \`${sel}\` on ${page.url}.`,
        };
      }
      const blocks = matches.map((m, i) => `### Match ${i + 1}\n\`\`\`html\n${m}\n\`\`\``);
      return {
        ok: true,
        content: `## query_page_html — \`${sel}\` on ${page.url} (${matches.length} match(es))\n${blocks.join("\n\n")}`,
      };
    }

    if (toolInput.keyword !== undefined) {
      const windows = keywordWindows(
        page.html,
        toolInput.keyword,
        toolInput.maxMatches ?? DEFAULT_MAX_MATCHES,
        toolInput.contextChars ?? DEFAULT_CONTEXT_CHARS,
      );
      if (windows.length === 0) {
        return {
          ok: true,
          content: `query_page_html: "${toolInput.keyword}" not found on ${page.url}.`,
        };
      }
      const blocks = windows.map((w, i) => `### Match ${i + 1}\n\`\`\`html\n${w}\n\`\`\``);
      return {
        ok: true,
        content: `## query_page_html — "${toolInput.keyword}" on ${page.url} (${windows.length} match(es))\n${blocks.join("\n\n")}`,
      };
    }

    // describe mode — small-model extraction over the (capped) full HTML.
    const resolved = await getActiveProviderForModel(SMALL_MODEL);
    if (!resolved) {
      return {
        ok: false,
        content:
          "query_page_html(describe): could not resolve a small extraction model (no active AI provider / key). Use `keyword` instead, or the operator configures the provider at /security/ai.",
      };
    }
    const cappedHtml =
      page.html.length > DESCRIBE_HTML_CAP
        ? `${page.html.slice(0, DESCRIBE_HTML_CAP)}\n<!-- …HTML truncated for extraction -->`
        : page.html;
    const result = await resolved.provider.generateObject({
      systemPrompt:
        "You extract from a web page's raw HTML. Return ONLY what the caller asks for — the relevant HTML fragment(s) verbatim, or the requested info. Do not summarise the whole page. If the requested content is absent, set found=false and result to an empty string.",
      messages: [
        {
          role: "user",
          content: `Page: ${page.url}\nCaller needs: ${toolInput.describe}\n\nHTML:\n${cappedHtml}`,
        },
      ],
      jsonSchema: DESCRIBE_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 4000,
    });

    // §7 — record the sub-call's cost/tokens (attributed to this chat).
    if (toolCtx.registry && toolCtx.adapter && toolCtx.humanCtx && toolCtx.chatSessionId) {
      await execute(toolCtx.registry, toolCtx.adapter, toolCtx.humanCtx, "chat.record_ai_call", {
        chatSessionId: toolCtx.chatSessionId,
        parentChatSessionId: toolCtx.chatSessionId,
        provider: resolved.providerName,
        model: resolved.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      }).catch(() => undefined);
    }

    const obj = result.object as { found: boolean; result: string } | undefined;
    if (!obj?.found || obj.result.trim().length === 0) {
      return {
        ok: true,
        content: `query_page_html(describe): the extraction model did not find "${toolInput.describe}" on ${page.url}.`,
      };
    }
    return {
      ok: true,
      content: `## query_page_html — extracted "${toolInput.describe}" from ${page.url}\n${obj.result}`,
    };
  },
};
