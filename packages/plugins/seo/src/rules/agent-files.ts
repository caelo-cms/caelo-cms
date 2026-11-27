// SPDX-License-Identifier: MPL-2.0

/**
 * #1763 — the llms.txt switch. Core builds `/llms.txt` from the build's
 * indexing state (static-generator llms-txt.ts); this plugin only says
 * whether it should exist, from its setting `llms_txt` (off by default,
 * scope `release`: a change waits for the Stage and Publish live like any
 * other output). Plugins own no routes and write no files (#1729).
 */

import type { ConfigFieldInput, PluginAgentFiles, PluginContextTier1 } from "@caelo-cms/plugin-sdk";

/** The operation core calls at every build (`agentFilesOperation`). */
export const AGENT_FILES_OPERATION = "agent_files";

/** The setting's key in the plugin's configuration. */
export const LLMS_TXT_SETTING = "llms_txt";

/** The setting, with what it is worth said plainly. */
export const LLMS_TXT_CONFIG: ConfigFieldInput = {
  type: "bool",
  label: "Publish llms.txt for AI agents",
  description:
    "Writes /llms.txt: the site's indexable pages by page type, with title, address and meta description, for AI tools that read it (coding assistants do). It is no ranking lever: Google reads none of it and says AI search needs no special file, and a 2026 log study found 97% of llms.txt files never requested. Off by default; the next Stage writes or drops it, Publish live takes that live.",
  effect: "pages",
  scope: "release",
  default: false,
};

/** `agent_files`: llms.txt on or off, as the setting says on the main line. */
export async function agentFiles(ctx: PluginContextTier1): Promise<PluginAgentFiles> {
  if (!ctx.config) throw new Error("seo: the plugin's configuration is not attached");
  const config = (await ctx.config.get()) as Record<string, unknown>;
  const on = config[LLMS_TXT_SETTING];
  if (typeof on !== "boolean") {
    throw new Error(
      `seo: the setting ${LLMS_TXT_SETTING} is ${JSON.stringify(on)}, not a yes or no; activation seeds it, so the stored configuration is broken — set it again with update_plugin_config`,
    );
  }
  return { llmsTxt: on };
}
