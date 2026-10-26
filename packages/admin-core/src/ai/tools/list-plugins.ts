// SPDX-License-Identifier: MPL-2.0

/**
 * `list_plugins` — the AI's only window onto plugins that are installed
 * but NOT running.
 *
 * An inactive plugin is absent from everything else: its tools are not
 * in the catalogue, its skills are not in the `## Skills` index, its
 * ops do not dispatch. That is deliberate (CLAUDE.md §2 — activation is
 * a hard state), but it would leave the AI unable to answer "can this
 * site do translations?" with anything better than a guess. This tool,
 * plus the short installed-plugins line in the system prompt, is the
 * narrow exception: the AI can see that a capability EXISTS and offer
 * the operator the one click that turns it on.
 *
 * It deliberately does NOT return manifest JSON or source — the AI has
 * no use for either, and `plugins.list` carries both.
 */

import { z } from "zod";
import { makeListReadTool } from "./_make-read-tool.js";

const listPluginsInput = z.object({}).strict();

/** A plugin found on disk that failed verification before it was installed. */
interface DiscoveryFailureRow {
  slug: string;
  phase: string;
  errorClass: string;
  message: string;
  occurrences: number;
  lastSeenAt: string;
}

/**
 * The plugins found on disk that could not be verified, for the AI to
 * explain: they are not installed, have no status and appear nowhere else.
 * Null when there are none. Exported for its unit test.
 */
export function describeDiscoveryFailures(
  failures: ReadonlyArray<DiscoveryFailureRow>,
): string | null {
  if (failures.length === 0) return null;
  const lines = failures.map(
    (f) =>
      `- ${f.slug}: ${f.phase}, ${f.errorClass}, ${f.occurrences}x, last ${f.lastSeenAt}: ${f.message}`,
  );
  return (
    `Found on disk but could not be verified, so NOT installed (${failures.length}) — nothing of them is loaded and the Owner cannot activate them until they verify. ` +
    "Tell the operator: the plugin must be rebuilt (dist/index.js) and its manifest signed again, then the site redeployed or restarted.\n" +
    lines.join("\n")
  );
}

/** What `plugins.list` hands back, narrowed to the fields worth spending tokens on. */
interface PluginListRow {
  slug: string;
  version: string;
  status: string;
  tier: 1 | 2;
  health: { state: string; problem: { message: string } | null };
  requiresPlugins: string[];
  requiredBy: string[];
}

export const listPluginsTool = makeListReadTool<z.infer<typeof listPluginsInput>, PluginListRow>({
  name: "list_plugins",
  description:
    "List the plugins installed on this site: their status (the Owner's decision) and their health (what the running servers make of it). " +
    "`status`: `active` = the Owner wants it running; `awaiting_activation` = installed and verified, but nothing of it is loaded; `disabled` = the Owner stopped it. " +
    "Availability comes from `health`, not from `status`: only `health = running` means its tools and skills are usable right now. `failing` = an active plugin failed to load on a server (`problem` says why) — it is NOT switched off, tell the operator, get_plugin has the details; `unreported` = active, but no server has reported it yet (just activated or starting); `not_running` = not active. Never tell the operator a capability works while its plugin is failing. " +
    "Use when the operator asks for a capability you have no tool for (translation, forms, comments, newsletter, ratings): check whether a plugin for it is installed-but-inactive, and if so TELL the operator it exists and that one click at /settings/plugins turns it on. " +
    "`requires` = plugins that must be active before this one can be activated (activate those first, in that order); `required_by` = active plugins that need this one, so it cannot be disabled or uninstalled until they are. " +
    "Plugins found on disk that failed verification are listed after the table: they are NOT installed — explain why and the fix. " +
    "Do NOT use it as a general capability check before routine content work — your tool catalogue already reflects everything that is running.",
  opName: "plugins.list",
  input: listPluginsInput,
  label: "plugins",
  rows: (value) => (value as { plugins: PluginListRow[] }).plugins,
  columns: [
    { key: "slug", value: (p) => p.slug },
    { key: "status", value: (p) => p.status },
    { key: "version", value: (p) => p.version },
    { key: "health", value: (p) => p.health.state },
    { key: "requires", value: (p) => p.requiresPlugins.join(" ") },
    { key: "required_by", value: (p) => p.requiredBy.join(" ") },
    { key: "problem", value: (p) => p.health.problem?.message ?? "" },
  ],
  emptyMessage: "No plugins installed on this site.",
  appendix: (value) =>
    describeDiscoveryFailures(
      (value as { discoveryFailures: DiscoveryFailureRow[] }).discoveryFailures,
    ),
});
