// SPDX-License-Identifier: MPL-2.0

/**
 * P10 — `start_translation_job`. Queues a bulk translation run; the
 * in-process worker walks units sequentially. AI calls this when the
 * user asks for "translate everything" / "translate all stale" /
 * "translate all of de" — single-page calls go through `translate_page`.
 */

import { execute } from "@caelo/query-api";
import { type StartTranslationJobToolInput, startTranslationJobToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const startTranslationJobTool: ToolDefinitionWithHandler<StartTranslationJobToolInput> = {
  name: "start_translation_job",
  description:
    "Queue a bulk translation run. `scope` can be: " +
    "`{kind: 'all-stale'}` (every needs_update + not_started across the site), " +
    "`{kind: 'page', pageId}` (one page across all target locales), " +
    "`{kind: 'locale', code}` (every stale page in one locale), " +
    "or `{kind: 'pages', pageIds: [...]}` (an explicit page list across all locales). " +
    "Optional `capMicrocents` is a soft cost cap; the worker pauses the job at unit boundaries when reached. " +
    "Returns a jobId; the user reviews progress at /content/translations. " +
    "All produced variants land as DRAFT — the user must confirm each page via the publish flow. DO NOT claim the translations are published.",
  schema: startTranslationJobToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["scope"],
    properties: {
      scope: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind"],
            properties: { kind: { const: "all-stale" } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "pageId"],
            properties: {
              kind: { const: "page" },
              pageId: { type: "string", format: "uuid" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "code"],
            properties: {
              kind: { const: "locale" },
              code: { type: "string", pattern: "^[a-z]{2,3}(-[A-Za-z]{2,4})?$" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "pageIds"],
            properties: {
              kind: { const: "pages" },
              pageIds: {
                type: "array",
                items: { type: "string", format: "uuid" },
                minItems: 1,
                maxItems: 500,
              },
            },
          },
        ],
      },
      capMicrocents: { type: ["integer", "null"], minimum: 0 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "translation_jobs.create",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `start_translation_job failed: ${describeError(r.error)}` };
    }
    const { jobId, totalUnits } = r.value as { jobId: string; totalUnits: number };
    return {
      ok: true,
      content:
        `Queued translation job ${jobId} with ${totalUnits} (page, locale) unit${totalUnits === 1 ? "" : "s"}. ` +
        `The worker processes units sequentially; track progress at /content/translations. ` +
        `Each completed unit produces a DRAFT page — the user must confirm via the publish flow.`,
    };
  },
};
