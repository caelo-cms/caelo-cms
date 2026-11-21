// SPDX-License-Identifier: MPL-2.0

/**
 * The tools of a visitor conversation (#1654): exactly the search and read
 * operations its `ai-chat` declaration names, of active plugins, run by the
 * shared collection executor (`runCollectionOperation`) on this
 * environment's releases. Nothing else is a tool: there is no write, no
 * form, no mail, no other plugin's code — whatever a page or a visitor puts
 * into the conversation, the model can only search and read the site.
 *
 * Each result is cut to what answering needs and numbered: every page a
 * tool returns becomes a source `[n]`, and the sources the visitor sees are
 * only these, built from the collection's own documents (the model never
 * writes a link). A URL that is not a path on this site, a title that is
 * not text and an anchor that is not an id are dropped: the collection
 * stores count as untrusted too.
 */

import type { CollectionAnswer, OpenEntry } from "@caelo-cms/plugin-host/gateway";
import type { AiChatTool, CollectionOperationManifest } from "@caelo-cms/plugin-sdk";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { ChatSource } from "./turns.js";

/** Bytes of one tool result the model reads at most (the turn's worst case counts it). */
export const TOOL_RESULT_MAX_BYTES = 12_000;

/** Bytes a tool call's own input takes at most (a query or a path). */
export const TOOL_CALL_MAX_BYTES = 800;

/** Hits a search tool returns to the model. */
const SEARCH_HITS = 5;

/** A resolved tool: the declared operation, where its release lives. */
export interface ResolvedTool {
  readonly decl: AiChatTool;
  readonly pluginId: string;
  readonly op: CollectionOperationManifest;
}

/** What a tool needs to run one operation. */
export interface ToolRuntime {
  /** The open release (and the anchor release) of the tool's collection, or null when none is published. */
  readonly release: (
    t: ResolvedTool,
  ) => Promise<{ entry: OpenEntry; key: string; anchors: OpenEntry | null } | null>;
  readonly run: (
    t: ResolvedTool,
    release: { entry: OpenEntry; key: string; anchors: OpenEntry | null },
    params: URLSearchParams,
  ) => Promise<CollectionAnswer>;
}

/** The sources of one turn, numbered in the order the tools found them. */
export class TurnSources {
  readonly #byKey = new Map<string, ChatSource>();

  /** The number of a page (and anchor), registering it the first time; null for an unusable one. */
  add(
    url: unknown,
    title: unknown,
    anchor: unknown,
    siteOrigins: readonly string[],
  ): number | null {
    const path = sitePath(url, siteOrigins);
    if (path === null) return null;
    const a = typeof anchor === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(anchor) ? anchor : null;
    const key = `${path}#${a ?? ""}`;
    const found = this.#byKey.get(key);
    if (found) return found.n;
    if (this.#byKey.size >= 20) return null;
    const n = this.#byKey.size + 1;
    this.#byKey.set(key, {
      n,
      url: path,
      title: typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 200) : "",
      anchor: a,
      cited: false,
    });
    return n;
  }

  /** Every source, each marked whether the answer cites it as `[n]`. */
  final(answer: string): ChatSource[] {
    const cited = new Set([...answer.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])));
    return [...this.#byKey.values()].map((s) => ({ ...s, cited: cited.has(s.n) }));
  }
}

