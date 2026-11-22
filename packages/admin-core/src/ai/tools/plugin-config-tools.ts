// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R6, issue #1645) — the AI's surface for plugin configuration.
 * Every plugin that declares `config` or `entityConfig` gets these tools
 * without writing any of its own: read the fields with what each one does,
 * dry-run a change, apply routine changes on the chat's branch, propose
 * approval-gated ones, and set per-entity fields in bulk.
 */

import { loadedPlugins, runPluginOperation } from "@caelo-cms/plugin-host";
import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { pluginConfigProposeInput } from "../../ops/plugin_config_pending.js";
import { describeError, toolError } from "./_describe-error.js";
import { makeProposeTool } from "./_make-propose-tool.js";
import { makeReadTool } from "./_make-read-tool.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";
import { generateInputSchema } from "./generate-input-schema.js";

const pluginSlug = z.string().regex(/^[a-z][a-z0-9-]{0,54}$/);

interface FieldInfo {
  readonly path: string;
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly effect: string;
  readonly gate: string;
  readonly scope: string;
  readonly allowed: string;
}

function fieldLine(f: FieldInfo, value?: unknown): string {
  const flags = [
    f.effect !== "none" ? `effect ${f.effect}` : null,
    f.gate === "approval" ? "APPROVAL" : null,
    f.scope === "immediate" ? "immediate" : null,
  ].filter(Boolean);
  const current = value === undefined ? "" : ` = ${JSON.stringify(value)}`;
  return `- ${f.path}${current} (${f.allowed}${flags.length ? `; ${flags.join(", ")}` : ""}): ${f.label}. ${f.description}`;
}

function valueAt(values: Record<string, unknown>, path: string): unknown {
  let at: unknown = values;
  for (const part of path.split(".")) at = (at as Record<string, unknown> | undefined)?.[part];
  return at;
}

const EFFECT_NOTE =
  "Effects: query = the next search request after Publish live; pages / rebuild = the plugin re-reads pages at the next Stage. Release fields wait for Stage + Publish live; immediate ones apply at once.";

export const getPluginConfigTool = makeReadTool({
  name: "get_plugin_config",
  description:
    "Read a plugin's configuration: every field with its current value, what it does, allowed values, and whether it needs approval. Also lists the per-entity fields (page, module, content instance, page type).\n" +
    "USE FOR: before update_plugin_config, propose_plugin_config or set_plugin_entity_config_many; when the operator asks how a plugin is set up.",
  opName: "plugin_config.get",
  input: z.object({ pluginSlug }).strict(),
  format: (value, input) => {
    const v = value as {
      values: Record<string, unknown>;
      fields: FieldInfo[];
      entityFields: Record<string, FieldInfo[]>;
    };
    const lines = [`Configuration of ${input.pluginSlug} (as this chat sees it):`];
    for (const f of v.fields) lines.push(fieldLine(f, valueAt(v.values, f.path)));
    for (const [kind, fields] of Object.entries(v.entityFields)) {
      lines.push(`Per ${kind} (set with set_plugin_entity_config_many; unset = default):`);
      for (const f of fields) lines.push(fieldLine(f));
    }
    lines.push(EFFECT_NOTE);
    return lines.join("\n");
  },
});

const patchInput = z.object({ pluginSlug, patch: z.record(z.string(), z.unknown()) }).strict();

export const previewPluginConfigTool: ToolDefinitionWithHandler<z.infer<typeof patchInput>> = {
  name: "preview_plugin_config",
  description:
    "Dry-run a configuration change: which fields move from what to what, and, when the plugin offers one, its own report (e.g. how test queries' results would change). Writes nothing.\n" +
    "USE FOR: a change whose result the operator should see first.",
  schema: patchInput,
  inputSchema: generateInputSchema(patchInput),
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "plugin_config.preview", input);
    if (!r.ok) return toolError(r.error, `plugin_config.preview failed: ${describeError(r.error)}`);
    const changes = (
      r.value as {
        changes: { path: string; label: string; before: unknown; after: unknown; gate: string }[];
      }
    ).changes;
    const lines = changes.map(
      (c) =>
        `- ${c.label} (${c.path}): ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}${c.gate === "approval" ? " [needs approval]" : ""}`,
    );
    if (lines.length === 0) lines.push("The patch changes nothing.");
    const declared = loadedPlugins.bySlug(input.pluginSlug)?.definition.configPreviewOperation;
    if (declared) {
      const report = await runPluginOperation({
        pluginSlug: input.pluginSlug,
        operationName: declared,
        args: { patch: input.patch },
        invocation: {
          origin: "chat",
          actorId: ctx.actorId,
          ...(ctx.chatBranchId ? { chatBranchId: ctx.chatBranchId } : {}),
          ...(ctx.chatTaskId ? { chatTaskId: ctx.chatTaskId } : {}),
        },
      });
      lines.push(
        report.ok
          ? `Plugin report: ${typeof report.value === "string" ? report.value : JSON.stringify(report.value)}`
          : `The plugin's preview failed: ${report.error.message}`,
      );
    }
    return { ok: true, content: lines.join("\n"), value: { changes } };
  },
};

