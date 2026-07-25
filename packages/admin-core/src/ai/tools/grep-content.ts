// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: grep_content. The DB-content analogue of Claude Code's Grep —
 * search across every module (and template) body for a string or regex, so
 * the AI can LOCATE the text to change before issuing a surgical
 * edit_content, instead of eyeballing whole modules.
 *
 * Bodies come from the entity's list op (modules.list / templates.list both
 * return full html/css/js), so this is one read per entity kind — no N+1.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import {
  CONTENT_ENTITY_KINDS,
  CONTENT_TARGETS,
  type ContentEntityKind,
  resolveContentTarget,
} from "../content-edit/registry.js";
import { grepBody } from "../content-edit/text-ops.js";
import { describeError } from "./_describe-error.js";
import type { ToolContext, ToolDefinitionWithHandler } from "./dispatch.js";

const grepContentInput = z
  .object({
    pattern: z.string().min(1).max(500),
    /** Restrict to one entity kind; omit to search modules + templates. */
    entityKind: z.enum(["module", "template"]).optional(),
    /** Restrict to one body field (html/css/js); omit to search all. */
    field: z.string().min(1).max(32).optional(),
    isRegex: z.boolean().optional(),
    ignoreCase: z.boolean().optional(),
    /** Max matching lines to return across all entities (default 100). */
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
type GrepContentInput = z.infer<typeof grepContentInput>;

const DEFAULT_LIMIT = 100;

async function grepKind(
  ctx: Parameters<ToolDefinitionWithHandler<GrepContentInput>["handler"]>[0],
  toolCtx: ToolContext,
  kind: ContentEntityKind,
  input: GrepContentInput,
  remaining: number,
): Promise<{ lines: string[]; hitCount: number; error?: string; truncated: boolean }> {
  const target = CONTENT_TARGETS[kind];
  const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, target.listOp, {});
  if (!res.ok) {
    return {
      lines: [],
      hitCount: 0,
      error: `${target.listOp} failed: ${describeError(res.error)}`,
      truncated: false,
    };
  }
  const fields = input.field !== undefined ? [input.field] : target.fields;
  const lines: string[] = [];
  let hitCount = 0;
  let truncated = false;
  for (const row of target.listRows(res.value)) {
    for (const field of fields) {
      if (!target.fields.includes(field)) continue;
      const body = row.fields[field] ?? "";
      if (body.length === 0) continue;
      const g = grepBody(body, input.pattern, {
        isRegex: input.isRegex,
        ignoreCase: input.ignoreCase,
      });
      if (!g.ok) return { lines: [], hitCount: 0, error: g.error, truncated: false };
      for (const hit of g.hits) {
        hitCount++;
        if (lines.length >= remaining) {
          truncated = true;
          continue;
        }
        const snippet = hit.line.trim().slice(0, 160);
        lines.push(`${kind} ${row.slug} (${row.id}) ${field}:${hit.lineNumber}: ${snippet}`);
      }
    }
  }
  return { lines, hitCount, truncated };
}

export const grepContentTool: ToolDefinitionWithHandler<GrepContentInput> = {
  name: "grep_content",
  description:
    "Search every module (and template) body for a string or regex — find WHERE to edit before calling edit_content. " +
    "Pass `pattern` (literal substring, or a JS regex with `isRegex:true`), optional `ignoreCase`, and narrow with `entityKind` and/or `field` (html/css/js). " +
    "Returns matching lines as `<kind> <slug> (<id>) <field>:<lineNo>: <text>` so you can jump straight to read_content + edit_content on the right entity. " +
    "Use when the operator says 'change X everywhere it appears' or you need to locate a class / string across the catalog.",
  schema: grepContentInput,
  inputSchema: z.toJSONSchema(grepContentInput) as Record<string, unknown>,
  handler: async (ctx, input, toolCtx) => {
    if (input.entityKind !== undefined && resolveContentTarget(input.entityKind) === null) {
      return {
        ok: false,
        content: `unknown entityKind "${input.entityKind}". Valid: ${CONTENT_ENTITY_KINDS.join(", ")}.`,
      };
    }
    const kinds: ContentEntityKind[] =
      input.entityKind !== undefined ? [input.entityKind] : CONTENT_ENTITY_KINDS;
    const limit = input.limit ?? DEFAULT_LIMIT;

    const out: string[] = [];
    let totalHits = 0;
    let anyTruncated = false;
    for (const kind of kinds) {
      const r = await grepKind(ctx, toolCtx, kind, input, limit - out.length);
      if (r.error) return { ok: false, content: r.error };
      out.push(...r.lines);
      totalHits += r.hitCount;
      anyTruncated = anyTruncated || r.truncated;
    }

    if (totalHits === 0) {
      return { ok: true, content: `0 matches for ${JSON.stringify(input.pattern)}.` };
    }
    const footer = anyTruncated
      ? `\n# ${out.length} of ${totalHits} matches shown — narrow with entityKind/field or raise limit.`
      : `\n# ${totalHits} match${totalHits === 1 ? "" : "es"}.`;
    return { ok: true, content: `${out.join("\n")}${footer}` };
  },
};
