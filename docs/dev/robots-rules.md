# robots.txt rules

Issue #1706. robots.txt is built, never a static file (`static-files.md`): the build writes it, and Publish live writes the live target's own. Until #1706 it said only `User-agent: * / Allow: /` and the Sitemap lines. The Owner may now add Allow and Disallow paths per user agent: to keep crawlers off a search results page, or an AI crawler off the whole site.

Rules and rendering: `packages/shared/src/robots-rules.ts`. Ops: `site_defaults.set_seo` / `get_seo` / `propose_set_seo` / `preview_set_seo` / `execute_proposal` (`packages/admin-core/src/ops/seo.ts`, `site_defaults_pending.ts`). AI tools: `get_site_seo`, `propose_set_site_seo` (`ai/tools/propose-set-site-seo.ts`). Owner page: Settings → SEO. Migration `0861_robots_rules.sql`.

## The rules

A list of groups, each `{ userAgents, allow, disallow, contentSignal? }`, validated by `robotsRulesSchema` at every write and every read:

- A user agent is `*` or a crawler's product token (RFC 9309: letters, digits, `_`, `-`). `*` stands alone in its group, and each user agent is named in one group only: a crawler follows only the most specific group that names it, so two groups for one crawler, or `*` mixed with a name, would read differently to different crawlers.
- A path starts with `/` and holds no whitespace, no control character and no `#`. So no value can end a line, start a comment or add a directive: the file holds only `User-agent`, `Allow`, `Disallow` and the Sitemap lines Caelo writes. `*` and a closing `$` keep their robots.txt meaning. Characters outside printable ASCII are percent-encoded when the file is written (RFC 9309 §2.2.2).
- At most 20 groups, 10 user agents and 50 paths per directive in a group, 512 characters per path.
- #1758 — the AI training preference token `__usage_ai-training` (IETF draft-kelley-aipref-training-preference-signal, 2026-10-30) may stand in a group of its own, like `*`: `Disallow: /` says "do not train on this site", Allow paths take parts back. It is no crawler, so it stands alone and carries no Content-Signal. Every other `__usage_` name is refused: a crawler would read it as the name of a crawler nobody runs. The token is matched without regard to case and stored as the draft spells it.
- #1758 — `contentSignal` adds one `Content-Signal:` line (contentsignals.org) after a group's User-agent lines: `search`, `aiInput` (`ai-input`) and `aiTrain` (`ai-train`), each yes or no, a key left out left unsaid. Three booleans, so no text can enter the file through it. A group still lists at least one path: a Content-Signal is no rule to a parser, and a group of only that line would take the next group's User-agent lines in (RFC 9309 §2.1), so those crawlers would read this group's paths as theirs. Use `allow: ["/"]` for a group that only states a signal.

The `*` group is the Owner's when they have one, else `Allow: /`; never both, because RFC 9309 lets an Allow win over an equally long Disallow, and an `Allow: /` next to the Owner's `Disallow: /` would quietly undo it. Named crawlers' groups follow in the Owner's order, then the Sitemap lines.

`robotsRulesWarnings` names what a rule set takes away from search engines (a group that disallows `/` or `/*`, a `*` Content-Signal with `search=no`); `robotsRulesNotes` says that the preference lines keep no crawler out. The approval card, `get_site_seo` and Settings → SEO show both.

The Settings → SEO field reads `Content-Signal: search=yes, ai-train=no` lines too, strictly (`parseRobotsRulesText`): one per group, only the three keys, each once, each `yes` or `no`; anything else names its line.

## Crawler policy by purpose (seo plugin)

Core checks and writes the lines; which crawler token serves which purpose is SEO knowledge that changes, so the `seo` plugin holds it (`packages/plugins/seo/src/crawlers/table.ts`): search, AI answers, AI training, pages fetched when a person asks an AI. Its tool `plan_crawler_policy` turns the operator's four choices into the whole `robotsRules` list for `propose_set_site_seo`, keeping the site's own paths and the crawlers the table does not know: every crawler of a blocked purpose gets `Disallow: /` in a group of the policy's (a crawler follows only the group that names it), training blocked adds the `__usage_ai-training` group, and the `*` group and every crawler group that may still crawl carry the policy as a Content-Signal. The proposal stays the Owner's click (§11.A).

