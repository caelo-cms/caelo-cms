// SPDX-License-Identifier: MPL-2.0

/**
 * P9 — `propose_add_locale`. Two-step per CLAUDE.md §11.A: AI queues
 * the proposal; an Owner clicks Approve at /security/locales/pending
 * to apply. AI calls to the execute path hit ActorScopeRejected.
 */

import { execute } from "@caelo-cms/query-api";
import { type ProposeAddLocaleToolInput, proposeAddLocaleToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const proposeAddLocaleTool: ToolDefinitionWithHandler<ProposeAddLocaleToolInput> = {
  name: "propose_add_locale",
  description:
    "Propose adding a new locale (language) to the site. " +
    "TWO-STEP: this only QUEUES the change — an Owner must click Approve at /security/locales/pending to apply it. " +
    "Do NOT claim the locale was added; tell the user the proposal is queued and link them to the queue. " +
    "Inputs: code (BCP-47, e.g. 'de' or 'de-AT'), displayName, urlStrategy ('none' | 'subdirectory' | 'subdomain' | 'domain'), urlHost (required for subdomain/domain). " +
    "Default urlStrategy is 'subdirectory' — leave it unless the user explicitly asks for subdomain/domain. " +
    "Subdomain + domain require the Advanced URL Routing toggle (Owner enables under /security/locales).",
  schema: proposeAddLocaleToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["code", "displayName"],
    properties: {
      code: {
        type: "string",
        pattern: "^[a-z]{2,3}(-[A-Za-z]{2,4})?$",
        description: "BCP-47 code, e.g. 'en' or 'de-AT'",
      },
      displayName: { type: "string", minLength: 1, maxLength: 120 },
      urlStrategy: {
        type: "string",
        enum: ["none", "subdirectory", "subdomain", "domain"],
        default: "subdirectory",
      },
      urlHost: { type: ["string", "null"], minLength: 1, maxLength: 253 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "locales.propose_create",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `propose_add_locale failed: ${describeError(r.error)}` };
    }
    const { proposalId, preview } = r.value as { proposalId: string; preview: unknown };
    return {
      ok: true,
      content:
        `Queued proposal ${proposalId} to add locale '${input.code}' (${input.urlStrategy}). ` +
        `Preview: ${JSON.stringify(preview)}. ` +
        `An Owner must click Approve at /security/locales/pending to apply.`,
    };
  },
};
