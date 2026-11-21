# The site search plugin

Epic #1644, issue #1651. `packages/plugins/site-search` is the visitors' search for sites with up to 50,000 pages. It is the first user of page output (`plugin-page-output.md`), collections and collection operations (`plugin-collections.md`), batch jobs (`plugin-batches.md`), configuration (`plugin-config.md`) and embedding models (`dev/embedding-models.md`). The operator says "we need a search, mostly for products"; the skill `site-search-setup` tells the AI how to build and tune it.

## What counts

`src/rules.ts`, by the observer's facts:

| Where and what | Counts |
|---|---|
| content on up to `counting.full_max` pages (10) | fully, on each |
| up to `counting.reduced_max` pages (49) | reduced (`counting.reduced_weight`), on each |
| on more, or on more than half of all pages (from 11) | only on its home page (module setting `home_page`); without one, not at all |
| header, navigation, footer (layout chrome) | text only on its home page; links describe their targets |
| a link's words | fully for the target (anchor text), reduced on the page that carries them |
| form fields, labels, buttons | never |
| template blocks (the page's own values) | always |
| plugin regions, noindex, 404, the results page, excluded pages | never; their links still count as anchor text |

"Pages" means pages showing the same content (`contentPlacementCount`): a text module with each page's own words counts on each page; a synced teaser on 300 pages counts only on its home page. An explicit mode wins over the automatic rule, first the content instance's, then the module's (`auto`, `full`, `reduced`, `home`, `never`). The thresholds are placement steps the host knows: a block crossing one makes the same Stage deliver every page it is on again.

## Documents

- `pages`: title, short title, description, breadcrumb, `sections` (heading, text and the anchor a result links to; vectors when semantic search is on), `reduced` (reduced text), `url`, `page_type`, `terms`, and `digest` / `anchors_digest` (change detection).
- `anchors`: one link text to one target from one source. The source is a page (`p:<id>`), or a navigation block (`m:<id>`, counted once, weighted by its placement count). `search` joins them: a page found only by the words other pages link it with is a hit, ranked by the text's score times 1 + log10(sources).

An unchanged page is not written again: the observer compares its document's digest with the index (`getMany`), unless the index has changes it does not hold yet. A navigation block's links are replaced only when they changed (their digest is kept in `module_counting`). Editing the footer writes nothing.

## Profile and lists

`src/profile.ts` builds the search profile at the end of every Stage from the configuration and five plugin-owned list types:

- `site-search-synonyms`: equivalent words, or one-way (the first word finds the others);
- `site-search-best-bets`: query → page shown first;
- `site-search-suggestions`: start questions for the empty field;
- `site-search-test-queries`: checked by the Stage audit;
- `site-search-protected-terms`: never stemmed.

An entry the profile cannot use (a pinned link that names no page, a synonym with one word) becomes a note in `get_search_index_report`.

## The browser side

`src/runtime.ts`, a client asset. It binds to markup the AI writes into the site's own modules: `form[data-caelo-search]` with `[data-caelo-search-input]` and `[data-caelo-search-suggestions]`, and on the results page `[data-caelo-search-results]` with a `template[data-caelo-search-hit]`. The field is an ARIA 1.2 combobox. Focus warms the index up (`/release`); later calls name the release, so the CDN answers them. Requests send no cookie. Highlights are ranges turned into `<mark>`, never HTML from the index.

## Visitors' queries

Counting is off until the Owner approves `popular_suggestions`.

- **What is stored.** The `record` operation stores a submitted search, a click on a result or a reformulation (a search right after another in the same tab) with text, language, day and result count. It stores no address, no visitor id and no cookie. Text that looks like an e-mail address, a phone number or a long number is dropped before storage (`src/learn.ts`). The gateway learns whether counting is on from the projected `public_settings`.
- **Learning.** The daily `learn` batch folds 30 days into popular-query candidates (5 searches on 3 days, mostly with results) and insights: queries that keep finding nothing, and reformulations. The AI reads the insights as untrusted data (`list_search_insights`).
- **Moderation.** The hourly `moderate` worker deletes counts older than 30 days. In `ai` mode it lets the AI moderate candidates, and anything not clearly harmless is rejected. In `human` mode a person decides in the panel or with `decide_popular_query`.
- **Showing them.** Approved queries are baked into the results page's `data-caelo-plugin="site-search"` region. The plugin-data build takes them live within minutes, without a Stage (`plugin-baked-data.md`), and the runtime reads them from there.

## Checks and the AI's view

- **Stage audit.** The `audit` operation runs the test queries against the audited Stage's index. A pinned result that is not first is an error and blocks Publish live. An expected page outside the first results is a warning. While the index is still building, the audit waits up to 45 s, then reports an error with `retry_quality_audit`.
- **Preview.** `preview_site_search` searches the staged (or live) index and says where each hit comes from.
- **Index report.** `get_search_index_report` shows per block how it counts and why.
- **Panel.** Settings → Plugins → Site search shows the same report, the popular queries with approve and reject, and the insights.
