// SPDX-License-Identifier: MPL-2.0

/**
 * `propose_update_locale_strategy` — two-step per CLAUDE.md §11.A. Built with
 * `makeProposeTool` so the two-step contract wording comes from the factory
 * rather than a hand-copy that can drift.
 */

import {
  type ProposeUpdateLocaleStrategyToolInput,
  proposeUpdateLocaleStrategyToolInput,
} from "@caelo-cms/shared";
import { makeProposeTool } from "./_make-propose-tool.js";

export const proposeUpdateLocaleStrategyTool =
  makeProposeTool<ProposeUpdateLocaleStrategyToolInput>({
    toolName: "propose_update_locale_strategy",
    opName: "locales.propose_update_strategy",
    pendingQueuePath: "/security/locales/pending",
    when:
      "Propose changing a locale's URL strategy (e.g. 'subdirectory' → 'subdomain'). " +
      "URL strategies: 'none' (no prefix), 'subdirectory' (/de/page), 'subdomain' (de.example.com), 'domain' (example.de). " +
      "Subdomain + domain require a urlHost AND the Advanced URL Routing toggle (Owner enables under /security/locales) AND SSL/DNS/CDN configuration before publish. " +
      "The proposal preview reports how many pages would shift URLs and how many redirects will be needed.",
    schema: proposeUpdateLocaleStrategyToolInput,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["code", "urlStrategy"],
      properties: {
        code: { type: "string", pattern: "^[a-z]{2,3}(-[A-Za-z]{2,4})?$" },
        urlStrategy: { type: "string", enum: ["none", "subdirectory", "subdomain", "domain"] },
        urlHost: { type: ["string", "null"], minLength: 1, maxLength: 253 },
      },
    },
    summarize: (input) => `change locale '${input.code}' URL strategy to '${input.urlStrategy}'`,
  });
