// SPDX-License-Identifier: MPL-2.0

/**
 * The seo plugin's AI tools (the `chat_runner_tools` grant). Each tool
 * dispatches to an operation in the definition's `operations`; each feature
 * adds its tools here and its operations to `operations.ts`.
 *
 * Tool texts follow docs/dev/ai-tool-texts.md: what the tool does in one
 * sentence, `USE FOR` / `DO NOT USE FOR` with the neighbouring tools named,
 * details on the property they concern, no retelling of the schema.
 */

import type { PluginToolSpec } from "@caelo-cms/plugin-sdk";

/** Every tool the plugin registers while it is active. */
export const SEO_TOOLS: readonly PluginToolSpec[] = [];
