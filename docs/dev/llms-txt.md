# llms.txt

Issue #1763 (epic #1751). An optional `/llms.txt` (llmstxt.org): the site's indexable pages for AI agents, by page type, each a Markdown link with its meta description. Off by default; the `seo` plugin's setting `llms_txt` switches it.

## What it is worth

Said as plainly as the setting says it: llms.txt is no ranking lever. Google reads none of it and says AI search needs no special file or markup (Search Central, May 2026); a log study of 137,000 domains (Ahrefs, June 2026) found 97 % of llms.txt files got no request at all, and no AI crawler asked for one that did not exist. Coding agents do read such files. It is cheap, it does no harm, and it can be switched off again.

## Who does what

- **Core writes the file** (`apps/static-generator/src/llms-txt.ts`). Plugins own no routes and write no files (#1729), so the plugin only switches it: the manifest hook `agentFilesOperation` (plugin SDK) answers `{ llmsTxt: boolean }`, asked once per build as a render invocation on the main line (`plugin-host` `agent-files.ts`, `BuildPluginServices.resolveAgentFiles`). Any active plugin answering `true` turns it on; a failing answer stops the build.
- **The seo plugin owns the setting** (`packages/plugins/seo/src/agent-files.ts`): `llms_txt`, a `bool`, default `false`, scope `release`. A change lands on the chat's draft like any plugin setting (`update_plugin_config`), reaches main with the Stage, and the Stage's build writes or drops the file; production gets that build with Publish live. A plugin-data build keeps the live file, a rollback restores the build's own.

## What it lists

The build's indexing state, the decision the sitemap reads too (`SeoPass.indexedPages`): pages of the build that are indexable (not noindex, not the 404 page, not left out by a plugin's sitemap contribution) and canonical to themselves (a canonical override to another address leaves a page out), page 1 of a paginated overview only.

```
# <site name, else the site's host>

> <the home page's meta description>

## <page type name>

- [<page title>](<public URL>): <meta description>
```

Sections follow the page types by name, pages the build's order. Only what the site's authors wrote reaches the file: titles, meta descriptions, page type names, the site's name, each on one line with Markdown link text escaped, never a page body or anything visitors wrote (comments, form entries), so the file cannot carry text a visitor slipped in for an agent to follow. It is capped at 256 KB; past that the rest is left out and a last section points at the sitemap. A page already published at `/llms.txt` refuses the build with the way out. Served as `text/plain; charset=utf-8`.

An incremental build (`changedPageIds`: a Publish live of some kinds of change) renders only the pages a change reached, while the file speaks for the whole site. So it adds the pages the build leaves alone from the live page record (`live_page_versions`, `ContentStates.liveNotRendered`), with the URL, title and meta description they were published with, never from page rows that may hold unpublished edits; a recorded page whose URL is not its own address is left out, and a page whose row is gone waits for the next full build. Before the first recorded build there is no record to read them from, so an incremental build leaves the deployed file as it is, as it leaves those pages' HTML.

No Markdown versions of pages (maintainer decision 2026-11-26).

## Tests

- `apps/static-generator/src/llms-txt.test.ts`: the format, one line per value, escaping, the cap.
- `apps/static-generator/src/llms-txt.integration.test.ts`: no file while no plugin switches it on; on, only the indexable, self-canonical pages, with the site's name and the home page's description.
- `packages/plugins/seo/src/agent-files.test.ts`: the setting off by default, the answer, the manifest.
