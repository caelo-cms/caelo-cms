// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import {
  type ProposeSetDefaultLocaleToolInput,
  proposeSetDefaultLocaleToolInput,
} from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const proposeSetDefaultLocaleTool: ToolDefinitionWithHandler<ProposeSetDefaultLocaleToolInput> =
  {
    name: "propose_set_default_locale",
    description:
      "Propose changing which locale is the site's default. " +
      "TWO-STEP: queues the change; an Owner clicks Approve at /security/locales/pending to apply. " +
      "Do NOT claim the default was changed. " +
      "Caveat: swapping the default rewrites URL paths for every non-default-locale page (the new default may drop its prefix; the old default may gain one). " +
      "The proposal preview reports how many pages would shift URLs.",
    schema: proposeSetDefaultLocaleToolInput,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: {
        code: { type: "string", pattern: "^[a-z]{2,3}(-[A-Za-z]{2,4})?$" },
      },
    },
    handler: async (ctx, input, toolCtx) => {
      const r = await execute(
        toolCtx.registry,
        toolCtx.adapter,
        ctx,
        "locales.propose_set_default",
        input,
      );
      if (!r.ok) {
        return {
          ok: false,
          content: `propose_set_default_locale failed: ${describeError(r.error)}`,
        };
      }
      const { proposalId, preview } = r.value as { proposalId: string; preview: unknown };
      return {
        ok: true,
        content:
          `Queued proposal ${proposalId} to set '${input.code}' as the default locale. ` +
          `Preview: ${JSON.stringify(preview)}. ` +
          `An Owner must click Approve at /security/locales/pending to apply.`,
      };
    },
  };
