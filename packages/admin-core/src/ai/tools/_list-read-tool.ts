// SPDX-License-Identifier: MPL-2.0

/**
 * List mode of the read-tool factory: a domain input plus the uniform list
 * params, TOON output, and paging that tells the truth about the op behind
 * the tool.
 *
 * #1538 — every list tool declares how its op answers (`paging`):
 * - `complete`: the op returns every row of the asked set at once (a small,
 *   bounded domain: roles, layouts, a plugin's grants). The tool filters,
 *   pages and size-caps in memory, and `full` shows all of it.
 * - `offset`: the op cuts the page itself from `offset` + `limit`.
 * - `cursor`: the op pages by a keyset cursor (`cursor` + `limit` in, the
 *   next cursor out), so a deep page costs what the first one does.
 *
 * Before, a tool over a paging op sliced the op's FIRST page in memory: every
 * `offset` past it answered nothing, `full` stopped silently at the op's page
 * size and the "N of M" footer counted the fetched rows, not the table
 * (`find_redirects` could never show rule 201).
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { z as zod } from "zod";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolContext, ToolDefinitionWithHandler, ToolResult } from "./dispatch.js";
import { generateInputSchema } from "./generate-input-schema.js";

/** Default page size when the model doesn't pass `limit`. */
export const LIST_DEFAULT_LIMIT = 50;
/** Content char cap; `full: true` disables it. */
const LIST_CHAR_CAP = 6000;
/** Longest cursor a tool accepts (an op's cursor may carry a 500-char path and its search). */
const CURSOR_MAX_LENGTH = 8000;

/**
 * The list params of a tool over a COMPLETE read — the factory's `complete`
 * paging, and hand-written list tools whose op returns every row.
 */
export const listParamsSchema = zod.object({
  filter: zod.string().max(200).optional().describe("Case-insensitive substring over all columns."),
  limit: zod.number().int().min(1).max(500).optional().describe(`Default ${LIST_DEFAULT_LIMIT}.`),
  offset: zod.number().int().min(0).optional(),
  full: zod.boolean().optional().describe("true = all rows, no truncation."),
});

/** The list params a list tool may receive (which ones it offers depends on its paging). */
export interface ListParams {
  readonly filter?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly cursor?: string;
  readonly full?: boolean;
}

/**
 * How the op behind a list tool answers, so `offset` / `cursor` / `full` and
 * the footer say what really happened.
 */
export type ListPaging =
  | {
      /** The op returns every row of the asked set; the tool pages in memory. */
      readonly kind: "complete";
    }
  | {
      /** The op takes `offset` + `limit` and cuts the page itself. */
      readonly kind: "offset";
      /**
       * Largest page the tool asks for (`full` asks exactly this). Without
       * `total` the op must accept `maxLimit + 1`: the extra row says whether
       * more exist.
       */
      readonly maxLimit: number;
      /** The op's count of every row matching the call, for "rows 1-50 of N". */
      readonly total?: (value: unknown) => number;
      /**
       * Rows the op read for this page, including rows it then dropped (an op
       * that validates untrusted rows, like the gateway log). Without it a
       * dropped row would read as the end of the list. Positions then count
       * read rows, so the next page may repeat a row but never skips one.
       */
      readonly scanned?: (value: unknown) => number;
      /**
       * `buildOpInput` hands `filter` to the op, which searches every row (set
       * `listParamDescriptions.filter` to say what it matches). Otherwise
       * `filter` narrows the rows of this page only.
       */
      readonly serverFilter?: boolean;
    }
  | {
      /**
       * The op pages by keyset cursor: takes `cursor` + `limit`, answers the
       * cursor after its last row. `filter`, when offered, is the op's own
       * search (`buildOpInput` maps it; describe it in
       * `listParamDescriptions.filter`).
       */
      readonly kind: "cursor";
      readonly maxLimit: number;
      readonly nextCursor: (value: unknown) => string | null;
      readonly total?: (value: unknown) => number;
    };

/** One TOON column: header key + row-value extractor. */
export interface ToonColumn<R> {
  readonly key: string;
  readonly value: (row: R) => unknown;
}

function toonCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[,"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toonLines<R>(rows: readonly R[], columns: readonly ToonColumn<R>[]): string[] {
  return rows.map((r) => columns.map((c) => toonCell(c.value(r))).join(","));
}

function toonBlock<R>(label: string, lines: readonly string[], columns: readonly ToonColumn<R>[]) {
  const header = `${label}[${lines.length}]{${columns.map((c) => c.key).join(",")}}:`;
  return `${header}\n${lines.map((l) => `  ${l}`).join("\n")}`;
}