export const updatePluginConfigTool: ToolDefinitionWithHandler<z.infer<typeof patchInput>> = {
  name: "update_plugin_config",
  description:
    "Change a plugin's configuration with a merge patch: send only the fields that change, groups nested, a map key set to null takes its default. Lands on this chat's draft like any edit; undo works.\n" +
    "DO NOT USE FOR: fields marked APPROVAL in get_plugin_config (propose_plugin_config).",
  schema: patchInput,
  inputSchema: generateInputSchema(patchInput),
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "plugin_config.update", input);
    if (!r.ok) return toolError(r.error, `plugin_config.update failed: ${describeError(r.error)}`);
    const changed = (r.value as { changed: { path: string; effect: string; scope: string }[] })
      .changed;
    if (changed.length === 0)
      return { ok: true, content: "Nothing changed: the values were already set." };
    const staged = changed.filter((c) => c.scope !== "immediate");
    const tail =
      staged.length > 0
        ? " Visitors see it after a Stage and the operator's Publish live; offer the Stage when the work is done."
        : " Applied at once.";
    return {
      ok: true,
      content: `Changed ${changed.map((c) => c.path).join(", ")}.${tail}`,
      value: r.value,
    };
  },
};

export const proposePluginConfigTool = makeProposeTool({
  toolName: "propose_plugin_config",
  opName: "plugin_config.propose_update",
  pendingQueuePath: "/settings/plugin-config",
  approvalPreviewOp: "plugin_config.preview",
  when:
    "Change plugin configuration fields marked APPROVAL in get_plugin_config (cost limits and the like). The patch may include routine fields; all apply together after the approval.\n" +
    "DO NOT USE FOR: a patch without an APPROVAL field (update_plugin_config). `reason` is shown to the operator: say why in their terms.",
  schema: pluginConfigProposeInput,
  summarize: (_input, preview) => `plugin configuration: ${String(preview.summary ?? "?")}`,
});

const entityInput = z
  .object({
    pluginSlug,
    items: z
      .array(
        z
          .object({
            kind: z.enum(["page", "module", "contentInstance", "pageType"]),
            id: z.string().min(1).max(200),
            /** Fields to set; null takes the default again. */
            values: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

export const setPluginEntityConfigManyTool: ToolDefinitionWithHandler<z.infer<typeof entityInput>> =
  {
    name: "set_plugin_entity_config_many",
    description:
      "Set a plugin's per-entity fields (e.g. how a module counts for search) for many pages, modules, content instances or page types in one call; null takes the default again. Lands on this chat's draft.\n" +
      "USE FOR: overrides the operator asks for, after get_plugin_config shows the fields.",
    schema: entityInput,
    inputSchema: generateInputSchema(entityInput),
    handler: async (ctx, input, toolCtx) => {
      const r = await execute(
        toolCtx.registry,
        toolCtx.adapter,
        ctx,
        "plugin_config.set_entities",
        input,
      );
      if (!r.ok)
        return toolError(r.error, `plugin_config.set_entities failed: ${describeError(r.error)}`);
      const written = (r.value as { written: number }).written;
      return {
        ok: true,
        content: `${written} of ${input.items.length} ${input.items.length === 1 ? "entity" : "entities"} changed. They apply with the next Stage and the operator's Publish live.`,
        value: r.value,
      };
    },
  };

/** Every plugin configuration tool. */
export const PLUGIN_CONFIG_TOOLS = [
  getPluginConfigTool,
  previewPluginConfigTool,
  updatePluginConfigTool,
  proposePluginConfigTool,
  setPluginEntityConfigManyTool,
] as const;