/** `url` as a path on this site, or null. */
export function sitePath(url: unknown, siteOrigins: readonly string[]): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 500) return null;
  if (/[\s<>"'\\]/.test(url)) return null;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const u = new URL(url);
    if (!siteOrigins.includes(u.origin)) return null;
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

function plain(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string")
    return (v as { text: string }).text;
  return "";
}

/** `items` as JSON within the byte budget: whole items, the last ones dropped first. */
function bounded(
  items: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): string {
  let kept = [...items];
  for (;;) {
    const text = JSON.stringify({ ...extra, results: kept });
    if (Buffer.byteLength(text, "utf8") <= TOOL_RESULT_MAX_BYTES || kept.length === 0)
      return text.length > TOOL_RESULT_MAX_BYTES ? text.slice(0, TOOL_RESULT_MAX_BYTES) : text;
    kept = kept.slice(0, -1);
  }
}

/** The model-facing name of a declared tool. */
export function toolName(t: AiChatTool): string {
  return `${t.plugin}__${t.operation}`.replace(/-/g, "_").slice(0, 64);
}

/**
 * The SDK tools of one turn. `lang` is the visitor's language (the page's),
 * which a search operation filters by.
 */
export function buildTools(
  tools: readonly ResolvedTool[],
  runtime: ToolRuntime,
  sources: TurnSources,
  ctx: {
    readonly lang: string;
    readonly siteOrigins: readonly string[];
    /** Whether one more tool call may run this turn (the turn's worst case counts a bounded number). */
    readonly mayCall: () => boolean;
  },
): ToolSet {
  const out: ToolSet = {};
  for (const t of tools) {
    const { op } = t;
    const unavailable = (kind: string) => JSON.stringify({ error: kind });
    if (op.kind === "search") {
      out[toolName(t.decl)] = tool({
        description: `Search the website. ${op.description} Returns the best matching pages with a snippet; each has a source number to cite as [n].`,
        inputSchema: z.object({
          query: z
            .string()
            .min(1)
            .max(op.maxQueryChars)
            .describe("A few keywords, in the visitor's language."),
        }),
        execute: async ({ query }) => {
          if (!ctx.mayCall()) return unavailable("TooManyToolCalls");
          const release = await runtime.release(t);
          if (!release) return unavailable("IndexNotReady");
          const answer = await runtime.run(
            t,
            release,
            new URLSearchParams({
              q: query,
              lang: ctx.lang,
              limit: String(Math.min(SEARCH_HITS, op.maxResults)),
            }),
          );
          if (answer.status !== 200) return unavailable(errorKind(answer));
          const hits = ((answer.body as { hits?: unknown[] }).hits ?? []) as Record<
            string,
            unknown
          >[];
          const items: Record<string, unknown>[] = [];
          for (const h of hits) {
            const snip = h.snippet as {
              anchor?: unknown;
              heading?: unknown;
              text?: unknown;
            } | null;
            const n = sources.add(h.url, h.title, snip?.anchor, ctx.siteOrigins);
            if (n === null) continue;
            items.push({
              source: n,
              title: plain(h.title).slice(0, 200),
              heading: plain(snip?.heading).slice(0, 200),
              snippet: plain(snip?.text).slice(0, 600),
            });
          }
          return bounded(items, { query });
        },
      });
    } else if (op.kind === "read") {
      const by = op.by === "id" ? "id" : op.by;
      out[toolName(t.decl)] = tool({
        description: `Read one page of the website in full. ${op.description} Pass the page's ${by} as a search result gave it.`,
        inputSchema: z.object({
          [by]: z.string().min(1).max(500),
        }),
        execute: async (input: Record<string, string>) => {
          if (!ctx.mayCall()) return unavailable("TooManyToolCalls");
          const release = await runtime.release(t);
          if (!release) return unavailable("IndexNotReady");
          const value = input[by] ?? "";
          const answer = await runtime.run(
            t,
            release,
            new URLSearchParams(op.by === "id" ? { id: value } : { value }),
          );
          if (answer.status !== 200) return unavailable(errorKind(answer));
          const docs = ((answer.body as { documents?: unknown[] }).documents ?? []) as Record<
            string,
            unknown
          >[];
          const items: Record<string, unknown>[] = [];
          for (const d of docs) {
            const n = sources.add(d.url, d.title, null, ctx.siteOrigins);
            if (n === null) continue;
            const passages = op.passages
              ? ((d[op.passages] ?? []) as {
                  heading?: unknown;
                  text?: unknown;
                  anchor?: unknown;
                }[])
              : [];
            items.push({
              source: n,
              title: plain(d.title).slice(0, 200),
              description: plain(d.description).slice(0, 600),
              sections: passages.slice(0, 40).map((p) => {
                // A section is a source of its own: the link opens it.
                const sn = sources.add(d.url, d.title, p.anchor, ctx.siteOrigins);
                return {
                  source: sn ?? n,
                  heading: plain(p.heading).slice(0, 200),
                  text: plain(p.text).slice(0, 1500),
                };
              }),
            });
          }
          return bounded(items);
        },
      });
    }
  }
  return out;
}

function errorKind(answer: CollectionAnswer): string {
  const kind = (answer.body as { error?: { kind?: unknown } } | null)?.error?.kind;
  return typeof kind === "string" && /^[A-Za-z]{1,40}$/.test(kind) ? kind : "Failed";
}