/** Whole rows up to the char cap (all of them when `full`). */
function capChars(lines: readonly string[], full: boolean | undefined): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (!full && chars + line.length > LIST_CHAR_CAP) break;
    kept.push(line);
    chars += line.length + 1;
  }
  return kept;
}

/**
 * Render a COMPLETE row set as TOON (Token-Oriented Object Notation): one
 * header line `label[shown]{col1,col2}:` followed by comma-separated value
 * rows — ~40-60% fewer tokens than prose/JSON for uniform arrays. Applies
 * filter → offset → limit → char cap in memory, which is only right when
 * `allRows` is every row of the set, and appends a machine-actionable
 * footer when anything was cut.
 */
export function renderToonList<R>(
  label: string,
  allRows: readonly R[],
  columns: readonly ToonColumn<R>[],
  params: ListParams,
): string {
  const filter = params.filter?.toLowerCase();
  const rendered = toonLines(allRows, columns);
  const filtered = filter
    ? rendered.filter((line) => line.toLowerCase().includes(filter))
    : rendered;
  const offset = params.offset ?? 0;
  const limit = params.limit ?? LIST_DEFAULT_LIMIT;
  const page = params.full ? filtered.slice(offset) : filtered.slice(offset, offset + limit);
  const kept = capChars(page, params.full);
  const cut = filtered.length - offset - kept.length;
  const filterNote = filter ? ` (filter="${params.filter}")` : "";
  let footer = "";
  if (offset > 0 && offset >= filtered.length) {
    footer = `\n# offset ${offset} is past the last row: ${filtered.length} row${filtered.length === 1 ? "" : "s"}${filterNote}.`;
  } else if (cut > 0) {
    footer = `\n# ${kept.length} of ${filtered.length} shown${filterNote} — next: offset=${offset + kept.length}; full=true disables truncation.`;
  } else if (filter) {
    footer = `\n# ${kept.length} match${kept.length === 1 ? "" : "es"} of ${allRows.length} rows${filterNote}.`;
  }
  return `${toonBlock(label, kept, columns)}${footer}`;
}

/**
 * How many of `rows`, from the first, fit the list char cap as TOON lines —
 * for a tool that pages by an opaque cursor and so must ask its op for
 * exactly that many rows to continue right after the last one shown.
 */
export function rowsWithinCharCap<R>(
  rows: readonly R[],
  columns: readonly ToonColumn<R>[],
): number {
  return capChars(toonLines(rows, columns), false).length;
}

export interface MakeListReadToolArgs<I extends Record<string, unknown>, R> {
  readonly name: string;
  readonly description: string;
  readonly opName: string;
  /** Domain-specific input (kind, locale, …); list params are merged in. */
  readonly input: zod.ZodObject<zod.ZodRawShape>;
  /** How the op answers; decides which list params the tool offers. */
  readonly paging: ListPaging;
  /** Page size when the model passes no `limit`. Default 50. */
  readonly defaultLimit?: number;
  /**
   * Map the tool input (INCLUDING list params) to the op's DOMAIN input.
   * Default: the domain fields, without the list params (ops are
   * .strict()). Never set `offset` / `cursor` / `limit` here — the factory
   * adds them from `paging`. Map `filter` to the op's search when the op
   * has one (and say so in `paging`).
   */
  readonly buildOpInput?: (
    input: I & ListParams,
    ctx: ExecutionContext,
    toolCtx: ToolContext,
  ) => unknown;
  /** Extract the row array from the op's ok-value. */
  readonly rows: (value: unknown) => readonly R[];
  /** TOON header label, e.g. "pages". */
  readonly label: string;
  readonly columns: readonly ToonColumn<R>[];
  readonly emptyMessage: string;
  /** See MakeReadToolArgs.includeValue. */
  readonly includeValue?: boolean;
  /**
   * Text the AI needs next to the list that is not a row of it (e.g. the
   * plugins found on disk that could not be verified). Appended after the
   * list, or after `emptyMessage`; null adds nothing.
   */
  readonly appendix?: (value: unknown) => string | null;
  /**
   * Replaces the generic `filter` / `limit` descriptions when the op does
   * something else with them (a server-side search), so the model is told
   * what actually happens.
   */
  readonly listParamDescriptions?: { readonly filter?: string; readonly limit?: string };
}

type AnyArgs = MakeListReadToolArgs<Record<string, unknown>, unknown>;

/** True when `filter` is the op's search over every row, not a page filter. */
function filtersOnServer(paging: ListPaging): boolean {
  return paging.kind === "cursor" || (paging.kind === "offset" && paging.serverFilter === true);
}

