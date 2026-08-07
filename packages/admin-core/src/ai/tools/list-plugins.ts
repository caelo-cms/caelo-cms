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

/** What `plugins.list` hands back, narrowed to the fields worth spending tokens on. */
interface PluginListRow {
  slug: string;
  version: string;
  status: string;
  tier: 1 | 2;
}

export const listPluginsTool = makeListReadTool<z.infer<typeof listPluginsInput>, PluginListRow>({
  name: "list_plugins",
  description:
    "List the plugins installed on this site with their activation status. " +
    "`active` means the plugin is running and its tools and skills are available to you right now; " +
    "`awaiting_activation` means it is installed and verified but NOTHING of it is loaded — you cannot call its tools and its skills are not in your skills index. " +
    "Use when the operator asks for a capability you have no tool for (translation, forms, comments, newsletter, ratings): check whether a plugin for it is installed-but-inactive, and if so TELL the operator it exists and that one click at /security/plugins turns it on. " +
    "Do NOT use it as a general capability check before routine content work — your tool catalogue already reflects everything that is running.",
  opName: "plugins.list",
  input: listPluginsInput,
  label: "plugins",
  rows: (value) => (value as { plugins: PluginListRow[] }).plugins,
  columns: [
    { key: "slug", value: (p) => p.slug },
    { key: "status", value: (p) => p.status },
    { key: "version", value: (p) => p.version },
  ],
  emptyMessage: "No plugins installed on this site.",
});
