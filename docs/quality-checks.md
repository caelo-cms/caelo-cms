# Quality checks on the staged build

Every Stage gets a quality audit (epic #727). It runs against the **staged build**, the files Publish live would ship, never against the live site. Code: `packages/admin-core/src/quality/`.

## Shape

- **Registry** (`checks/registry.ts`): Lighthouse plus the *findings checks*. Core registers `structure` (#820), `links` (#849) and `references` (#724). Active plugins contribute through their `auditFindingsOperation` (see *Plugin contributions* below): one `plugin.<slug>` check each, registered with `{ kind: "plugin", slug }`.
- **Findings check** (`checks/check.ts`): `{ id, title, scope: "page" | "site", timeoutMs?, run(ctx) }`. A page check gets one page's rendered HTML; a site check gets every page plus `build`, the staged build itself (`baseUrl`, `displayBaseUrl`, `probe(path)`, which asks the staged origin whether it serves a path, and `text(path)`, which reads a file such as `sitemap.xml`, null when the build has none).
- **Findings** (`checks/findings.ts`): `{ ruleId: "<checkId>/<rule>", severity, pageId?, message, fix?: { tool, hint } }`. The message leads with a short label before the first colon and says what to do next (CLAUDE.md §11). The runner validates every finding with Zod and allows at most `MAX_FINDINGS_PER_CALL` per call.
- **Gate** (`checks/evaluate.ts`, `gate.ts`): every `error` finding blocks Publish live until it is fixed or the Owner accepts it (per rule and page, bulk acceptance included). Warnings and info are reported and never block.
- **Fail loudly**: a check that throws, hangs or returns malformed findings fails the audit; it never counts as "no findings" (CLAUDE.md §2).

Findings checks are cheap and run on every Stage (SEO-only Stages too) over all published pages. Lighthouse keeps its own Stage classification and page limit.

## Plugin contributions (epic #1107)

An active plugin adds Stage-audit findings by naming one of its operations as `auditFindingsOperation` (manifest field, so shipped and runtime-installed plugins alike; no capability needed). Per audit the worker reads the contributors from the plugin host (activation takes effect at the next Stage, no restart) and adds a site check `plugin.<slug>` per plugin (`checks/plugin-findings.ts`). The check calls the operation through the broker as a render (read-only) invocation on the main line (`plugin-host/src/audit-findings.ts`) with `{ pages: [{ pageId, path }] }` — the published pages of the staged build — and expects `{ findings: [{ rule, severity, pageId?, message, fix? }] }` (`pluginAuditFindings` in the plugin SDK; at most 499). Each finding is filed as `plugin.<slug>/<rule>` and goes through the runner's validation like any check's: a finding naming a page outside the build, a failing call or a malformed answer fails the plugin's check, and with it the audit. An `error` blocks Publish live like any finding and is accepted per rule and page by the Owner.

**Page facts.** A plugin that checks the rendered pages cannot parse them itself: its sandbox bundle resolves nothing but the plugin entry and the SDK. So its first answer may name `factBatches` (page ids, at most 200 per batch, grouped the way the plugin needs them side by side), and core calls the operation again once per batch with `facts`: one `PluginAuditPageFacts` per page (plugin SDK), extracted by `checks/page-facts.ts` with htmlparser2 the way the core checks read pages. A page's facts are its `<html lang>`, title, meta description, canonical, robots, `og:locale`, head hreflang alternates, the page's `<xhtml:link>` alternates in the staged `sitemap.xml` (read once per audit), every body link (`href`, the site `path` it names when it is same-site, `hreflang`, visible text) and every visible text run and visible attribute (`alt`, `placeholder`, `aria-label`, `title`, button `value`). Links and texts carry the module root, list entry and plugin output they sit in. Long pages are cut at fixed caps and flagged `truncated`. A batch naming a page outside the build fails the check. Findings of every call are filed together; identical ones once (a finding about shared markup reads the same in every batch), and past `MAX_FINDINGS_PER_CALL` the most severe are kept with one `limit-reached` note.

**Write hints.** The same plugins can say something earlier: a `writeHintsOperation` (plugin SDK `PluginWriteHintsArgs`) sees every module the AI writes (stored html and fields, read after the write) and every content value it writes, and returns at most five sentences that core appends to the tool result (`ai/tools/_plugin-write-hints.ts`, `plugin-host/src/write-hints.ts`). It runs read-only in the writing chat's scope. A failing plugin is named in the result; the write already happened.

The international-site plugin's rules (hreflang, canonical, sitemap, language links, page language, untranslated text, coverage) are listed in its README (`packages/plugins/international-site/README.md`).

## Where Lighthouse runs (#875)

Lighthouse simulates the CPU slowdown from observed task durations, so a run that shares a CPU with another run or with the editor's requests measures that interference. The runner is picked per provider (`lighthouse-runner-select.ts`):

| Provider | Runner | Notes |
|---|---|---|
| `gcp`, `gcp-firebase` | Cloud Run job `caelo-<env>-audit`, one task per run, all in parallel (`parallel-runner.ts`, `gcp-audit-launcher.ts`) | CLI-owned (`packages/provisioning/src/audit-job-setup.ts`): created by the wizard and by `cms-provision upgrade`; the app-roll moves its image with the admin's. Its identity reads the staged build, creates results in `<project>-caelo-<env>-audit-results` and writes logs, nothing else. |
| `self-hosted`, dev | the in-process child (`lighthouse-runner.ts`), runs one after another | no extra machines |
| `aws`, `azure` | none yet: every Lighthouse audit fails with the gap | issues #749 / #750 (nothing is staged there before them either) |

A cloud install never falls back to the in-process child (CLAUDE.md §2).

Troubleshooting (the audit's failure message names which one):

- **`CAELO_AUDIT_JOB / CAELO_AUDIT_RESULTS_BUCKET are not set`** or **`could not start the audit tasks`**: the job is missing. Run `cms-provision upgrade`; its "Ensuring the quality-audit job" step says what failed.
- **`the audit job runs Caelo X but the admin runs Y`**: the app-roll could not move the job's image. Run `cms-provision upgrade` again.
- **`audit task(s) ... stopped without a result`**: a task crashed or hit its 5-minute timeout; the job's execution log in Cloud Logging names the cause.

## Core check: `structure` (#820)

Free markup that should be a module, data kept twice that should be one list, and module JS that belongs elsewhere or builds content. See `checks/structure.ts` and `checks/structure-js.ts`.

| Rule | Severity | Meaning |
|---|---|---|
| `structure/repeated-markup` | error | The same pattern sits in free markup on two or more pages, or free markup copies a module's own template. Make it one module (repeated entries in a `list` field) and place it. |
| `structure/duplicate-module` | error | Two placed modules with structurally identical templates. Keep one. |
| `structure/duplicate-navigation` | error | Two or more modules carry the same set of 3+ links as their own copies — local list entries or hand-written links (epic #1107). Keep them in ONE shared list and bind every module's `list` field to it (`promote_local_list`). One site-wide finding per link set. |
| `structure/manual-page-listing` | error / warning | A module keeps links to 3+ pages of one collection page type (`collection: true` — blog, news, products, docs; a footer linking standalone About / Team / Contact pages is no listing), covering at least half of that type's published pages, by hand — local list entries, cards in a `module-list`, numbered href fields or links in a field value (#1256). An overview is a `list` field bound to a page query (`bind:"source"`, `{kind:"query", defaults:{page_type:…}}`; `term_pages` / `children`). Error while pages of the type are missing (the message names them), warning when the set is complete. Pages whose type nobody chose (#1276) are exempt; a curated pick below half stays allowed. |
| `structure/unconfirmed-page-type` | warning | Pages that sit on a page type nobody chose — the old stored default type (#1276, migration 0443). One site-wide finding with the paths and the site's page types; ONE `update_pages_many` naming each page's `pageType` (the current one too when it fits) confirms them. |
| `structure/similar-markup` | warning | Near matches of the repeated-markup / duplicate-module patterns. |
| `structure/similar-navigation` | warning | Near matches of duplicate navigation (Jaccard ≥ the near-match threshold, 0.8). |
| `structure/layout-css-module-specific` | warning | Layout CSS for classes only one module, or only free markup, uses. |
| `structure/repeated-items` | warning | One pattern written out 3+ times side by side in one module's free markup (#1068): give the module a `list` field with one entry per item (a `module-list` only when each item is a module of its own). |
| `structure/foreign-module-js` | error | A placed module's JS drives markup (classes, ids, `data-*` hooks) that only one or two OTHER modules render (#1198) — e.g. a header carrying the demo form's submit. Move the script into the module it serves. |
| `structure/js-rendered-content` | error | A placed module's JS builds visible content (#1198): markup with text, links or interpolated data written into `innerHTML` / `insertAdjacentHTML` / `document.write`, or the entries of a content array put into the page. Content goes into the html (entries as a `list` field); JS only shows and hides. |
| `structure/site-wide-module-js` | warning | A placed module's JS drives hooks three or more modules render (scroll reveal) without a `caelo:site-wide: <reason>` comment. |
| `structure/js-written-text` | warning | A placed module's JS writes long literal text (6+ words or 50+ characters) into the page. Keep it in the html, hidden until shown. |

Exact repeats are errors, near repeats are warnings (maintainer decision on #820). The write tools give the same advice at the second copy (`ai/tools/_markup-guard.ts`, `ai/tools/_shared-list-guard.ts`), when written values link most pages of one page type (`ai/tools/_page-listing-guard.ts`, #1256) and after every module js / html write (`ai/tools/_module-js-guard.ts`).

**How module JS is read** (#1198, `checks/module-js-analysis.ts`, oxc-parser). Hooks: every string literal that is a CSS selector, plus the bare arguments of `getElementById` / `getElementsByClassName`, so a selector kept in a constant counts too; a selector assembled at runtime does not. A module owns the hooks of its own template and of the modules nested inside it on the staged pages; layout chrome and `data-caelo-*` / `.caelo-*` platform hooks are neutral. A `caelo:site-wide:` comment covers shared hooks only — the hooks of one or two modules stay an error. Content: a markup write counts when its static parts carry text or `href`, or a content tag (`li`, `a`, `h1`–`h6`, `p`, …) wraps an interpolated value; a content array (3+ entries with visitor text or links) counts only when the script renders it — named in a markup / text write, or iterated by a callback or loop that writes to the page.

**What counts as free markup.** Each module root in the staged HTML (`data-caelo-module-id`) is walked against its own template; whatever the template cannot account for came in through a field value and is free. Sub-modules in `module` / `module-list` fields carry their own `data-caelo-module-id` (#1027), so an FAQ entry or a card in a list is module output, never free markup of its parent. A template child accounts for a rendered element by best fit (exact class set, then most classes in common, then the fewest unaccounted elements, then sibling order), so a classless left column never claims the classed right column next to it. A Mustache section inside a tag (`class="split {{#reverse}}rev{{/reverse}}"`, a boolean variant) is optional: the template node carries only the classes every render has, so renders with and without the variant are both module output (#1104).

**What counts as a module's own links.** Per module root and page: the `<a href>`s inside entries of its local lists (`data-caelo-list-item="instance/…"` or `"local/…"`, stamped by the template engine) and in its free markup. Links inside a shared list's entries (`"<listId>/<itemId>"`) never count — two modules showing one shared list is the goal. Links of generated entries (queries, system and plugin sources) carry no stamp and sit in the template's own markup, so they never count either. The same module on many pages is not a copy; only different modules are compared.

**What counts as a hand-kept listing** (#1256, `checks/structure-listing-links.ts`). A separate collection per OUTERMOST module root: the own links above, plus the links of nested modules (a `module-list` of cards is one listing of the module holding it) and links in the template's own markup outside a list section (`<a href="{{card1_href}}">`). Telling a scalar link from a generated entry needs the template: it is parsed with its sections kept (`stripMustache` `markSections`), each rendered element is matched to the template element that rendered it, and a link inside a section over a `list` / `module-list` field counts only in a stored (stamped) entry; a link inside a section over no declared field (a plugin source such as the language switcher, a `page.terms.…` loop) or inside an entry's reserved `items` loop never counts; Names resolve as the template engine resolves them: inside an entry of a list field the keys of that field's entries first (node fields and children loop of its list type, plus the engine's `index` / `depth` / `id` / `node` / `first` / `last`), then `items`, then the module's fields (a list field there starts its own entries and never borrows the entry's stamp; a scalar field is a condition), then `page.…` / `site_text.…` / `is_` / `has_` / `count_` conditions; any other name is a plugin source, generated at any depth. Targets are resolved against the document base (`<base href>`) and mapped to staged pages by path on the staged origin, the SEO base URL and the public domains; the page types come from `pages.list`, `page_types.list` and `site_defaults.get` (`checks/structure-sources.ts`). The linking page itself never counts as a member of the listed type.

## Core check: `links` (#849)

Every same-site URL a staged page references must be served by that build. Code: `checks/links.ts` (rules, findings), `checks/links-analysis.ts` (pure parsing and resolution), `checks/links-fix.ts` (where the URL is stored and which tool fixes it), `checks/links-sources.ts` (Query API reads), `checks/staged-build.ts` (the probe).

| Rule | Severity | Meaning |
|---|---|---|
| `links/broken-internal` | error | A link to a page (`a`, `area`, canonical / hreflang `link`) that nothing in the build serves, directly or at the end of its redirects (410 included). |
| `links/broken-asset` | error | An image (`src`, `srcset`, `og:image`), stylesheet, script, media or other file the build does not contain. |
| `links/redirect-loop` | error | The URL runs into a cycle in the redirect table. |
| `links/redirect-chain` | warning | The URL works only through the redirect table; the finding names the final URL to link. |
| `links/orphan-page` | warning | No other page links here with `a` / `area` (navigation included). The homepage and the 404 page are exempt. |
| `links/limit-reached` | info | A bound cut the check short; says what was not verified. |

**What is a link.** Only URL attributes, read with htmlparser2: `a`/`area[href]`, `link[href]` (not `preconnect` / `dns-prefetch`), `img`/`source[src, srcset]`, `script`, `video`, `audio`, `track`, `embed`, `iframe[src]`, `video[poster]`, `object[data]`, `input[src]`, SVG `image`/`use[href]`, and `og:image` / `twitter:image` meta. Text that looks like a path is never a link (#846). Fragment-only (`#x`), `mailto:`, `tel:`, `data:` and `javascript:` URLs are skipped. URLs resolve like a browser resolves them: against the page URL or its `<base href>`.

**Same-site.** An http(s) URL whose host is one of: the staged origin the audit reads, the staging host operators see, the site base URL (`site_defaults.get_seo`), or a public domain (`domains.list`). Links to other hosts are external and out of scope.

**Not in the static build.** `/api/*` belongs to the public gateway on every provider (LB URL map, Firebase rewrite, Caddy `handle /api/*`) and is skipped. Plugin pages are ordinary pages of the build and are checked.

**Resolution order.** Pages of the build first (`/about`, `/about/` and `/about/index.html` are the same page; query and fragment are ignored), so a live page beats a redirect row as on every provider (#575). Then the redirect table, hop by hop (at most 20). Then a `HEAD` probe of the staged origin for everything else: 2xx means served, 404/410 missing, anything else fails the check loudly. The probe follows the host's own redirects (trailing slash, clean URLs).

**Where the fix goes.** The rendered HTML says where a URL sits: inside a module root (`data-caelo-module-id`), inside baked plugin output (`data-caelo-plugin`), or in the template chrome. The stored sources pick the tool: `patch_list_items_many` for an entry of a shared list (`data-caelo-list-item="<listId>/<itemId>"`), `update_modules_many` for an entry of a list field's default (`local/<field>/<itemId>`, chrome), `edit_content` when the module's template holds the URL, `set_page_module_content_many` when a content value does, `propose_update_layout` for a layout, `grep_content` for template markup, `set_theme_asset` for an unbound `{{theme_…}}` placeholder, `bulk_create_redirects` for a loop.

**Bounds.** At most 5,000 URLs read per page, 5,000 distinct paths probed per audit (8 at a time, 10 s each, one retry on a dropped connection), 240 s per run. Past the runner's 500 findings, errors are kept first and the rest is summarised in one `links/limit-reached` finding; the next Stage reports what was cut.

**Relation to reference integrity.** Page references (`caelo:page/<id>`, #724) render to plain URLs in the build, so `links` needs no change for them. A rendered link to an unpublished page is skipped here only when the `references` check reports that stored link (`LinkSources.reportedDraftLinks`: same target, same page, same module / plugin / chrome origin): it is reported at the place it is stored. Any other link that ends at a draft page (plugin output, a legacy literal whose redirect chain ends at a draft) stays `links/broken-internal`, because nothing else blocks on it. A `references` issue stored on a draft page is a site-scoped finding: the staged build has no such page. See below for the split.

## Core check: `references` (#724 rollout F)

Internal links are stored as references (`caelo:page/<id>[#anchor]`, `caelo:media/<id>`), resolved at render time per rendering page (rollout D maps a target to the rendering page's language). Reference integrity checks the stored links, where they live. Code: `links/reference-sources.ts` (what is read), `links/reference-integrity.ts` (pure check), `links/reference-fix.ts` (messages and fixing tools), `ops/content/link-integrity.ts` (Stage gate and the `links.check_references` op), `checks/references.ts` (the quality check).

| Rule | Stage | Publish live / promote | Meaning |
|---|---|---|---|
| `references/missing-target` | blocks | blocks (error) | The referenced page or media file was deleted. |
| `references/variant-missing` | blocks | blocks (error) | The target has no version in the rendering page's language (`link-variant-missing:page/<id>:<variant>` in the render). |
| `references/unpublished-target` | warning | blocks (error) | The target (or its same-language version) is a draft. |
| `references/missing-list` | blocks | blocks (error) | A `caelo:list/<id>` that is still rendered — a module `list` field's shared list (fixed on the field, its default or a placement's value), a `page_terms` vocabulary — points at a deleted list (epic #1107). |
| `references/missing-term` | blocks | blocks (error) | A `caelo:term/<listId>/<itemId>` whose vocabulary list or entry is gone: a page's terms, a query's `terms` (list entries, list type source defaults, `source` field defaults and placement overrides), a `term` field value. |
| `references/missing-module` | blocks | blocks (error) | A list entry's `module` field embeds a module or content instance that was deleted. |
| `references/literal-link` | warning | warning | A literal path the link migration (rollout E) left as it is; it works, and saving it again stores the reference. |
| `broken-literal` (Stage / `check_links` only) | warning | — | A literal path that matches nothing. The migration report (`get_link_migration_report`) lists these; `links/broken-internal` owns it at Publish live. |
| `pending-import-link` (Stage / `check_links` only) | warning | — | While a site import is active, a link to a page the run planned but has not built stays literal on purpose (`import_run_links`). It never blocks; `imports.resolve_links` (`resolve_import_links`) or the run's cleanup converts it, and once the run is over anything still unresolved follows the rules above. |
| `references/limit-reached` | — | info | More issues than one audit lists. |

Maintainer decisions on #724: a missing target blocks everywhere; an unpublished one warns at Stage and blocks Publish live. A problem that renders only on draft pages ships nowhere yet and is a warning; it blocks once the page is published.

**What is read.** Only what renders, in one query per entity kind: page placements (content values by declared field kind, #846, and the field default a value-less field shows), nested modules, templates and layouts of live pages with their chrome modules (whose content lives in field defaults), lists the way they render (epic #1107: a module's `list` field renders its shared list and that list type's source defaults on the module's pages, a list entry's `module` field renders that module there, a vocabulary renders on the pages carrying its terms; a list nothing renders ships nowhere and is not reported), pages' terms and properties, and plugin data named through the plugins' `linkLocationsOperation` (the hook rollout E introduced for the link migration). Literal links are classified by the write-time canonicaliser in report mode, so the check and the write path agree on what a link is.

**Where it runs.**

- **Stage**: `chat.merge_to_main` / `chat.merge_draft_to_main` run `stageReferenceGate` inside the merge transaction, after the replay. A blocking issue throws `OperationAbortError`: the replay rolls back, nothing reaches main, and the error lists each place with its fixing tool. Plugins (link locations, link-resolve) answer from their own transactions and cannot see the merge's uncommitted writes, so they are asked for the post-merge state: on main when the merge took no plugin rows, as the merged branch when it did (a merge takes every pending plugin row of the chat or none). Nested modules are checked only where the module's HTML dispatches them (`{{>field}}` / `{{#field}}`), as the renderer does. The static build refuses a missing target anyway; the gate refuses it earlier and says where it is. Warnings come back as `linkWarnings`.
- **Publish live / promote**: the `references` findings check runs in every Stage's audit over the main line with the Publish policy. Its errors block the gate like any finding until fixed or accepted by the Owner (`accept_quality_findings`). Page-bound content (a page's content, terms and properties) is a finding on its page; shared places (module HTML, layouts, shared lists, list types, plugin data) are site-wide findings.
- **AI and MCP**: `check_links` (read op `links.check_references`, actor scope human + ai + system) checks the caller's draft as its preview shows it (branch overlay of pending snapshots), filterable by page path, for the Stage or the Publish policy. Power-MCP exposes it like every built-in tool.

**Split with `links`.** One defect, one finding: `links` reads what ships and owns URLs nothing answers (broken legacy literals included); `references` reads where the link is stored and owns stored references (missing, language-less and unpublished targets).