/** The list params a tool offers for its paging. */
function listParamsShape(args: AnyArgs): zod.ZodRawShape {
  const p = args.paging;
  const texts = args.listParamDescriptions;
  const filterText =
    texts?.filter ??
    (p.kind === "offset" && !p.serverFilter
      ? "Substring, this page's rows only."
      : "Case-insensitive substring over all columns.");
  const filter = zod.string().max(200).optional().describe(filterText);
  const limitText = texts?.limit ?? `Default ${args.defaultLimit ?? LIST_DEFAULT_LIMIT}.`;
  if (p.kind === "complete") {
    return {
      ...listParamsSchema.shape,
      filter,
      limit: listParamsSchema.shape.limit.describe(limitText),
    };
  }
  const limit = zod.number().int().min(1).max(p.maxLimit).optional().describe(limitText);
  const full = zod.boolean().optional().describe(`true = ${p.maxLimit} rows, no size cap.`);
  if (p.kind === "offset") {
    return { filter, limit, offset: zod.number().int().min(0).optional(), full };
  }
  // Self-explanatory next to the footer's "next cursor: …"; no blurb to pay for.
  const cursor = zod.string().min(1).max(CURSOR_MAX_LENGTH).optional();
  return { filter, limit, cursor, full };
}

/** What one paging strategy needs to read and answer. */
interface PageRun {
  readonly args: AnyArgs;
  readonly built: Record<string, unknown>;
  readonly input: ListParams;
  readonly ctx: ExecutionContext;
  readonly toolCtx: ToolContext;
  /** Rows this call shows at most. */
  readonly want: number;
}

type Read = { ok: true; value: unknown } | { ok: false; result: ToolResult };

async function readOp(run: PageRun, opInput: Record<string, unknown>): Promise<Read> {
  const { args, ctx, toolCtx } = run;
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, args.opName, opInput);
  if (!r.ok) {
    return {
      ok: false,
      result: toolError(r.error, `${args.opName} failed: ${describeError(r.error)}`),
    };
  }
  return { ok: true, value: r.value };
}

function answer(args: AnyArgs, value: unknown, content: string): ToolResult {
  const appendix = args.appendix?.(value);
  return {
    ok: true,
    content: appendix ? `${content}\n${appendix}` : content,
    ...(args.includeValue === false ? {} : { value }),
  };
}

async function completePage(run: PageRun): Promise<ToolResult> {
  const { args, input } = run;
  const r = await readOp(run, run.built);
  if (!r.ok) return r.result;
  const rows = args.rows(r.value);
  if (rows.length === 0) return answer(args, r.value, args.emptyMessage);
  const params = { ...input, limit: input.limit ?? args.defaultLimit ?? LIST_DEFAULT_LIMIT };
  return answer(args, r.value, renderToonList(args.label, rows, args.columns, params));
}

async function offsetPage(
  run: PageRun,
  p: Extract<ListPaging, { kind: "offset" }>,
): Promise<ToolResult> {
  const { args, input, want } = run;
  const offset = input.offset ?? 0;
  const r = await readOp(run, { ...run.built, offset, limit: p.total ? want : want + 1 });
  if (!r.ok) return r.result;
  const fetched = args.rows(r.value);
  const rows = fetched.slice(0, want);
  const total = p.total?.(r.value);
  // Rows of the op's page this answer covers; more than `rows` when the op
  // dropped some.
  const read = p.scanned?.(r.value) ?? fetched.length;
  const consumed = Math.min(read, want);
  const more = total === undefined ? read > want : offset + rows.length < total;
  const ofTotal = total === undefined ? "" : ` of ${total}`;
  if (rows.length === 0 && consumed > 0 && more) {
    // Every row of this page was dropped, but the list goes on.
    return answer(
      args,
      r.value,
      `No valid ${args.label} in rows ${offset + 1}-${offset + consumed} — more exist; next: offset=${offset + consumed}.`,
    );
  }
  if (rows.length === 0) {
    // A count of 0 here can be a window count over no rows, not the set's size.
    const past = `No ${args.label} past offset ${offset}${total ? ` (${total} in total)` : ""}.`;
    return answer(args, r.value, offset === 0 ? args.emptyMessage : past);
  }
  const pageFilter = !p.serverFilter && input.filter ? input.filter.toLowerCase() : undefined;
  const lines = toonLines(rows, args.columns).filter(
    (l) => pageFilter === undefined || l.toLowerCase().includes(pageFilter),
  );
  const kept = capChars(lines, input.full);
  const cut = kept.length < lines.length;
  // Rows of the op's page this answer accounts for: all of them, unless the
  // char cap cut an unfiltered page (then up to the last row shown).
  const covered = cut && !pageFilter ? kept.length : consumed;
  const range = `rows ${offset + 1}-${offset + covered}${ofTotal}`;
  let footer: string;
  if (pageFilter) {
    const shown = `${kept.length} match${kept.length === 1 ? "" : "es"} in ${range} (filter="${input.filter}" applied to this page)`;
    footer = cut
      ? `# ${shown}, cut at the size cap — pass full=true or a narrower filter.`
      : `# ${shown}${more ? ` — more exist; next: offset=${offset + covered}.` : "."}`;
  } else {
    const filterNote = input.filter ? ` (filter="${input.filter}")` : "";
    footer =
      cut || more
        ? `# ${range}${filterNote} — more exist; next: offset=${offset + covered}.`
        : `# ${range}${filterNote}.`;
  }
  // A first page that holds everything, unfiltered and uncounted, needs no footer.
  const silent = offset === 0 && !cut && !more && total === undefined && !input.filter;
  return answer(
    args,
    r.value,
    `${toonBlock(args.label, kept, args.columns)}${silent ? "" : `\n${footer}`}`,
  );
}

