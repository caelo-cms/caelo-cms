// SPDX-License-Identifier: MPL-2.0

/**
 * Factory for read-only "state endpoint" tools — the on-demand
 * counterparts to the system-prompt context chunks. The chunks are a
 * snapshot from turn start; these tools fetch the CURRENT state so the
 * AI never has to guess whether its own write landed (and never repeats
 * a confirmed write because a stale chunk still shows the old value).
 *
 * DRY rationale (2026-07 audit): 95 tools carried a hand-written JSON
 * `inputSchema` DUPLICATING their Zod `schema`, and 80 repeated the
 * same execute → describeError → format handler body. This factory is
 * the read-side sibling of `makeProposeTool`: define the Zod schema
 * once (JSON Schema is generated via `z.toJSONSchema`), pass the op
 * name and a formatter, done.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { z } from "zod";
import { z as zod } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolContext, ToolDefinitionWithHandler } from "./dispatch.js";

export interface MakeReadToolArgs<I> {
  readonly name: string;
  readonly description: string;
  /** Query-API op to execute (must be a read with AI actor scope). */
  readonly opName: string;
  /** Zod input schema — the JSON Schema is GENERATED from it. */
  readonly input: z.ZodType<I>;
  /**
   * Map the tool input to the op input. Default: pass through verbatim.
   * Use when the op needs context the model shouldn't supply (e.g. the
   * chat session id from ToolContext).
   */
  readonly buildOpInput?: (input: I, ctx: ExecutionContext, toolCtx: ToolContext) => unknown;
  /** Render the op's ok-value into the tool's text content. */
  readonly format: (value: unknown, input: I) => string;
  /**
   * Pass the raw op value through as the tool result's `value` (the
   * chat-runner's structured retry path reads it). Default true; set
   * false when the op payload carries data that must NOT enter the
   * transcript (e.g. ai_providers.list's config can include API keys).
   */
  readonly includeValue?: boolean;
}

/** Build a read tool: Zod schema in, JSON Schema + standard handler out. */
export function makeReadTool<I>(args: MakeReadToolArgs<I>): ToolDefinitionWithHandler<I> {
  return {
    name: args.name,
    description: args.description,
    schema: args.input,
    // Single source of truth: the wire JSON Schema is generated from the
    // Zod schema — no hand-maintained duplicate to drift.
    inputSchema: zod.toJSONSchema(args.input) as Record<string, unknown>,
    handler: async (ctx, input, toolCtx) => {
      const opInput = args.buildOpInput ? args.buildOpInput(input, ctx, toolCtx) : input;
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, args.opName, opInput);
      if (!r.ok) {
        return { ok: false, content: `${args.opName} failed: ${describeError(r.error)}` };
      }
      return {
        ok: true,
        content: args.format(r.value, input),
        ...(args.includeValue === false ? {} : { value: r.value }),
      };
    },
  };
}

// ─── List mode: TOON output + filter / pagination / truncation ─────────

/** Default page size when the model doesn't pass `limit`. */
const LIST_DEFAULT_LIMIT = 50;
/** Content char cap; `full: true` disables it. */
const LIST_CHAR_CAP = 6000;

/**
 * Standard list parameters every list read tool accepts, merged into the
 * tool's domain input by `makeListReadTool`.
 */
export const listParamsSchema = zod.object({
  filter: zod
    .string()
    .max(200)
    .optional()
    .describe("Case-insensitive substring filter applied across all output columns."),
  limit: zod
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(`Max rows to return (default ${LIST_DEFAULT_LIMIT}).`),
  offset: zod.number().int().min(0).optional().describe("Rows to skip (pagination)."),
  full: zod
    .boolean()
    .optional()
    .describe("true disables truncation entirely: all rows, no char cap."),
});
export type ListParams = zod.infer<typeof listParamsSchema>;

/** One TOON column: header key + row-value extractor. */
export interface ToonColumn<R> {
  readonly key: string;
  readonly value: (row: R) => unknown;
}

function toonCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[,"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * Render rows as TOON (Token-Oriented Object Notation): one header line
 * `label[shown]{col1,col2}:` followed by comma-separated value rows —
 * ~40-60% fewer tokens than prose/JSON for uniform arrays. Applies
 * filter → offset → limit → char cap, and appends a machine-actionable
 * footer when anything was cut.
 */
export function renderToonList<R>(
  label: string,
  allRows: readonly R[],
  columns: readonly ToonColumn<R>[],
  params: ListParams,
): string {
  const filter = params.filter?.toLowerCase();
  const rendered = allRows.map((r) => columns.map((c) => toonCell(c.value(r))).join(","));
  const filtered = filter
    ? rendered.filter((line) => line.toLowerCase().includes(filter))
    : rendered;
  const offset = params.offset ?? 0;
  const limit = params.limit ?? LIST_DEFAULT_LIMIT;
  const page = params.full ? filtered.slice(offset) : filtered.slice(offset, offset + limit);

  // Char cap (unless full): keep whole rows until the cap is reached.
  const kept: string[] = [];
  let chars = 0;
  for (const line of page) {
    if (!params.full && chars + line.length > LIST_CHAR_CAP) break;
    kept.push(line);
    chars += line.length + 1;
  }

  const header = `${label}[${kept.length}]{${columns.map((c) => c.key).join(",")}}:`;
  const body = kept.map((l) => `  ${l}`).join("\n");
  const cut = filtered.length - offset - kept.length;
  const footer =
    cut > 0
      ? `\n# ${kept.length} of ${filtered.length} shown${filter ? ` (filter="${params.filter}")` : ""} — next: offset=${offset + kept.length}; full=true disables truncation.`
      : filter
        ? `\n# ${kept.length} match${kept.length === 1 ? "" : "es"} of ${allRows.length} rows (filter="${params.filter}").`
        : "";
  return `${header}\n${body}${footer}`;
}

export interface MakeListReadToolArgs<I extends Record<string, unknown>, R> {
  readonly name: string;
  readonly description: string;
  readonly opName: string;
  /** Domain-specific input (kind, locale, …); list params are merged in. */
  readonly input: zod.ZodObject<zod.ZodRawShape>;
  /**
   * Map tool input (INCLUDING list params) to the op input. Default:
   * pass the domain fields through and DROP filter/limit/offset/full
   * (ops are .strict()). Override when the op supports server-side
   * search/paging (map filter → query etc.).
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
}

/**
 * Build a LIST read tool: domain input + standard list params, TOON
 * output, filter/pagination/truncation handled uniformly.
 */
export function makeListReadTool<I extends Record<string, unknown>, R>(
  args: MakeListReadToolArgs<I, R>,
): ToolDefinitionWithHandler<I & ListParams> {
  const inputSchema = args.input.extend(listParamsSchema.shape);
  return {
    name: args.name,
    description: args.description,
    schema: inputSchema as unknown as zod.ZodType<I & ListParams>,
    inputSchema: zod.toJSONSchema(inputSchema) as Record<string, unknown>,
    handler: async (ctx, input, toolCtx) => {
      const { filter: _f, limit: _l, offset: _o, full: _fu, ...domain } = input;
      const opInput = args.buildOpInput ? args.buildOpInput(input, ctx, toolCtx) : domain;
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, args.opName, opInput);
      if (!r.ok) {
        return { ok: false, content: `${args.opName} failed: ${describeError(r.error)}` };
      }
      const rows = args.rows(r.value);
      if (rows.length === 0) {
        return {
          ok: true,
          content: args.emptyMessage,
          ...(args.includeValue === false ? {} : { value: r.value }),
        };
      }
      return {
        ok: true,
        content: renderToonList(args.label, rows, args.columns, input),
        ...(args.includeValue === false ? {} : { value: r.value }),
      };
    },
  };
}
