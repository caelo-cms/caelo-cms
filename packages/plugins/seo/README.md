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

A feature adds files of its own and one entry in each list it uses.

### The audit runner

`checks/index.ts` is the contract with core's audit. Each rule family has
an optional `site` part (first call, once per Stage: read site-wide data
here) and an optional `facts` part (once per batch of up to 200 staged
pages with the facts core read from their HTML). The first answer asks
for fact batches with `batchPages: "own"`, so a batch call carries only
its own pages and costs the same on a small and a large site (#1721).

## Tests

`bun run test` from the repository root runs `src/*.test.ts`. The
plugin-host suite checks the built definition through the disk-load
pipeline (`shipped-plugins-validate.test.ts`) and pins its public surface
(`public-surface.test.ts`: none).
