// SPDX-License-Identifier: MPL-2.0

/**
 * The seo plugin's settings (core's plugin configuration, #1645): stored by
 * core, shown to the operator as a generated form and to the AI through
 * `get_plugin_config` / `update_plugin_config`. Each feature adds its own
 * leaves here; read them with `ctx.config.get()`.
 */

import type { ConfigFieldInput } from "@caelo-cms/plugin-sdk";
import { LLMS_TXT_CONFIG, LLMS_TXT_SETTING } from "./rules/agent-files.js";

/** The plugin-wide settings. */
export const SEO_CONFIG: Readonly<Record<string, ConfigFieldInput>> = {
  topic_page_threshold: {
    type: "int",
    label: "Articles before a topic page is suggested",
    description:
      "A term (category or tag) gets a topic page suggestion once this many published pages carry it. A term never makes a page by itself; the AI only suggests one.",
    effect: "none",
    scope: "immediate",
    min: 2,
    max: 100,
    default: 5,
  },
  // #1763 — off by default; see agent-files.ts.
  [LLMS_TXT_SETTING]: LLMS_TXT_CONFIG,
};