async function cursorPage(
  run: PageRun,
  p: Extract<ListPaging, { kind: "cursor" }>,
): Promise<ToolResult> {
  const { args, input } = run;
  const read = (limit: number) =>
    readOp(run, { ...run.built, limit, ...(input.cursor ? { cursor: input.cursor } : {}) });
  let r = await read(run.want);
  if (!r.ok) return r.result;
  let rows = args.rows(r.value);
  if (rows.length === 0) {
    return answer(args, r.value, input.cursor ? `No more ${args.label}.` : args.emptyMessage);
  }
  // The cursor is opaque: when the rows outgrow the char cap, read the page
  // again with exactly as many rows as fit, so its cursor continues right
  // after the last row shown.
  const fit = input.full ? rows.length : rowsWithinCharCap(rows, args.columns);
  if (fit < rows.length) {
    r = await read(Math.max(1, fit));
    if (!r.ok) return r.result;
    rows = args.rows(r.value);
  }
  const next = p.nextCursor(r.value);
  const total = p.total?.(r.value);
  const filterNote = input.filter ? ` (filter="${input.filter}")` : "";
  const ofTotal = total === undefined ? "" : ` of ${total}${input.filter ? " matching" : ""}`;
  const silent = !next && total === undefined && !input.cursor && !input.filter;
  const footer = `# ${rows.length} shown${ofTotal}${filterNote}${next ? ` — more exist; next cursor: ${next}` : ""}`;
  const block = toonBlock(args.label, toonLines(rows, args.columns), args.columns);
  return answer(args, r.value, `${block}${silent ? "" : `\n${footer}`}`);
}

/**
 * Build a LIST read tool: domain input + the list params its paging
 * offers, TOON output, filter/pagination/truncation handled uniformly.
 */
export function makeListReadTool<I extends Record<string, unknown>, R>(
  args: MakeListReadToolArgs<I, R>,
): ToolDefinitionWithHandler<I & ListParams> {
  const any = args as unknown as AnyArgs;
  if (filtersOnServer(args.paging) && !args.listParamDescriptions?.filter) {
    throw new Error(
      `${args.name}: a server-side filter must say what it matches (listParamDescriptions.filter).`,
    );
  }
  const inputSchema = args.input.extend(listParamsShape(any));
  return {
    name: args.name,
    description: args.description,
    schema: inputSchema as unknown as zod.ZodType<I & ListParams>,
    inputSchema: generateInputSchema(inputSchema),
    handler: async (ctx, input, toolCtx) => {
      const { filter: _f, limit: _l, offset: _o, cursor: _c, full: _fu, ...domain } = input;
      const built = (args.buildOpInput ? args.buildOpInput(input, ctx, toolCtx) : domain) as Record<
        string,
        unknown
      >;
      const p = args.paging;
      const defaultLimit = args.defaultLimit ?? LIST_DEFAULT_LIMIT;
      const want =
        p.kind === "complete"
          ? 0
          : input.full
            ? p.maxLimit
            : Math.min(input.limit ?? defaultLimit, p.maxLimit);
      const run: PageRun = { args: any, built, input, ctx, toolCtx, want };
      if (p.kind === "offset") return offsetPage(run, p);
      if (p.kind === "cursor") return cursorPage(run, p);
      return completePage(run);
    },
  };
}
