// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: read_content. The DB-content analogue of Claude Code's Read
 * tool — returns a module's or template's body field (html/css/js) with
 * `cat -n` line numbers, windowable via offset/limit for large bodies.
 *
 * This is the explicit "Read" that a surgical `edit_content` anchors
 * against: the line-numbered output lets the model locate a hunk, and the
 * `sha` it stamps can be handed back to `edit_content` as `expectedSha` so a
 * body changed by another writer since the read is rejected, not clobbered.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import {
  CONTENT_ENTITY_KINDS,
  type ContentTarget,
  resolveContentTarget,
} from "../content-edit/registry.js";
import { contentSha, renderWithLineNumbers } from "../content-edit/text-ops.js";
import { describeError } from "./_describe-error.js";
import type { ToolContext, ToolDefinitionWithHandler } from "./dispatch.js";

const readContentInput = z
  .object({
    entityKind: z.enum(["module", "template"]),
    entityId: z.string().uuid(),
    /**
     * Body field to read. Omit to read every non-empty body of the entity
     * (each in its own line-numbered block). offset/limit apply only when a
     * single field is named.
     */
    field: z.string().min(1).max(32).optional(),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict();
type ReadContentInput = z.infer<typeof readContentInput>;

function renderField(name: string, body: string, window: { offset?: number; limit?: number }) {
  const r = renderWithLineNumbers(body, window);
  const windowNote =
    r.shownLines < r.totalLines
      ? ` (lines ${r.startLine}-${r.endLine} of ${r.totalLines}; next: offset=${r.endLine + 1})`
      : ` (${r.totalLines} line${r.totalLines === 1 ? "" : "s"})`;
  const header = `# ${name} — sha=${contentSha(body)}${windowNote}`;
  return body.length === 0 ? `${header}\n(empty)` : `${header}\n${r.text}`;
}

async function readOne(
  ctx: Parameters<ToolDefinitionWithHandler<ReadContentInput>["handler"]>[0],
  input: ReadContentInput,
  toolCtx: ToolContext,
  target: ContentTarget,
): Promise<{ ok: boolean; content: string; value?: unknown }> {
  const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, target.getOp, {
    [target.idArg]: input.entityId,
  });
  if (!res.ok) {
    return { ok: false, content: `${target.getOp} failed: ${describeError(res.error)}` };
  }
  const bodies = target.readRow(res.value);

  if (input.field !== undefined) {
    if (!target.fields.includes(input.field)) {
      return {
        ok: false,
        content: `unknown field "${input.field}" for ${input.entityKind}. Valid fields: ${target.fields.join(", ")}.`,
      };
    }
    const body = bodies[input.field] ?? "";
    return {
      ok: true,
      content: renderField(input.field, body, { offset: input.offset, limit: input.limit }),
      value: {
        entityKind: input.entityKind,
        entityId: input.entityId,
        field: input.field,
        sha: contentSha(body),
      },
    };
  }

  // No field → dump every field (offset/limit ignored across multiple fields).
  const blocks = target.fields.map((f) => renderField(f, bodies[f] ?? "", {}));
  return {
    ok: true,
    content: blocks.join("\n\n"),
    value: {
      entityKind: input.entityKind,
      entityId: input.entityId,
      shas: Object.fromEntries(target.fields.map((f) => [f, contentSha(bodies[f] ?? "")])),
    },
  };
}

export const readContentTool: ToolDefinitionWithHandler<ReadContentInput> = {
  name: "read_content",
  description:
    "Read a module's or template's body (html/css/js) with line numbers — the Read step before a surgical edit_content. " +
    "Pass `entityKind` ('module' | 'template') + `entityId`, and optionally `field` ('html'/'css'/'js'; templates have html/css). " +
    "Omit `field` to see every body; name a `field` to window a large one via `offset` (1-based line) + `limit`. " +
    "Each block prints a `sha=` token you can hand back to edit_content as `expectedSha` to guard against a concurrent change. " +
    "Prefer this over dumping a whole module through list_modules (which returns metadata only). " +
    "Use edit_content (NOT edit_module) to change what you read here surgically.",
  schema: readContentInput,
  inputSchema: z.toJSONSchema(readContentInput) as Record<string, unknown>,
  handler: async (ctx, input, toolCtx) => {
    const target = resolveContentTarget(input.entityKind);
    if (!target) {
      return {
        ok: false,
        content: `unknown entityKind "${input.entityKind}". Valid: ${CONTENT_ENTITY_KINDS.join(", ")}.`,
      };
    }
    return readOne(ctx, input, toolCtx, target);
  },
};