The card shows the plugin's caveats under its name: a gated tool may name the writes it proposes (`GatedToolSpec.pluginWrites`), and the plugins that read the write kind `robots_rules` (`writeHintsKinds`) answer with write hints, which the in-chat card adds below the server's preview and the Power-MCP queue result passes to the agent. The seo plugin says per purpose what the rules do, names a token that covers several purposes (Googlebot also feeds AI Overviews; Google-Extended also Gemini app answers), the fetchers that may ignore robots.txt, who reads the training token, and any contradiction.

The seo plugin's Stage audit flags a policy that contradicts itself as an error (`plugin.seo/crawler-policy-contradiction`): the training token says no while a training crawler that does not read it may crawl the whole site, or the `*` Content-Signal refuses a use while a crawler of that purpose follows a group of its own that says nothing. A noindex page robots.txt keeps search engines from fetching is an error too (`plugin.seo/noindex-blocked`).

## How it goes live

**A rendered setting** (CLAUDE.md §2, [redirects-and-settings-sync.md](./redirects-and-settings-sync.md)): saving changes nothing visitors or crawlers get. The rules are stored live in `site_defaults.robots_rules` and read by every build:

- A staging build's robots.txt stays `Disallow: /` for every crawler, whatever the rules say.
- The build's run records the rules it was made with (`deploy_runs.robots_rules`, from the generator's done event through `deploy.finish_trigger`), like its security headers.
- Publish live writes the live robots.txt from the rules of the Stage it ships (`deploy.start_promote` reads the staged run's `robots_rules` and hands them to the publisher's `promoteToProduction`), never from the settings as they are by then: a rule saved after the Stage waits for the next Stage.
- Every run that puts something live carries the rules its robots.txt was written with: a Publish live copies the staged run's, a rollback the restored run's, a plugin-data build (#1155, which keeps the live robots.txt) its base run's. So a rollback restores the robots.txt of the build it restores, whichever run that was: self-hosted and gcp copy the build's own file, gcp-firebase re-derives it from the restored run's `robots_rules` (`deploy.start_rollback`).
- An Owner's direct production build writes them itself; `robots_rules` is part of the render fingerprint (`setting:robots_rules`), so a change since the last Stage refuses that build.
- A run from before the rules existed has `robots_rules` null: its build had none, and Publish live of it ships none.

## Who may change them

A wrong `Disallow: /` takes the site out of search, and getting back takes weeks of recrawling, so the AI's path is the §11.A gate: `propose_set_site_seo` with `robotsRules` (it REPLACES the whole list), an approval card that shows the live robots.txt the rules make and their warnings (`site_defaults.preview_set_seo`), and `site_defaults.execute_proposal`, whose approver needs `roles.manage`, the permission of Settings → SEO. The Owner writes them directly in Settings → SEO, as robots.txt lines parsed strictly (`parseRobotsRulesText`: only `User-agent`, `Allow` and `Disallow`). Reads are open: `get_site_seo` shows the rules, the live file they make and the warnings.

Disallow stops crawling, not indexing: a page that must disappear from search keeps noindex and stays crawlable until it is gone. A search results page is noindex and, when the operator wants it, disallowed for every language's path; the site-search skill says so.

## Tests

- `packages/shared/src/robots-rules.test.ts`: validation (no injected line, comment or directive), the warnings, the settings field read back; #1758: the token group and Content-Signal lines, refused preference names and signals, strict parsing of the field's Content-Signal lines.
- `packages/plugins/seo/src/crawlers/policy.test.ts`: the table, the plan for each choice, contradictions, the card hint within the SDK's limits.
- `packages/admin-core/src/__tests__/deploy-promote-seo.integration.test.ts` (#1758 case): "search and AI answers yes, training no" planned, its card notes, saved, staged and published; staging keeps `Disallow: /`, production ships the planned groups and lines.
- `apps/static-generator/src/generate.test.ts`: the file a target gets, staging's `Disallow: /`, the `*` group without `Allow: /`, encoding.
- `packages/admin-core/src/__tests__/site-seo-proposal.integration.test.ts`: the AI's proposal, the card, approval, a production build's file, refusal at propose time, no AI write without approval, a save that leaves the rules out.
- `packages/admin-core/src/__tests__/deploy-promote-seo.integration.test.ts`: a Stage keeps every crawler out, Publish live ships the Stage's rules and not a later save, the next Stage takes the newer ones live, a rollback restores the earlier file.
