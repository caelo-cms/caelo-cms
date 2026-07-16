// SPDX-License-Identifier: MPL-2.0

/**
 * `propose_set_default_locale` — two-step per CLAUDE.md §11.A. Built with
 * `makeProposeTool` so the two-step contract wording comes from the factory
 * rather than a hand-copy that can drift.
 */

import {
  type ProposeSetDefaultLocaleToolInput,
  proposeSetDefaultLocaleToolInput,
} from "@caelo-cms/shared";
import { makeProposeTool } from "./_make-propose-tool.js";

export const proposeSetDefaultLocaleTool = makeProposeTool<ProposeSetDefaultLocaleToolInput>({
  toolName: "propose_set_default_locale",
  opName: "locales.propose_set_default",
  pendingQueuePath: "/security/locales/pending",
  when:
    "Propose changing which locale is the site's default. " +
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
  summarize: (input) => `set '${input.code}' as the default locale`,
});
