// SPDX-License-Identifier: MPL-2.0

/**
 * What the next Publish live ships, as a note for the AI's
 * `list_unpublished_changes`: the same `deploy.publish_preview` the
 * operator's Publish live review shows, so the AI can say what publishing
 * would put live without guessing from the chat's own changes.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { PublishPreview } from "../../ops/deploy-publish-preview.js";
import { describeError } from "./_describe-error.js";
import type { ToolContext } from "./dispatch.js";

/** Examples named per group; the counts are always complete. */
const EXAMPLES = 5;

/** The note, starting with a newline; empty when Publish live has nothing to ship. */
export async function publishPreviewNote(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
): Promise<string> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "deploy.publish_preview", {
    limit: EXAMPLES,
  });
  if (!r.ok) return `\nWhat the next Publish live ships is unknown: ${describeError(r.error)}`;
  return describePublishPreview(r.value as PublishPreview);
}

const named = (items: readonly { path: string | null; title: string }[], total: number): string => {
  const shown = items.map((p) => p.path ?? p.title).join(", ");
  return total > items.length ? `${shown}, … (${total - items.length} more)` : shown;
};

/** The lines of {@link publishPreviewNote}. Exported for the unit tests. */
export function describePublishPreview(p: PublishPreview): string {
  if (p.liveMatchesStaging) return "\nThe next Publish live ships nothing: live already serves the staged build.";
  const lines = ["The next Publish live (the staged build, an operator's click) ships:"];
  if (p.notice !== null) lines.push(`- note: ${p.notice}`);
  const groups = [
    ["new pages", p.pages.new],
    ["changed pages", p.pages.changed],
    ["removed pages", p.pages.removed],
  ] as const;
  for (const [label, group] of groups) {
    if (group.total > 0) lines.push(`- ${label} (${group.total}): ${named(group.items, group.total)}`);
  }
  if (p.siteWide.length > 0) {
    lines.push(
      `- site-wide (${p.siteWide.length}): ${p.siteWide.map((s) => `${s.what} "${s.title}"${s.change === "changed" ? "" : ` (${s.change})`}`).join(", ")}`,
    );
  }
  if (p.settings.length > 0) {
    lines.push(`- settings (${p.settings.length}): ${p.settings.map((s) => s.title).join(", ")}`);
  }
  return lines.length > 1 ? `\n${lines.join("\n")}` : "";
}
