// SPDX-License-Identifier: MPL-2.0

/**
 * `propose_remove_locale` — two-step per CLAUDE.md §11.A. Built with
 * `makeProposeTool` so the two-step contract wording comes from the factory
 * rather than a hand-copy that can drift.
 */

import { type ProposeRemoveLocaleToolInput, proposeRemoveLocaleToolInput } from "@caelo-cms/shared";
import { makeProposeTool } from "./_make-propose-tool.js";

export const proposeRemoveLocaleTool = makeProposeTool<ProposeRemoveLocaleToolInput>({
  toolName: "propose_remove_locale",
  opName: "locales.propose_delete",
  pendingQueuePath: "/security/locales/pending",
  when:
    "Propose removing a locale from the site. " +
    "The proposal preview reports how many pages currently exist in that locale and how many redirects will be needed to avoid broken links — surface that count to the user. " +
    "The default locale cannot be removed; ask the Owner to set a different default first via `propose_set_default_locale`. " +
    "Removal at execute time fails if pages still exist in the locale; tell the user to delete or move those pages first.",
  schema: proposeRemoveLocaleToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["code"],
    properties: {
      code: { type: "string", pattern: "^[a-z]{2,3}(-[A-Za-z]{2,4})?$" },
    },
  },
  summarize: (input) => `remove locale '${input.code}'`,
});
