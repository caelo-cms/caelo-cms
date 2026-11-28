// SPDX-License-Identifier: MPL-2.0

/**
 * #1753, #1761 — the calls core makes to ask plugins about pages at the
 * structured-data and sitemap-entries points: consecutive pages, at most
 * {@link STRUCTURED_DATA_PAGES_PER_CALL} per call, AND at most
 * {@link COMPOSITION_CALL_ARGS_BYTES} of arguments on the wire.
 *
 * Why bytes too: a sandboxed plugin receives its call as ONE message of at
 * most `SANDBOX_MESSAGE_BYTES` (sandbox-protocol.ts). A page record is
 * bounded per field, not as a whole: fifty pages with long richtext
 * properties (and the authors they name) exceed a megabyte, and the call
 * would fail as `SandboxMessageTooLarge`, stopping the build however small
 * the answer. Every plugin is asked the same way (one plugin model): an
 * in-process plugin gets the same calls.
 *
 * A page whose record does not fit a call on its own is not dropped: the
 * collectors refuse it per plugin as `record-too-large`, a render failure that
 * names the page (the preview lists it, a Stage records it, Publish live
 * refuses the build).
 */

import {
  STRUCTURED_DATA_PAGES_PER_CALL,
  type StructuredDataArgs,
  type StructuredDataPage,
} from "@caelo-cms/plugin-sdk";
import { SANDBOX_MESSAGE_BYTES } from "./sandbox-protocol.js";

/**
 * The bytes a call's arguments may take: one sandbox message, less room for
 * the rest of it (the plugin's slug and version, the invocation, the theme
 * tokens; a few KB in practice). The same budget the audit's fact batches
 * keep.
 */
export const COMPOSITION_CALL_ARGS_BYTES = SANDBOX_MESSAGE_BYTES - 64 * 1024;

const PAGE_REF_RE = /^caelo:page\/([0-9a-f-]{36})$/i;

const encoder = new TextEncoder();

/** The bytes `value` takes as JSON on the wire. */
function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/** The pages one page names: its `page` properties' targets and its terms' overview pages. */
export function namedPages(page: StructuredDataPage): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      const m = PAGE_REF_RE.exec(v);
      if (m) out.add((m[1] as string).toLowerCase());
    } else if (Array.isArray(v)) for (const e of v) visit(e);
  };
  for (const value of Object.values(page.properties)) visit(value);
  for (const t of page.terms) if (t.overviewPageId) out.add(t.overviewPageId.toLowerCase());
  return [...out];
}

/** A page record as a related page: no head of its own ({@link StructuredDataArgs.related}). */
function asRelated(p: StructuredDataPage): StructuredDataPage {
  return { ...p, lang: "", description: "", shareImage: null, live: false, listed: [] };
}

/**
 * The arguments of one call: its pages, the pages they name, their page
 * types (the sitemap-entries point asks with the same records).
 */
export function chunkArgs(
  input: StructuredDataArgs,
  chunk: readonly StructuredDataPage[],
): StructuredDataArgs {
  const wanted = new Set(chunk.flatMap(namedPages));
  const inChunk = new Set(chunk.map((p) => p.pageId.toLowerCase()));
  // A named page the caller asks about in another chunk (an author in the
  // same build batch) is not in `input.related`: hand it over from `pages`,
  // without its head, as every related record (the preview's view).
  const fromPages = input.pages
    .filter((p) => !inChunk.has(p.pageId.toLowerCase()) && wanted.has(p.pageId.toLowerCase()))
    .map(asRelated);
  const known = new Set(fromPages.map((p) => p.pageId.toLowerCase()));
  const related = [
    ...input.related.filter(
      (r) => wanted.has(r.pageId.toLowerCase()) && !known.has(r.pageId.toLowerCase()),
    ),
    ...fromPages,
  ];
  const types = new Set([...chunk, ...related].map((p) => p.pageType));
  return {
    pages: chunk,
    related,
    pageTypes: Object.fromEntries(
      Object.entries(input.pageTypes).filter(([slug]) => types.has(slug)),
    ),
    site: input.site,
  };
}

/** One call: the pages it asks about and its arguments. */
export interface CompositionCall {
  readonly pages: readonly StructuredDataPage[];
  readonly args: StructuredDataArgs;
}

/** The calls of a pass, and the pages no call can carry. */
export interface CompositionCalls {
  readonly calls: readonly CompositionCall[];
  /** Pages whose record alone (with the pages it names) exceeds the budget. */
  readonly oversized: readonly StructuredDataPage[];
}

/**
 * Cut the pages into calls, in order, by count and by wire size. The size
 * of a call is estimated from above while it fills (every page's record,
 * every page it names in its related form, the call's page types and site
 * at their largest), so a call never exceeds `maxBytes`; each finished
 * call is measured to prove it.
 *
 * @param maxBytes the budget per call's arguments (tests pass a small one).
 * @throws when a finished call measures above the budget: a fault in this
 *   estimate, never a property of the site.
 */
export function compositionCalls(
  input: StructuredDataArgs,
  maxBytes: number = COMPOSITION_CALL_ARGS_BYTES,
  perCall: number = STRUCTURED_DATA_PAGES_PER_CALL,
): CompositionCalls {
  const base = jsonBytes({ pages: [], related: [], pageTypes: input.pageTypes, site: input.site });
  // The largest form each page may take as a related record (+1 for its comma).
  const relatedBytes = new Map<string, number>();
  const widen = (id: string, n: number) =>
    relatedBytes.set(id, Math.max(relatedBytes.get(id) ?? 0, n + 1));
  for (const r of input.related) widen(r.pageId.toLowerCase(), jsonBytes(r));
  for (const p of input.pages) widen(p.pageId.toLowerCase(), jsonBytes(asRelated(p)));

  const calls: CompositionCall[] = [];
  const oversized: StructuredDataPage[] = [];
  let chunk: StructuredDataPage[] = [];
  let size = base;
  let named = new Set<string>();
  const cost = (page: StructuredDataPage, own: number, seen: ReadonlySet<string>) => {
    let n = own + 1;
    for (const id of namedPages(page)) if (!seen.has(id)) n += relatedBytes.get(id) ?? 0;
    return n;
  };
  const flush = () => {
    if (chunk.length === 0) return;
    const args = chunkArgs(input, chunk);
    const measured = jsonBytes(args);
    if (measured > maxBytes) {
      throw new Error(
        `composition-calls: a call of ${chunk.length} pages measures ${measured} bytes, over its budget of ${maxBytes} (the size estimate is wrong)`,
      );
    }
    calls.push({ pages: chunk, args });
    chunk = [];
    size = base;
    named = new Set();
  };
  for (const page of input.pages) {
    const own = jsonBytes(page);
    if (base + cost(page, own, new Set()) > maxBytes) {
      oversized.push(page);
      continue;
    }
    if (chunk.length >= perCall || size + cost(page, own, named) > maxBytes) flush();
    size += cost(page, own, named);
    for (const id of namedPages(page)) named.add(id);
    chunk.push(page);
  }
  flush();
  return { calls, oversized };
}
