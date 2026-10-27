// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin write hints in the AI's tool results: after a successful module
 * or content write, every active plugin with a `writeHintsOperation`
 * (plugin-host `write-hints.ts`) sees what was written and may answer
 * with sentences for the AI. A mistake the plugin knows about — a link
 * hardcoded to another language's page, say — is then fixed in the same
 * turn instead of being found by the next Stage audit.
 *
 * Module writes are shown as STORED (html + fields after the write, read
 * branch-aware like the write): the extractor may have moved literal
 * content into field defaults, and that is what renders.
 *
 * The text is the plugin's, so it is labelled with the plugin slug. A
 * plugin that fails says so in the result (loud, CLAUDE.md §2); the
 * write it comments on has already succeeded either way.
 */

import { collectPluginWriteHints, writeHintContributors } from "@caelo-cms/plugin-host";
import type { PluginWrite } from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { ToolContext, ToolDefinitionWithHandler } from "./dispatch.js";

/** Suffix for the tool result ("" when no plugin has anything to say). */
export async function pluginWriteHintsSuffix(
  ctx: ExecutionContext,
  writes: readonly PluginWrite[],
): Promise<string> {
  const results = await collectPluginWriteHints(writes, ctx.chatBranchId ?? null);
  if (results.length === 0) return "";
  return results
    .map((r) =>
      "error" in r
        ? ` ⚠️ plugin ${r.slug} could not check this write: ${r.error}`
        : ` 🎯 plugin ${r.slug}: ${r.hints.join(" ")}`,
    )
    .join("");
}

/** The stored module rows `moduleIds` name, as module writes for the hints. */
export async function storedModuleWrites(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  moduleIds: readonly string[],
): Promise<PluginWrite[]> {
  // Nobody to show them to: no read on every module write.
  if (writeHintContributors().length === 0) return [];
  const out: PluginWrite[] = [];
  for (const moduleId of new Set(moduleIds)) {
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.get", {
      moduleId,
    });
    // The write being commented on just succeeded on this module; a
    // failed read would be a bug, and it only costs the hint.
    if (!got.ok) continue;
    const m = (got.value as { module: { html: string; fields: unknown } }).module;
    out.push({
      kind: "module",
      moduleId,
      html: m.html,
      fields: Array.isArray(m.fields) ? (m.fields as Record<string, unknown>[]) : [],
    });
  }
  return out;
}

/**
 * Wrap a module-writing tool: a successful write carries the plugins'
 * hints on the modules `moduleIdsOf` names.
 */
export function withPluginModuleHints<T>(
  tool: ToolDefinitionWithHandler<T>,
  moduleIdsOf: (input: T) => readonly string[],
): ToolDefinitionWithHandler<T> {
  return {
    ...tool,
    handler: async (ctx, input, toolCtx) => {
      const result = await tool.handler(ctx, input, toolCtx);
      if (!result.ok) return result;
      const suffix = await pluginWriteHintsSuffix(
        ctx,
        await storedModuleWrites(ctx, toolCtx, moduleIdsOf(input)),
      );
      return suffix ? { ...result, content: `${result.content}${suffix}` } : result;
    },
  };
}
