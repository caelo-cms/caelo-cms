// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R5, issue #1646) — the AI's tools for plugin batches: long
 * tasks a plugin runs outside the admin (rebuilding what it derived from
 * the site, aggregating its own data). The AI starts the ones a plugin
 * offers on request, follows them, and stops one the operator no longer
 * wants. What a batch writes reaches visitors only through the next Stage
 * and the operator's Publish live, like every other change.
 */

import { loadedPlugins } from "@caelo-cms/plugin-host";
import type { PluginBatchOperation } from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import type { BatchRun } from "../../plugin-batches/ops.js";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";
import { generateInputSchema } from "./generate-input-schema.js";

const pluginSlug = z.string().regex(/^[a-z][a-z0-9-]{0,54}$/);

function runLine(r: BatchRun): string {
  const when = r.finishedAt ?? r.startedAt ?? r.createdAt;
  const tail =
    r.state === "failed" || r.state === "stopped"
      ? `: ${r.error ?? "no reason recorded"}`
      : r.state === "completed" && r.result !== null
        ? `: ${JSON.stringify(r.result).slice(0, 300)}`
        : "";
  return `- ${r.pluginSlug ?? r.pluginId} / ${r.operation} — ${r.state} (${r.trigger}, ${when}, run ${r.id})${tail}`;
}

/** The batches the active plugins offer, for the descriptions' "what exists". */
function offeredBatches(): string[] {
  const out: string[] = [];
  for (const p of loadedPlugins.all()) {
    for (const b of (p.definition.batchOperations ?? []) as PluginBatchOperation[]) {
      if (b.triggers.includes("operator")) out.push(`${p.slug}/${b.operation}: ${b.description}`);
    }
  }
  return out;
}

const startInput = z
  .object({
    pluginSlug,
    operation: z.string().min(1).max(120),
    /** What the batch takes (see the plugin's description of it); usually empty. */
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const startPluginBatchTool: ToolDefinitionWithHandler<z.infer<typeof startInput>> = {
  name: "start_plugin_batch",
  description:
    "Start a long task a plugin offers (a batch: it runs outside the admin and can take minutes). Returns at once with the run; follow it with list_plugin_batches. What it writes reaches the site with the next Stage and the operator's Publish live.\n" +
    "USE FOR: the operator asks a plugin to rebuild or recompute something, and the plugin offers that as a batch (get_plugin lists them).\n" +
    "DO NOT USE FOR: a batch that is already running (the tool says so), or for changing settings (update_plugin_config).",
  schema: startInput,
  inputSchema: generateInputSchema(startInput),
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "plugin_batches.start", input);
    if (!r.ok) {
      const offered = offeredBatches();
      return toolError(
        r.error,
        `plugin_batches.start failed: ${describeError(r.error)}${offered.length > 0 ? `\nBatches you can start: ${offered.join("; ")}` : ""}`,
      );
    }
    const run = (r.value as { run: BatchRun }).run;
    return {
      ok: true,
      content: `Started ${input.pluginSlug}/${input.operation} (run ${run.id}). It runs in the background; check it with list_plugin_batches.`,
      value: r.value,
    };
  },
};

const listInput = z
  .object({
    pluginSlug: pluginSlug.optional(),
    state: z.enum(["queued", "running", "completed", "failed", "stopped"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const listPluginBatchesTool: ToolDefinitionWithHandler<z.infer<typeof listInput>> = {
  name: "list_plugin_batches",
  description:
    "List plugin batch runs, newest first: what ran, how it was started (activation, operator, stage, schedule), how it ended, its result or error.\n" +
    "USE FOR: following a batch you started, or when the operator asks whether a plugin's background task ran.",
  schema: listInput,
  inputSchema: generateInputSchema(listInput),
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "plugin_batches.list", input);
    if (!r.ok) return toolError(r.error, `plugin_batches.list failed: ${describeError(r.error)}`);
    const runs = (r.value as { runs: BatchRun[] }).runs;
    return {
      ok: true,
      content: runs.length > 0 ? runs.map(runLine).join("\n") : "No batch runs.",
      value: r.value,
    };
  },
};

const stopInput = z.object({ runId: z.string().uuid() }).strict();

export const stopPluginBatchTool: ToolDefinitionWithHandler<z.infer<typeof stopInput>> = {
  name: "stop_plugin_batch",
  description:
    "Stop a plugin batch run that has not ended (queued or running). It ends at its next step; what it already wrote stays until the plugin writes again.\n" +
    "USE FOR: the operator no longer wants a running batch, or wants to start it again with other input.",
  schema: stopInput,
  inputSchema: generateInputSchema(stopInput),
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "plugin_batches.stop", input);
    if (!r.ok) return toolError(r.error, `plugin_batches.stop failed: ${describeError(r.error)}`);
    const v = r.value as { stopped: boolean; run: BatchRun | null };
    return {
      ok: true,
      content: v.stopped
        ? `Stopped run ${input.runId}.`
        : v.run
          ? `Run ${input.runId} had already ended (${v.run.state}).`
          : `There is no batch run ${input.runId}.`,
      value: v,
    };
  },
};

/** Registered by index.ts. */
export const PLUGIN_BATCH_TOOLS = [
  startPluginBatchTool,
  listPluginBatchesTool,
  stopPluginBatchTool,
] as const;
