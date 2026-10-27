// SPDX-License-Identifier: MPL-2.0

/**
 * Hints on the AI's writes: every active plugin that declares a
 * `writeHintsOperation` is shown the module markup or content values the
 * AI just wrote, and may answer with sentences for the AI. Core appends
 * them to the tool result (admin-core `ai/tools/_plugin-write-hints.ts`),
 * so the AI corrects a mistake the plugin knows about in the same turn —
 * a hardcoded link to another language, say — instead of a Stage audit
 * finding it later.
 *
 * Read-only like a render: the call runs as a render invocation in the
 * writing chat's scope (its branch, so the plugin reads what the chat
 * sees) and cannot write. The same path for every plugin, shipped or
 * runtime-installed (CLAUDE.md §2 one plugin model).
 *
 * Loud: a failing call or a malformed answer is returned as an error for
 * that plugin, which the tool result shows. It never reads as "no hints",
 * and it never undoes the write, which already happened.
 */

import { type PluginWrite, pluginWriteHints } from "@caelo-cms/plugin-sdk";
import {
  isPluginDisabled,
  loadedPlugins,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";

/** One plugin's answer: its hints, or why it could not give any. */
export type PluginWriteHintsResult =
  | { readonly slug: string; readonly hints: readonly string[] }
  | { readonly slug: string; readonly error: string };

/** Slugs of the active plugins that give write hints, sorted. */
export function writeHintContributors(): string[] {
  return loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.writeHintsOperation === "string")
    .map((lp) => lp.slug)
    .sort();
}

/**
 * Ask every contributing plugin for hints on `writes`. Plugins without a
 * hint are left out of the result.
 *
 * @param chatBranchId the branch the AI wrote on (null = main).
 */
export async function collectPluginWriteHints(
  writes: readonly PluginWrite[],
  chatBranchId: string | null,
): Promise<PluginWriteHintsResult[]> {
  if (writes.length === 0) return [];
  const out: PluginWriteHintsResult[] = [];
  for (const slug of writeHintContributors()) {
    const lp = loadedPlugins.all().find((p) => p.slug === slug);
    const operationName = lp?.definition.writeHintsOperation;
    if (typeof operationName !== "string") continue;
    const r = await runPluginOperation({
      invocation: renderInvocation({ chatBranchId }),
      pluginSlug: slug,
      operationName,
      args: { writes },
    });
    if (!r.ok) {
      out.push({ slug, error: `${operationName} failed: ${r.error.kind}: ${r.error.message}` });
      continue;
    }
    const parsed = pluginWriteHints.safeParse(r.value);
    if (!parsed.success) {
      out.push({
        slug,
        error: `${operationName} returned an invalid answer: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      });
      continue;
    }
    if (parsed.data.hints.length > 0) out.push({ slug, hints: parsed.data.hints });
  }
  return out;
}
