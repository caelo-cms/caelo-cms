# The site assistant

`packages/plugins/site-assistant` (epic #1644, issue #1655): an AI chat assistant for visitors that answers from the site's own pages, with links to them. It does not act, submits nothing and promises nothing that is not on the site. It is a plugin on the visitor AI ([visitor-ai.md](./visitor-ai.md)) and the site search ([site-search.md](./site-search.md)); the gateway runs its conversation with core code and no plugin code.

## The conversation

One `ai-chat` operation, `ask`: `requestedCapabilities` includes `visitor_ai`, `requires: ["visitor-ai"]`, `requiresPlugins: ["site-search"]`. Its tools are site-search's `search` and `read`, nothing else. Its prompt fields are three released, `visitorVisible` config leaves, which the gateway puts after the core's rules:

| Leaf | What it is | Gate |
|---|---|---|
| `assistant.persona` | role and tone in the brand voice | routine |
| `assistant.scope` | the topics it answers and that it declines the rest | routine |
| `assistant.handoff` | what it says when it cannot help, where to turn | approval (§11.A): visitors read it as the site's promise |

`assistant.handoff_page` (a page reference, not visitor-visible) names the contact page; the Stage audit checks it, the widget's handoff link points to it. Limits are the declaration's (8 questions, 500 characters, 600 output tokens per step); the Owner's visitor-AI settings may lower them. Activation refuses until site-search is active and the visitor AI can run (a key and budgets).

## The widget

A client asset (`runtime.ts`, `buildAssets`), bound to markup the AI writes into a layout module, so the launcher looks like the site and every text is a site text (`get_site_assistant_setup` returns the markup and the `assistant_*` keys):

- Until opened, the launcher is the site's static button and nothing is fetched. Opening it mounts `<caelo-assistant>`: Shadow DOM, a non-modal dialog (role and label inside the shadow root), the AI disclosure and the privacy link always shown, the conversation in `role="log"` (`aria-busy` while an answer streams), the field focused at once, Escape closes and returns the focus.
- The first question solves the gateway's proof of work for `site-assistant.ask`; the answer streams from the info call's `streamOrigin` (the site's origin elsewhere) and is rendered as text. `[n]` becomes a link only to a source the gateway sent, and only as a path on this site.
- The signed history and the shown messages stay in the tab (`sessionStorage`), never on a server; a conversation that used its questions offers a new one.
- The decision logic is `widget-logic.ts`: self-contained functions whose source text runtime.ts ships, so the unit tests run the code the browser runs. Every check on visitor text is a single linear pass.

## The answer cards (#1701)

The same conversation in the page itself, without a launcher or a floating panel. A card is markup the AI writes into a module and styles like the site's cards. It follows site-search's precedent, where the runtime fills the site's hit template: the runtime fills the card's templates in the page, so the card is the site's markup, CSS and site texts. It is no Web Component; the widget keeps its Shadow DOM. `data-caelo-assistant-answer` names the mode, and a card without a known mode asks nothing (`mode-missing`):

| Mode | Markup (`get_site_assistant_setup`) | Where | The first question |
|---|---|---|---|
| `query` | `ANSWER_MARKUP` (`answerMarkup`) | site-search's results page, beside the results | the visitor's search query, from the address as site-search reads it: `#q=` first, then `?q=`, again on `hashchange` (`searchQueryOf`). Hidden while the page has none |
| `ask` | `ASK_MARKUP` (`askMarkup`) | any page or layout region (a product page, a sidebar, the contact page) | typed by the visitor into the card's form |

In both modes `form[data-caelo-assistant-ask]` is the card's one question field. On an ask card it takes the first question and every follow-up. On a query card it is optional, starts `hidden`, and opens for the follow-ups once the query is answered. So the combined case, a query card with a form on the results page, asks the query first and then continues in the same field. One field rather than a separate follow-up form keeps a single contract for the AI to write, and the mode attribute alone decides whether the card reads the address. A card's form never asks a page's `?q=` by itself: only a `query` card reads the address, so a link with a `q` parameter to an ordinary page spends nothing.

| Part | Role |
|---|---|
| `[data-caelo-assistant-answer="query" \| "ask"]` (`hidden`) | The card. Shown while the visitor AI is available (a query card: and the page has a query); hidden otherwise, so the page stands alone. `data-caelo-assistant-state`: `idle`, `loading`, `done`, `error`, `unavailable`, `disclosure-missing`, `markup-missing`, `mode-missing`. |
| `[data-caelo-assistant-disclosure]` | The AI disclosure. Without text in it nothing is asked: a card cannot run without telling visitors an AI wrote the answer. The privacy link sits beside it, so a link alone is no disclosure. |
| `[data-caelo-assistant-thread]` + `template[data-caelo-assistant-turn]` | One turn per question, with `data-field` `question`, `answer` (streamed as text; `[n]` becomes a link only to a source the gateway sent), `sources` (the cited pages), `rating` (the site's `data-rate="helpful"` / `"not_helpful"` buttons, shown only while feedback is kept) and `note` (an optional form after "not helpful"). `aria-busy` on the thread while an answer streams. |
| `template[data-caelo-assistant-source]` | One cited page: `data-field` `link` (href), `title`, optionally `n` and `url`. |
| `[data-caelo-assistant-status]` | Status texts (`thinking`, `limit`, `toolong`). |
| `form[data-caelo-assistant-ask]` with `[data-caelo-assistant-input]` | The question field (above). Required on an ask card. |
| `[data-caelo-assistant-new]` (`hidden`) | Shown when the conversation used its turns; starts a new one in this card. |
| `template[data-caelo-assistant-texts]` | The status and error texts and the handoff link, as in the widget. |

Each card keeps its own conversation in the tab, under `answerStoreKey`: the page's path and the card's `id`, or its position on the page when it has none. Two cards on one page, or one card on two pages, never show each other's conversation, and a reload shows each card its own without asking again. A query card shows a kept conversation only while the page shows the query it answered; a new query starts a new conversation and stops the stream of the old one. Several cards on a page run independently, each with its own proof of work for its first question. Limits, proof of work, budgets and the feedback inbox are the widget's, since it is the same `ask` operation.

## Feedback and the gap report

The declared insert `feedback` (an inbox, `kind`: helpful, not helpful, unanswered; the question; an optional note; language and day) stores only while the released `feedback.enabled` is on (`onlyIf: { config }`, [plugin-public-surface.md](../plugin-public-surface.md)), which is approval-gated and off by default. `drop` covers the question and the note; a filled honeypot stores nothing; every outcome answers the same. The widget sends `unanswered` for an answer without a cited source and offers the rating buttons only while feedback is on (the plugin's placeholder renders `data-feedback`). No transcript is stored anywhere (D10).

The daily batch `gaps` folds 30 days of negative ratings into clusters (`gaps.ts`): content words compared by their first five letters through a prefix index, at least two shared and half of the question's, so phrasings of one question meet and synonyms stay apart for the AI to group. `list_site_assistant_gaps` returns them marked untrusted; the worker `prune` deletes ratings after 30 days.

## The Stage audit

The test questions (list type `site-assistant-test-questions`) run through the conversation's own search tool on the Stage's index (`ctx.chatTools`, below), retrieval only, no model: an answerable question whose page is not among the sources is a warning, an off-topic one (no page) that finds pages is a warning, an index still building or missing is an error, an unpublished contact page is an error and one the search cannot find a warning.

## `ctx.chatTools`

A plugin with the `visitor_ai` grant and an `ai-chat` operation gets `ctx.chatTools.run(conversation, tool, input, { lang, runId | at })` on the admin side: it runs exactly a tool that conversation declares, as the plugin that owns the collection, on a Stage's release (`runId`), the newest staged or the live one, with the same parameters the gateway sends (`aiChatToolParams` in `plugin-host/collection-query.ts`, shared with the gateway's tools). Another tool or conversation is refused; a tool whose plugin is not active answers `state: "none"`. Brokered through the sandbox too (`chatTools.run`), so an installed plugin with the same grant gets the same handle.

## Tests

- `packages/plugins/site-assistant/src/site-assistant.test.ts`: the declaration, the widget logic, the browser script, the gap clustering, test-question parsing.
- `apps/api-gateway/src/site-assistant.integration.test.ts`: the conversation through the real gateway (the prompt from the released settings after the core's rules, only site-search's tools, the sources) and feedback (off, on after a release, personal data, honeypot, proof, undeclared fields).
- `packages/admin-core/src/__tests__/site-assistant.integration.test.ts`: activation, `ctx.chatTools` on a Stage's release, the audit, the gap batch.
- `apps/admin/e2e/site-assistant-visitor.browser.ts` on `apps/api-gateway/e2e/assistant-site.ts` (both built by `apps/api-gateway/e2e/assistant-test-site.ts`): a visitor asks, reads the streamed answer with its source, rates it, keeps the conversation across pages. On the results page (#1701) the query card answers the search query once with its source, shows it again after a reload without asking, takes a follow-up and a rating, answers a new hash-mode search without a reload, and asks nothing without its disclosure. On a page without a query an ask card answers a typed question with its source and a follow-up, restores its conversation after a reload, asks nothing without its disclosure, and two ask cards on one page keep their own conversations.

## Not yet

- The panel shows ratings and gaps; what conversations cost is in Settings → Visitor AI and the cost dashboard (a plugin does not read the visitor-AI ledger).
- The tools and limits are the declaration's; choosing tools or lowering limits per site is the Owner's visitor-AI settings, not the plugin's configuration.
