# seo

The shipped `seo` plugin (epic #1751, CMS_REQUIREMENTS §14.11): the SEO
knowledge that changes with search engines, as a plugin under the same
rules as every other one (CLAUDE.md §2: one plugin model).

## Core writes, the plugin answers with data

Core writes everything that reaches a page: the head, the JSON-LD, the
sitemap, robots.txt, every file at a path. This plugin returns typed data
only, and core checks, escapes or refuses it:

- schema nodes for the page's JSON-LD graph (the `structured_data`
  composition point),
- findings for the Stage audit: objective rules only; an error blocks
  Publish live until it is fixed or accepted,
- write hints after the AI writes: rules of thumb (lengths, style,
  "link this page?"), never findings,
- proposals for gated changes (robots.txt rules), which the Owner approves.

Plugin code has no network and owns no routes (#1729). Since PR #1732 a
plugin's head entries are limited to hreflang alternates and `og:locale`
for every plugin, so nothing here writes a `<meta>` or `<link>`.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | the definition: capabilities, hooks, settings, tools, skills |
| `src/operations.ts` | every operation by name; hooks and tools name them |
| `src/checks/` | the Stage audit: `SEO_AUDIT_RULES`, one file per rule family |
| `src/hints/` | write hints: `SEO_WRITE_HINT_RULES`, one file per family |
| `src/tools.ts` | the AI's tools (`SEO_TOOLS`) |
| `src/skills.ts` | the companion skills (`SEO_SKILLS`), live with the plugin |
| `src/config.ts` | the settings (`SEO_CONFIG`), core's plugin configuration |
| `src/rules/` | the rule families that core's plugin validator lets only same-folder imports reach (a `../` import is refused) |
| `src/rule-sets.ts` | `AUDIT_RULES` and `WRITE_HINT_RULES`: every family of `src/rules/` composed with the lists above |

A feature adds files of its own and one entry in each list it uses.

### The audit runner

`checks/index.ts` is the contract with core's audit. Each rule family has
an optional `site` part (first call, once per Stage: read site-wide data
here) and an optional `facts` part (once per batch of up to 200 staged
pages with the facts core read from their HTML). The first answer asks
for fact batches with `batchPages: "own"`, so a batch call carries only
its own pages and costs the same on a small and a large site (#1721).

## Checks and write hints (#1757)

The rules and their fix tools are listed in `docs/quality-checks.md`
("The seo plugin's checks"). The findings are objective: one `<h1>`, no
skipped heading level, alt text, link texts, placeholder text, share
image, duplicate titles and descriptions among indexable self-canonical
pages, a noindex page robots.txt hides, a crawler policy that contradicts
itself. Everything else is a write hint after the AI writes
(`writeHintsKinds`: modules, values, page SEO texts, media alt texts,
robots rules): result-list width in pixels (`rules/serp-width.ts`, Arial
widths at 20 / 14 px), a page unchanged for a year, a similar title, alt
text style.

## Crawler policy (#1758)

`plan_crawler_policy` turns a choice per purpose (search, AI answers,
training, user fetch) into the robots rules core accepts, from the
crawler table in `rules/crawler-table.ts` (each crawler with its operator,
purpose, robots token and a source). It writes nothing: the AI passes the
rules to `propose_set_site_seo`, the Owner approves the card, and the
card carries this plugin's caveats (a write hint of kind `robots_rules`):
robots.txt is a request, user fetches often ignore it, Google-Extended
and Applebot-Extended are no crawlers, a block shows only on the next
fetch. The Stage check `crawler-policy-contradiction` finds a policy that
refuses a use and lets its crawler in. Core's side (the training token,
Content-Signal, strict validation): `docs/dev/robots-rules.md`.

## Overview and previews (#1760)

- Admin panel `overview` (Plugins → SEO overview): every page with the
  title and description search engines get, where each comes from (#1752
  origins), robots, canonical and the last Stage's findings; filters by
  page type (`overview_page_types`), origin and finding; each row opens the
  page in the editor. Core's read is `pages_seo.overview`.
- Editor toolbar place `search-preview`: the shown page as a desktop and a
  phone result (cut at the same pixel widths as the hint) and as a shared
  link with its share image, from the chat's view of the page, plus
  prompts for the composer.
- Companion skills `seo-audit` and `crawler-policy` (`skills-checks.ts`).

## llms.txt (#1763)

Setting `llms_txt` (off by default, release scope: it goes live with the
Stage that builds it). The plugin's `agent_files` operation only answers
whether the file is wanted; core builds it from the indexing state
(`docs/dev/llms-txt.md`). The setting's description says it plainly:
Google needs no special file, and most sites that publish one get no
request for it.

## Tests

`bun run test` from the repository root runs `src/*.test.ts`. The
plugin-host suite checks the built definition through the disk-load
pipeline (`shipped-plugins-validate.test.ts`) and pins its public surface
(`public-surface.test.ts`: none).
