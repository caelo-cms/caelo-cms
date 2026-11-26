// SPDX-License-Identifier: MPL-2.0

/**
 * The site assistant's configuration (epic #1644, issue #1655).
 *
 * What shapes the answers visitors read is release-bound and
 * visitor-visible: a Stage freezes it, Publish live ships it to the
 * gateway, which puts it after the core's rules in the system prompt
 * (docs/dev/visitor-ai.md). What visitors are told to do when the
 * assistant cannot help is the site's promise (a reply time, a phone
 * line), so it needs the Owner's click (CLAUDE.md §11.A); so does keeping
 * visitors' questions for the gap report.
 *
 * The interface texts (button, greeting, disclosure, privacy link) are
 * not here: they are the site's own markup, written by the AI into the
 * module around the widget as `{{site_text.*}}`, so they translate like
 * every other text of the site (skills.ts).
 */

import type { ConfigFieldInput, ListTypeDef } from "@caelo-cms/plugin-sdk";

/** Slugs of the list types the plugin ships. */
export const LIST_TYPES = {
  testQuestions: "site-assistant-test-questions",
} as const;

/** The conversation's name in the gateway's URL (`/api/plugin/site-assistant/ask`). */
export const CONVERSATION = "ask";

/** The plugin's configuration schema. */
export const SITE_ASSISTANT_CONFIG: Readonly<Record<string, ConfigFieldInput>> = {
  assistant: {
    type: "group",
    label: "Assistant",
    description:
      "How the assistant answers. Each text goes to the AI that answers visitors, after the rules Caelo sets (answer only from the site's pages, cite them, never act). Where visitors ask is markup, not a setting: a floating widget on every page, an answer card on the search results page, or an ask card in any page (get_site_assistant_setup).",
    fields: {
      persona: {
        type: "string",
        label: "Who it is and how it speaks",
        description:
          "One or two sentences: its role and tone, in the brand's voice (e.g. 'You are the helpful voice of a small software company: friendly, brief, no marketing language.').",
        effect: "query",
        maxLength: 600,
        multiline: true,
        default: "You are the website's assistant: friendly, brief and factual.",
        visitorVisible: true,
      },
      scope: {
        type: "string",
        label: "What it answers about",
        description:
          "The topics it helps with and what it politely declines (e.g. 'Products, prices, shipping and support of this shop. Decline anything else, including general questions not about this site.').",
        effect: "query",
        maxLength: 1200,
        multiline: true,
        default:
          "Questions about this website's content. Politely decline questions that are not about this website.",
        visitorVisible: true,
      },
      handoff: {
        type: "string",
        label: "When it cannot help",
        description:
          "What it tells visitors when the site has no answer or they need a person: where to turn (the contact page, phone hours). Visitors read it as the site's promise, so a change needs the Owner's approval.",
        effect: "query",
        gate: "approval",
        maxLength: 600,
        multiline: true,
        default:
          "When the website does not answer the question, say so and suggest the contact page.",
        visitorVisible: true,
      },
      handoff_page: {
        type: "pageRef",
        label: "Contact page",
        description:
          "The page visitors are sent to when the assistant cannot help. The Stage audit checks the assistant can find it; the contact link of the widget and of every card points to it.",
        effect: "none",
        default: null,
      },
    },
  },
  feedback: {
    type: "group",
    label: "Feedback",
    description:
      "Visitors rate answers (helpful, not helpful); an answer without a source counts as unanswered. Nothing is kept unless this is on.",
    fields: {
      enabled: {
        type: "bool",
        label: "Keep feedback for the gap report",
        description:
          "Keeps each rating with the question it rated and an optional note (language and day; no answer, no conversation, no address, no visitor id, no cookie); text that looks like an e-mail address, a phone number or a long number is dropped. Kept 30 days. Off: nothing is stored and the widget shows no rating buttons.",
        effect: "pages",
        gate: "approval",
        default: false,
        // Published with the release: the feedback inbox stores only while
        // the released value is on (`onlyIf: { config }`).
        visitorVisible: true,
      },
    },
  },
  lists: {
    type: "group",
    label: "Lists",
    description: "The lists the assistant reads (Settings → Lists).",
    fields: {
      test_questions: {
        type: "listRef",
        label: "Test questions",
        description:
          "Questions checked at every Stage against the staged index: an answerable one must find its expected page among the sources, an off-topic one must find nothing it could answer from.",
        effect: "none",
        listType: LIST_TYPES.testQuestions,
        default: null,
      },
    },
  },
};

/** The list types the plugin ships (owned by it, live while it runs). */
export const SITE_ASSISTANT_LIST_TYPES: readonly ListTypeDef[] = [
  {
    slug: LIST_TYPES.testQuestions,
    name: "Site assistant test questions",
    purpose:
      "Questions checked at every Stage against the staged search index: what the assistant must answer from a page, and what it must decline.",
    role: "content",
    root: { allow: ["question"] },
    nodes: {
      question: {
        label: "Test question",
        fields: [
          { name: "question", label: "Question", type: "text", required: true, maxLength: 300 },
          {
            name: "expect",
            label: "Page the answer must come from (empty: the question is off-topic)",
            type: "link",
          },
          { name: "lang", label: "Language (default: the site's)", type: "text", maxLength: 16 },
        ],
      },
    },
  },
];
