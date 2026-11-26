# robots.txt rules

Issue #1706. robots.txt is built, never a static file (`static-files.md`): the build writes it, and Publish live writes the live target's own. Until #1706 it said only `User-agent: * / Allow: /` and the Sitemap lines. The Owner may now add Allow and Disallow paths per user agent: to keep crawlers off a search results page, or an AI crawler off the whole site.

Rules and rendering: `packages/shared/src/robots-rules.ts`. Ops: `site_defaults.set_seo` / `get_seo` / `propose_set_seo` / `preview_set_seo` / `execute_proposal` (`packages/admin-core/src/ops/seo.ts`, `site_defaults_pending.ts`). AI tools: `get_site_seo`, `propose_set_site_seo` (`ai/tools/propose-set-site-seo.ts`). Owner page: Settings → SEO. Migration `0785_robots_rules.sql`.

## The rules

A list of groups, each `{ userAgents, allow, disallow }`, validated by `robotsRulesSchema` at every write and every read:

- A user agent is `*` or a crawler's product token (RFC 9309: letters, digits, `_`, `-`). `*` stands alone in its group, and each user agent is named in one group only: a crawler follows only the most specific group that names it, so two groups for one crawler, or `*` mixed with a name, would read differently to different crawlers.
- A path starts with `/` and holds no whitespace, no control character and no `#`. So no value can end a line, start a comment or add a directive: the file holds only `User-agent`, `Allow`, `Disallow` and the Sitemap lines Caelo writes. `*` and a closing `$` keep their robots.txt meaning. Characters outside printable ASCII are percent-encoded when the file is written (RFC 9309 §2.2.2).
- At most 20 groups, 10 user agents and 50 paths per directive in a group, 512 characters per path.

The `*` group is the Owner's when they have one, else `Allow: /`; never both, because RFC 9309 lets an Allow win over an equally long Disallow, and an `Allow: /` next to the Owner's `Disallow: /` would quietly undo it. Named crawlers' groups follow in the Owner's order, then the Sitemap lines.

`robotsRulesWarnings` names what a rule set takes away from search engines (a group that disallows `/` or `/*`); the approval card and Settings → SEO show it.

## How it goes live

**A rendered setting** (CLAUDE.md §2, [redirects-and-settings-sync.md](./redirects-and-settings-sync.md)): saving changes nothing visitors or crawlers get. The rules are stored live in `site_defaults.robots_rules` and read by every build:

- A staging build's robots.txt stays `Disallow: /` for every crawler, whatever the rules say.
- The build's run records the rules it was made with (`deploy_runs.robots_rules`, from the generator's done event through `deploy.finish_trigger`), like its security headers.
- Publish live writes the live robots.txt from the rules of the Stage it ships (`deploy.start_promote` reads the staged run's `robots_rules` and hands them to the publisher's `promoteToProduction`), never from the settings as they are by then: a rule saved after the Stage waits for the next Stage.
- A rollback restores the robots.txt of the build it restores: self-hosted and gcp copy the build's own file, written with its rules; gcp-firebase re-derives it from the restored build's run (`deploy.start_rollback` reads `robots_rules` of the run that built it).
- An Owner's direct production build writes them itself; `robots_rules` is part of the render fingerprint (`setting:robots_rules`), so a change since the last Stage refuses that build.
- A run from before the rules existed has `robots_rules` null: its build had none, and Publish live of it ships none.

## Who may change them

A wrong `Disallow: /` takes the site out of search, and getting back takes weeks of recrawling, so the AI's path is the §11.A gate: `propose_set_site_seo` with `robotsRules` (it REPLACES the whole list), an approval card that shows the live robots.txt the rules make and their warnings (`site_defaults.preview_set_seo`), and `site_defaults.execute_proposal`, whose approver needs `roles.manage`, the permission of Settings → SEO. The Owner writes them directly in Settings → SEO, as robots.txt lines parsed strictly (`parseRobotsRulesText`: only `User-agent`, `Allow` and `Disallow`). Reads are open: `get_site_seo` shows the rules, the live file they make and the warnings.

Disallow stops crawling, not indexing: a page that must disappear from search keeps noindex and stays crawlable until it is gone. A search results page is noindex and, when the operator wants it, disallowed for every language's path; the site-search skill says so.

## Tests

- `packages/shared/src/robots-rules.test.ts`: validation (no injected line, comment or directive), the warnings, the settings field read back.
- `apps/static-generator/src/generate.test.ts`: the file a target gets, staging's `Disallow: /`, the `*` group without `Allow: /`, encoding.
- `packages/admin-core/src/__tests__/site-seo-proposal.integration.test.ts`: the AI's proposal, the card, approval, a production build's file, refusal at propose time, no AI write without approval, a save that leaves the rules out.
- `packages/admin-core/src/__tests__/deploy-promote-seo.integration.test.ts`: a Stage keeps every crawler out, Publish live ships the Stage's rules and not a later save, the next Stage takes the newer ones live, a rollback restores the earlier file.
