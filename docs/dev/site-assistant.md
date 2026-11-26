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

## The answer card (#1701)

The same conversation, on the search results page, without a launcher or a panel: the visitor's search query is the question. The AI writes `ANSWER_MARKUP` (`src/index.ts`, returned by `get_site_assistant_setup` as `answerMarkup`) into the results page's module, beside site-search's results, and styles it like the site's cards. It follows site-search's precedent, where the runtime fills the site's hit template: the runtime fills the site's templates in the page, so the card is the site's markup, CSS and site texts. It is no Web Component; the widget keeps its Shadow DOM.

| Part | Role |
|---|---|
| `[data-caelo-assistant-answer]` (`hidden`) | The card. Shown when the page has a query and the visitor AI is available; stays hidden otherwise, so the results stand alone. `data-caelo-assistant-state`: `loading`, `done`, `error`, `unavailable`, `idle`, `disclosure-missing`, `markup-missing`. |
| `[data-caelo-assistant-disclosure]` | The AI disclosure. Without text in it nothing is asked: the card cannot run without telling visitors an AI wrote the answer. |
| `[data-caelo-assistant-thread]` + `template[data-caelo-assistant-turn]` | One turn per question, with `data-field` `question`, `answer` (streamed as text; `[n]` becomes a link only to a source the gateway sent), `sources` (the cited pages), `rating` (the site's `data-rate="helpful"` / `"not_helpful"` buttons, shown only while feedback is kept) and `note` (an optional form after "not helpful"). `aria-busy` on the thread while an answer streams. |
| `template[data-caelo-assistant-source]` | One cited page: `data-field` `link` (href), `title`, optionally `n` and `url`. |
| `[data-caelo-assistant-status]` | Status texts (`thinking`, `limit`, `toolong`). |
| `form[data-caelo-assistant-followup]` (`hidden`) | Optional follow-up question, shown after the first answer, within the conversation's turns. |
| `template[data-caelo-assistant-texts]` | The status and error texts and the handoff link, as in the widget. |

The query comes from the address as site-search reads it: `#q=` first, then `?q=`, again on `hashchange` (`searchQueryOf` in `widget-logic.ts`). A query is asked once per tab: the answer and its signed history stay in `sessionStorage` under the query, so a reload or a return shows it without asking again; a new query starts a new conversation and stops the stream of the old one. Limits, proof of work, budgets and the feedback inbox are the widget's, since it is the same `ask` operation.

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
- `apps/admin/e2e/site-assistant-visitor.browser.ts` on `apps/api-gateway/e2e/assistant-site.ts` (both built by `apps/api-gateway/e2e/assistant-test-site.ts`): a visitor asks, reads the streamed answer with its source, rates it, keeps the conversation across pages. On the results page (#1701) the card answers the search query once with its source, shows it again after a reload without asking, takes a follow-up and a rating, answers a new hash-mode search without a reload, and asks nothing without its disclosure.

## Not yet

- The panel shows ratings and gaps; what conversations cost is in Settings → Visitor AI and the cost dashboard (a plugin does not read the visitor-AI ledger).
- The tools and limits are the declaration's; choosing tools or lowering limits per site is the Owner's visitor-AI settings, not the plugin's configuration.
