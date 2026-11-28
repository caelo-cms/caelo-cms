// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports as AI tools (docs/data-imports.md): one `import_<kind>` per
 * kind that can be imported now (the core's, and active plugins'), plus
 * the tools every kind shares.
 *
 * The kind tools are made from the kind's declaration, so their argument
 * schema names the exact fields: the AI writes its conversion against it
 * without a round trip. They come and go with their plugin.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import {
  type ImportFieldDeclaration,
  type ImportProblemGroup,
  importToolName,
  untrustedToolResult,
} from "@caelo-cms/shared";
import { z } from "zod";
import { type ImportKind, importKinds } from "../../data-imports/kinds.js";
import {
  type DataImportCaller,
  type DataImportReport,
  MAX_INLINE_ROWS,
  MAX_UPLOADS_PER_CALL,
  runDataImport,
  undoDataImport,
} from "../../data-imports/run.js";
import { getMediaStorage } from "../../media/storage.js";
import { chatPluginInvocation } from "../plugin-invocation.js";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolContext, ToolDefinitionWithHandler, ToolInputSchema } from "./dispatch.js";

const importInput = z
  .object({
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_INLINE_ROWS).optional(),
    uploadIds: z.array(z.string().uuid()).min(1).max(MAX_UPLOADS_PER_CALL).optional(),
    sourceLabel: z.string().trim().min(1).max(120).optional(),
    importId: z.string().uuid().optional(),
    dryRun: z.boolean().optional(),
    mode: z.enum(["skip", "update"]).optional(),
    skipInvalid: z.boolean().optional(),
  })
  .strict();
type ImportToolInput = z.infer<typeof importInput>;

/** The JSON Schema of one field in an inline row. */
function fieldSchema(f: ImportFieldDeclaration): Record<string, unknown> {
  const type =
    f.type === "int"
      ? "integer"
      : f.type === "number"
        ? "number"
        : f.type === "bool"
          ? "boolean"
          : "string";
  const hint =
    f.type === "pageRef"
      ? "The page: its new path (/blog/hello), its old URL, or its id."
      : f.type === "datetime"
        ? "ISO 8601 with a time zone (2019-05-04T10:15:00Z)."
        : f.type === "text"
          ? "Plain text; line breaks allowed."
          : undefined;
  const description = [f.description, hint].filter(Boolean).join(" ");
  return {
    type,
    ...(f.type === "enum" ? { enum: f.values } : {}),
    ...(f.maxLength ? { maxLength: f.maxLength } : {}),
    ...(f.min !== undefined ? { minimum: f.min } : {}),
    ...(f.max !== undefined ? { maximum: f.max } : {}),
    ...(description ? { description } : {}),
  };
}

function rowSchema(kind: ImportKind): Record<string, unknown> {
  const d = kind.declaration;
  const required = [
    "sourceKey",
    ...Object.entries(d.fields)
      .filter(([, f]) => !f.optional)
      .map(([n]) => n),
  ];
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties: {
      sourceKey: {
        type: "string",
        description: "The row's stable id in the old system, prefixed (wp:comment:123).",
      },
      ...(d.parents
        ? { parentKey: { type: "string", description: "The parent row's sourceKey." } }
        : {}),
      ...Object.fromEntries(Object.entries(d.fields).map(([n, f]) => [n, fieldSchema(f)])),
    },
  };
}

function columnsLine(kind: ImportKind): string {
  const d = kind.declaration;
  return ["sourceKey", ...(d.parents ? ["parentKey"] : []), ...Object.keys(d.fields)].join(",");
}

function importDescription(kind: ImportKind): string {
  const d = kind.declaration;
  const release =
    d.release === "stage"
      ? "Rows are a draft until the next Stage of this chat; live with Publish live."
      : "Rows become pending changes of their kind.";
  return [
    `Import ${d.label.toLowerCase()} from another system in bulk. ${d.description}`,
    "USE FOR: a site migration or a file of rows. DO NOT USE FOR: one or two rows the operator dictates (write them with the kind's own tools).",
    `CORE RULES: The rows never pass through you. Convert the source locally (a script, a database export) into a CSV or JSON Lines file with exactly these columns: ${columnsLine(kind)}. Drop every other column (e-mail and IP addresses too). Upload it with caelo_upload_data (local MCP) or get a link for the operator with request_data_upload, then call with uploadIds; \`rows\` (max ${MAX_INLINE_ROWS}) only for a pasted short list. Run with dryRun first on a big file. Problems come back as counts with examples: fix the conversion, call again; rows already imported are skipped. ${release}`,
    ...(d.sources ? [`SOURCES: ${d.sources}`] : []),
  ].join("\n");
}

