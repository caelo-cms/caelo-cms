# Quality checks on the staged build

Every Stage gets a quality audit (epic #727). It runs against the **staged build**, the files Publish live would ship, never against the live site. Code: `packages/admin-core/src/quality/`.

## Shape

- **Registry** (`checks/registry.ts`): Lighthouse plus the *findings checks*. Core registers `structure` (#820) and `links` (#849). Plugins add findings checks through the same `register` call with `{ kind: "plugin", slug }`.
- **Findings check** (`checks/check.ts`): `{ id, title, scope: "page" | "site", timeoutMs?, run(ctx) }`. A page check gets one page's rendered HTML; a site check gets every page plus `build`, the staged build itself (`baseUrl`, `displayBaseUrl`, and `probe(path)`, which asks the staged origin whether it serves a path).
- **Findings** (`checks/findings.ts`): `{ ruleId: "<checkId>/<rule>", severity, pageId?, message, fix?: { tool, hint } }`. The message leads with a short label before the first colon and says what to do next (CLAUDE.md §11). The runner validates every finding with Zod and allows at most `MAX_FINDINGS_PER_CALL` per call.
- **Gate** (`checks/evaluate.ts`, `gate.ts`): every `error` finding blocks Publish live until it is fixed or the Owner accepts it (per rule and page, bulk acceptance included). Warnings and info are reported and never block.
- **Fail loudly**: a check that throws, hangs or returns malformed findings fails the audit; it never counts as "no findings" (CLAUDE.md §2).

Findings checks are cheap and run on every Stage (SEO-only Stages too) over all published pages. Lighthouse keeps its own Stage classification and page limit.

## Core check: `structure` (#820)

Free markup that should be a module: `structure/repeated-markup`, `structure/duplicate-module` (errors), `structure/similar-markup`, `structure/layout-css-module-specific` (warnings). See `checks/structure.ts`.

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

**Relation to the Stage-time scan.** `ops/content/link-integrity.ts` scans stored values before the build and only warns. The `links` check reads what actually ships, including layouts, structured sets, field defaults and plugin output, and its errors block Publish live. Page references (`caelo:page/<id>`, #724) render to plain URLs in the build, so the check needs no change for them.
