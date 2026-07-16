// SPDX-License-Identifier: MPL-2.0

/**
 * P9 — `propose_add_locale`. Two-step per CLAUDE.md §11.A: AI queues
 * the proposal; the operator approves on the chat's proposal card
 * to apply. AI calls to the execute path hit ActorScopeRejected.
 *
 * Built with `makeProposeTool` so the two-step contract wording is the
 * factory's, not a hand-copy — this tool used to spell it out itself and had
 * already drifted (it told the AI to "link them to the queue", i.e. point the
 * operator at an admin page, which is the exact thing the factory's wording
 * exists to prevent).
 */

import { type ProposeAddLocaleToolInput, proposeAddLocaleToolInput } from "@caelo-cms/shared";
import { makeProposeTool } from "./_make-propose-tool.js";

export const proposeAddLocaleTool = makeProposeTool<ProposeAddLocaleToolInput>({
  toolName: "propose_add_locale",
  opName: "locales.propose_create",
  pendingQueuePath: "/security/locales/pending",
  when:
    "Propose adding a new locale (language) to the site. " +
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
  summarize: (input) => `add locale '${input.code}' (${input.urlStrategy ?? "subdirectory"})`,
});