function importInputSchema(kind: ImportKind): ToolInputSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      uploadIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
        maxItems: MAX_UPLOADS_PER_CALL,
        description: "Uploaded files (CSV, JSON Lines, JSON) whose columns are the row fields.",
      },
      rows: { type: "array", maxItems: MAX_INLINE_ROWS, items: rowSchema(kind) },
      sourceLabel: {
        type: "string",
        description:
          'Where the rows come from, for people ("WordPress example.com"). Required for a new import.',
      },
      importId: {
        type: "string",
        format: "uuid",
        description:
          "Add to this import (more files, a retry) instead of starting one; refused once a Stage shipped it.",
      },
      dryRun: { type: "boolean", description: "Check and report, write nothing." },
      mode: {
        type: "string",
        enum: ["skip", "update"],
        description: "update: overwrite rows this import already holds. Default skip.",
      },
      skipInvalid: {
        type: "boolean",
        description: "Write the rows without problems although others have some.",
      },
    },
  } as ToolInputSchema;
}

/** The caller a tool runs an import as: the AI in its chat, for the operator. */
function callerOf(ctx: ExecutionContext, toolCtx: ToolContext): DataImportCaller {
  return {
    ctx,
    invocation: chatPluginInvocation(ctx, toolCtx.humanCtx?.actorId ?? ctx.actorId, {
      ...(toolCtx.aiDelegated ? { aiDelegated: true } : {}),
    }),
    ...(toolCtx.chatSessionId ? { chatSessionId: toolCtx.chatSessionId } : {}),
  };
}

function problemLines(groups: readonly ImportProblemGroup[]): string[] {
  return groups.flatMap((g) => [
    `- ${g.reason}: ${g.count} rows`,
    ...g.examples.slice(0, 5).map((e) => `  ${e.sourceKey ?? "?"} (${e.at}): ${e.detail}`),
  ]);
}

/** The report as text. Example details quote the source data, so they ride as untrusted data. */
export function formatImportReport(report: DataImportReport): string {
  const c = report.counts;
  const lines = [
    `${report.dryRun ? "Dry run" : report.written ? "Imported" : "Nothing written"} (${report.kind}${report.importId ? `, import ${report.importId}` : ""}${report.state ? `, ${report.state}` : ""}).`,
    `Rows ${c.rows}: imported ${c.imported}, updated ${c.updated}, unchanged ${c.unchanged}, with problems ${c.invalid}.`,
    report.next,
  ];
  if (report.problems.length > 0) {
    lines.push("Problems (examples quote the source data):");
    lines.push(untrustedToolResult(problemLines(report.problems)));
  }
  return lines.join("\n");
}

const toolCache = new WeakMap<ImportKind, ToolDefinitionWithHandler<ImportToolInput>>();

/** The `import_<kind>` tool of one kind (memoised, so the catalogue stays byte-stable). */
export function importToolFor(kind: ImportKind): ToolDefinitionWithHandler<ImportToolInput> {
  const cached = toolCache.get(kind);
  if (cached) return cached;
  const tool: ToolDefinitionWithHandler<ImportToolInput> = {
    name: importToolName(kind.declaration.kind),
    description: importDescription(kind),
    schema: importInput,
    inputSchema: importInputSchema(kind),
    handler: async (ctx, input, toolCtx) => {
      const r = await runDataImport(
        { registry: toolCtx.registry, adapter: toolCtx.adapter, storage: getMediaStorage },
        callerOf(ctx, toolCtx),
        { kind: kind.declaration.kind, ...input },
      );
      if (!r.ok) return { ok: false, content: r.message, failureKind: "HandlerError" };
      return { ok: true, content: formatImportReport(r.report), value: r.report };
    },
  };
  toolCache.set(kind, tool);
  return tool;
}

/** Every kind tool for now: the source `createDefaultToolRegistry` provides from. */
export function importKindTools(): ToolDefinitionWithHandler<unknown>[] {
  return importKinds().map(
    (k) => importToolFor(k) as unknown as ToolDefinitionWithHandler<unknown>,
  );
}

