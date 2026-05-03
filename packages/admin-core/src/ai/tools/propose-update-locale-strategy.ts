// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import {
  type ProposeUpdateLocaleStrategyToolInput,
  proposeUpdateLocaleStrategyToolInput,
} from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const proposeUpdateLocaleStrategyTool: ToolDefinitionWithHandler<ProposeUpdateLocaleStrategyToolInput> =
  {
    name: "propose_update_locale_strategy",
    description:
      "Propose changing a locale's URL strategy (e.g. 'subdirectory' → 'subdomain'). " +
      "TWO-STEP: queues the change; an Owner clicks Approve at /security/locales/pending to apply. " +
      "Do NOT claim the strategy was changed. " +
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
    handler: async (ctx, input, toolCtx) => {
      const r = await execute(
        toolCtx.registry,
        toolCtx.adapter,
        ctx,
        "locales.propose_update_strategy",
        input,
      );
      if (!r.ok) {
        return {
          ok: false,
          content: `propose_update_locale_strategy failed: ${describeError(r.error)}`,
        };
      }
      const { proposalId, preview } = r.value as { proposalId: string; preview: unknown };
      return {
        ok: true,
        content:
          `Queued proposal ${proposalId} to change locale '${input.code}' URL strategy to '${input.urlStrategy}'. ` +
          `Preview: ${JSON.stringify(preview)}. ` +
          `An Owner must click Approve at /security/locales/pending to apply.`,
      };
    },
  };
