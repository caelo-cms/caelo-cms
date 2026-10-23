# Quality checks on the staged build

Every Stage gets a quality audit (epic #727). It runs against the **staged build**, the files Publish live would ship, never against the live site. Code: `packages/admin-core/src/quality/`.

## Shape

- **Registry** (`checks/registry.ts`): Lighthouse plus the *findings checks*. Core registers `structure` (#820), `links` (#849) and `references` (#724). Plugins add findings checks through the same `register` call with `{ kind: "plugin", slug }`.
- **Findings check** (`checks/check.ts`): `{ id, title, scope: "page" | "site", timeoutMs?, run(ctx) }`. A page check gets one page's rendered HTML; a site check gets every page plus `build`, the staged build itself (`baseUrl`, `displayBaseUrl`, and `probe(path)`, which asks the staged origin whether it serves a path).
- **Findings** (`checks/findings.ts`): `{ ruleId: "<checkId>/<rule>", severity, pageId?, message, fix?: { tool, hint } }`. The message leads with a short label before the first colon and says what to do next (CLAUDE.md §11). The runner validates every finding with Zod and allows at most `MAX_FINDINGS_PER_CALL` per call.
- **Gate** (`checks/evaluate.ts`, `gate.ts`): every `error` finding blocks Publish live until it is fixed or the Owner accepts it (per rule and page, bulk acceptance included). Warnings and info are reported and never block.
- **Fail loudly**: a check that throws, hangs or returns malformed findings fails the audit; it never counts as "no findings" (CLAUDE.md §2).

Findings checks are cheap and run on every Stage (SEO-only Stages too) over all published pages. Lighthouse keeps its own Stage classification and page limit.

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

Free markup that should be a module: `structure/repeated-markup`, `structure/duplicate-module` (errors), `structure/similar-markup`, `structure/layout-css-module-specific` (warnings). See `checks/structure.ts`.

**What counts as free markup.** Each module root in the staged HTML (`data-caelo-module-id`) is walked against its own template; whatever the template cannot account for came in through a field value and is free. Sub-modules in `module` / `module-list` fields carry their own `data-caelo-module-id` (#1027), so an FAQ entry or a card in a list is module output, never free markup of its parent. A template child accounts for a rendered element by best fit (exact class set, then most classes in common, then the fewest unaccounted elements, then sibling order), so a classless left column never claims the classed right column next to it.

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

**Where the fix goes.** The rendered HTML says where a URL sits: inside a module root (`data-caelo-module-id`), inside baked plugin output (`data-caelo-plugin`), or in the template chrome. The stored sources pick the tool: `set_structured_set` for a navigation menu, `edit_content` when the module's template holds the URL, `set_page_module_content` when a content value does, `propose_update_layout` for a layout, `grep_content` for template markup, `set_theme_asset` for an unbound `{{theme_…}}` placeholder, `bulk_create_redirects` for a loop.

**Bounds.** At most 5,000 URLs read per page, 5,000 distinct paths probed per audit (8 at a time, 10 s each, one retry on a dropped connection), 240 s per run. Past the runner's 500 findings, errors are kept first and the rest is summarised in one `links/limit-reached` finding; the next Stage reports what was cut.

**Relation to reference integrity.** Page references (`caelo:page/<id>`, #724) render to plain URLs in the build, so `links` needs no change for them. A rendered link to an unpublished page is skipped here only when the `references` check reports that stored link (`LinkSources.reportedDraftLinks`: same target, same page, same module / plugin / chrome origin): it is reported at the place it is stored. Any other link that ends at a draft page (plugin output, a legacy literal whose redirect chain ends at a draft) stays `links/broken-internal`, because nothing else blocks on it. A `references` issue stored on a draft page is a site-scoped finding: the staged build has no such page. See below for the split.

## Core check: `references` (#724 rollout F)

Internal links are stored as references (`caelo:page/<id>[#anchor]`, `caelo:media/<id>`), resolved at render time per rendering page (rollout D maps a target to the rendering page's language). Reference integrity checks the stored links, where they live. Code: `links/reference-sources.ts` (what is read), `links/reference-integrity.ts` (pure check), `links/reference-fix.ts` (messages and fixing tools), `ops/content/link-integrity.ts` (Stage gate and the `links.check_references` op), `checks/references.ts` (the quality check).

| Rule | Stage | Publish live / promote | Meaning |
|---|---|---|---|
| `references/missing-target` | blocks | blocks (error) | The referenced page or media file was deleted. |
| `references/variant-missing` | blocks | blocks (error) | The target has no version in the rendering page's language (`link-variant-missing:page/<id>:<variant>` in the render). |
| `references/unpublished-target` | warning | blocks (error) | The target (or its same-language version) is a draft. |
| `references/literal-link` | warning | warning | A literal path the link migration (rollout E) left as it is; it works, and saving it again stores the reference. |
| `broken-literal` (Stage / `check_links` only) | warning | — | A literal path that matches nothing. The migration report (`get_link_migration_report`) lists these; `links/broken-internal` owns it at Publish live. |
| `pending-import-link` (Stage / `check_links` only) | warning | — | While a site import is active, a link to a page the run planned but has not built stays literal on purpose (`import_run_links`). It never blocks; `imports.resolve_links` (`resolve_import_links`) or the run's cleanup converts it, and once the run is over anything still unresolved follows the rules above. |
| `references/limit-reached` | — | info | More issues than one audit lists. |

Maintainer decisions on #724: a missing target blocks everywhere; an unpublished one warns at Stage and blocks Publish live. A problem that renders only on draft pages ships nowhere yet and is a warning; it blocks once the page is published.

**What is read.** Only what renders, in one query per entity kind: page placements (content values by declared field kind, #846, and the field default a value-less field shows), nested modules, templates and layouts of live pages with their chrome modules (whose content lives in field defaults), structured sets (a nav menu renders where its `nav-menu-<slug>` module does; an unrendered set only warns), and plugin data named through the plugins' `linkLocationsOperation` (the hook rollout E introduced for the link migration). Literal links are classified by the write-time canonicaliser in report mode, so the check and the write path agree on what a link is.

**Where it runs.**

- **Stage**: `chat.merge_to_main` / `chat.merge_draft_to_main` run `stageReferenceGate` inside the merge transaction, after the replay. A blocking issue throws `OperationAbortError`: the replay rolls back, nothing reaches main, and the error lists each place with its fixing tool. Plugins (link locations, link-resolve) answer from their own transactions and cannot see the merge's uncommitted writes, so they are asked for the post-merge state: on main when the merge took no plugin rows, as the merged branch when it did (a merge takes every pending plugin row of the chat or none). Nested modules are checked only where the module's HTML dispatches them (`{{>field}}` / `{{#field}}`), as the renderer does. The static build refuses a missing target anyway; the gate refuses it earlier and says where it is. Warnings come back as `linkWarnings`.
- **Publish live / promote**: the `references` findings check runs in every Stage's audit over the main line with the Publish policy. Its errors block the gate like any finding until fixed or accepted by the Owner (`accept_quality_findings`). Page-bound content is a finding on its page; shared places (module HTML, layouts, sets, plugin data) are site-wide findings.
- **AI and MCP**: `check_links` (read op `links.check_references`, actor scope human + ai + system) checks the caller's draft as its preview shows it (branch overlay of pending snapshots), filterable by page path, for the Stage or the Publish policy. Power-MCP exposes it like every built-in tool.

**Split with `links`.** One defect, one finding: `links` reads what ships and owns URLs nothing answers (broken legacy literals included); `references` reads where the link is stored and owns stored references (missing, language-less and unpublished targets).