const listInput = z
  .object({
    kind: z.string().min(1).max(40).optional(),
    before: z.string().datetime().optional(),
  })
  .strict();

export const listDataImportsTool: ToolDefinitionWithHandler<z.infer<typeof listInput>> = {
  name: "list_data_imports",
  description:
    "List data imports, newest first: kind, source, how many rows, where each stands (draft | waiting-for-build | staged | live | undo-pending | undone | written). Then get_data_import for one report.",
  schema: listInput,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "data_imports.list", {
      ...input,
      limit: 25,
    });
    if (!r.ok) return toolError(r.error, `data_imports.list failed: ${describeError(r.error)}`);
    const list = (
      r.value as {
        imports: {
          importId: string;
          kind: string;
          sourceLabel: string;
          state: string;
          itemCount: number;
          createdAt: string;
        }[];
      }
    ).imports;
    const lines = list.map(
      (i) =>
        `- ${i.importId} ${i.kind} from ${i.sourceLabel}: ${i.itemCount} rows, ${i.state} (${i.createdAt})`,
    );
    return {
      ok: true,
      content: lines.length > 0 ? lines.join("\n") : "No data imports yet.",
      value: r.value,
    };
  },
};

const getInput = z.object({ importId: z.string().uuid() }).strict();

export const getDataImportTool: ToolDefinitionWithHandler<z.infer<typeof getInput>> = {
  name: "get_data_import",
  description:
    "One data import: kind, source, rows, where it stands, and the report of its last call.",
  schema: getInput,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "data_imports.get", input);
    if (!r.ok) return toolError(r.error, describeError(r.error));
    const v = r.value as {
      kind: string;
      sourceLabel: string;
      itemCount: number;
      state: string;
      lastReport: { counts: DataImportReport["counts"]; problems: ImportProblemGroup[] } | null;
    };
    const lines = [`${v.kind} from ${v.sourceLabel}: ${v.itemCount} rows, ${v.state}.`];
    if (v.lastReport) {
      const c = v.lastReport.counts;
      lines.push(
        `Last call: rows ${c.rows}, imported ${c.imported}, updated ${c.updated}, unchanged ${c.unchanged}, with problems ${c.invalid}.`,
      );
      if (v.lastReport.problems.length > 0)
        lines.push(untrustedToolResult(problemLines(v.lastReport.problems)));
    }
    return { ok: true, content: lines.join("\n"), value: r.value };
  },
};

export const undoDataImportTool: ToolDefinitionWithHandler<z.infer<typeof getInput>> = {
  name: "undo_data_import",
  description:
    "Undo a whole data import. Not shipped yet: its rows are removed now. Already on staging or live: they leave with the next Stage of this chat and Publish live. Then the same source keys can be imported again.",
  schema: getInput,
  handler: async (ctx, input, toolCtx) => {
    const r = await undoDataImport(
      { registry: toolCtx.registry, adapter: toolCtx.adapter, storage: getMediaStorage },
      callerOf(ctx, toolCtx),
      input.importId,
    );
    if (!r.ok) return { ok: false, content: r.message, failureKind: "HandlerError" };
    return { ok: true, content: `${r.undo.message} State: ${r.undo.state}.`, value: r.undo };
  },
};

const uploadInput = z.object({}).strict();

export const requestDataUploadTool: ToolDefinitionWithHandler<z.infer<typeof uploadInput>> = {
  name: "request_data_upload",
  description:
    "Get a link where the operator drops a data file (CSV, JSON Lines, JSON, up to 10 MB) for an import, when you cannot upload it yourself (no local MCP). Give the operator the link; then call import_<kind> with the uploadId. Kept 7 days.",
  schema: uploadInput,
  handler: async (ctx, _input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "data_uploads.create_slot", {
      ...(toolCtx.chatSessionId ? { chatSessionId: toolCtx.chatSessionId } : {}),
    });
    if (!r.ok) return toolError(r.error, describeError(r.error));
    const v = r.value as { uploadId: string; link: string; expiresAt: string };
    return {
      ok: true,
      content: `Upload ${v.uploadId}: ask the operator to drop the file at ${v.link} (until ${v.expiresAt}), then import with uploadIds: ["${v.uploadId}"].`,
      value: v,
    };
  },
};
