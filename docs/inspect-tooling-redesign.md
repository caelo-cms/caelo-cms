<!-- SPDX-License-Identifier: MPL-2.0 -->

# External-page inspection redesign — gist-first + on-demand HTML query

Status: **Phase 1 IMPLEMENTED** (links default-off, capped screenshot
wait, `htmlToMarkdown`, gist `markdown` facet + `pageRef` render cache +
`read_page_more`). Phases 2–3 (query_page_html, browser reuse, subagent
passthrough) + the skill-guidance migration are pending. Owner: TBD.

Implementation note for Phase 2: Phase 1 caches the *fetched* (static)
HTML under `pageRef` (the gist path never renders). `query_page_html`
should prefer the rendered `page.content()` when a screenshot/tokens
render already happened for that `pageRef`, and otherwise query the
cached static HTML (via Playwright `setContent`, per the selector-engine
decision) — re-rendering only when the caller explicitly needs the
JS-applied DOM and no cached render exists.

## 1. Why

The live thinking-A/B (scenario-onboarding) surfaced the cost. Given a
domain, the AI correctly builds an *overview* of the site's key pages
before proposing a crawl — the right behaviour. But the turn ran >8
minutes and was killed by the test's 480s idle-wait. Root causes, from
the admin-log trace (session `a0393aca`):

- **Raw HTML dumped into the main context.** `inspect_external_page`'s
  `markup` facet returns cleaned page HTML (up to 20K chars per extracted
  module). Seven inspects (1 + a batch of 6) stacked full markup into the
  turn history. Because LLM calls are stateless, every provider call
  re-sends the whole history → `tokensIn` climbed 60K → 144K → 190K →
  230K over four loops. Proactive compaction only trims results ≥3 loops
  old, so on a 4-loop turn it reclaimed a single 18K result — the big
  fresh inspect bodies were all still in the protection window.
- **A fresh Chromium launch + dispose per inspect.**
  `inspect-external-page.ts` calls `getExternalScreenshotter()` (→
  `createPlaywrightScreenshotter`, no cache) and `dispose()`s the browser
  in its `finally`, so N inspects = N cold browser starts.
- **Heavy per-capture wait.** `screenshot.ts` uses
  `waitUntil: "networkidle"` with a 30s timeout; the SSRF route-guard
  `abort()`s blocked subresources, so `networkidle` often never settles
  and each capture pays close to the full 30s.
- **Sequential dispatch.** The tool loop dispatches a turn's calls
  serially (`loop.ts` `for (const call of accumulatedToolCalls)`), so the
  batch of 6 inspects runs one-after-another.

The AI's *strategy* is right; our *tooling* makes it slow and
context-heavy. The fix separates two needs one tool conflates today:
"understand the page" (cheap, small) vs. "drill into its structure"
(targeted, on-demand).

## 2. The tool set

### 2.1 `inspect_external_page` — gist-first (redesign of the existing tool)

Purpose: *what is this page about, how is it laid out, how does it look* —
in the smallest context that answers those.

**Facets are dynamic and opt-in — the default is the minimal gist.** The
AI names only what it needs; voluminous facets stay OFF unless switched
on. This is the general principle, not a per-facet special case.

Default facet set (no `facets` named):

- **Full-page screenshot** (the visual "how does it look"). One capture
  per page.
- **Page text as Markdown**, not raw HTML. Readability extracts the main
  content; an HTML→Markdown pass (Turndown) drops tags/attributes/
  scripts/styles → typically 5–10× smaller than the current `markup`
  facet. Truncated to a token budget, with a **cursor** for "the rest".
- **meta** (title, description, canonical, og). Cheap.

Opt-in facets (OFF by default, `facets: { … : true }` to enable):

- **`links`** — the page's link inventory. **Changed from today's
  default-on to default-OFF.** Rationale: a nav/footer/blog-index page can
  carry **200+ links**, which dumps a large list into context on *every*
  inspect — but the full inventory is usually needed only ONCE (the first
  / homepage inspect, to discover site structure), not on each subsequent
  page. The AI switches `links: true` when it actually wants the inventory
  (site-structure discovery) and leaves it off for content inspects. A
  future refinement: cap/paginate the link list (like the Markdown
  cursor) when it is enabled and huge.
- **`altTexts`**, **`tokens`** (computed-style design tokens — needs the
  render), and any **`rawHtml`** escape-hatch: all opt-in. The intended
  path for *structure* is `query_page_html` (§2.2), not a raw-HTML facet.

Removed from the default: the heavy cleaned-HTML `markup` facet.

**Returns a `pageRef` (page handle).** The render is captured ONCE and
cached (§3); `pageRef` lets follow-up tools reuse it without re-fetching
or re-rendering. Shape sketch:

```
inspect_external_page({ url, facets? })
  → { pageRef: "pg_<hash>", screenshot?, markdown: { text, cursor|null }, meta, links }
```

### 2.2 `query_page_html` — powerful, on-demand, targeted (new)

Purpose: pull *specific* structure out of a page when building a template
from a sample — without ever putting the whole HTML in context.

```
query_page_html({
  pageRef?,            // reuse an already-rendered page (preferred — no re-render)
  url?,                // fallback: fetch+render on demand if no pageRef
  keyword?,            // text search → return the enclosing element + surrounding context
  cssSelector?,        // return matching elements' outerHTML
  xpath?,              // same, via xpath
  maxMatches?, contextChars?
}) → { matches: [{ html, path }], truncated }
```

- **`pageRef` is the primary input** (per the design decision below): the
  page was already rendered by a prior `inspect_external_page`; querying
  it must NOT re-render. `url` is the on-demand fallback.
- Returns matching fragments **with surrounding context** (enclosing
  element + N chars/siblings), capped by `maxMatches` / `contextChars`.

### 2.3 `read_page_more` — Markdown pagination (new, small)

```
read_page_more({ pageRef, cursor }) → { text, cursor|null }
```

Continues the Markdown from §2.1 without re-rendering — same `pageRef`.

### 2.4 Subagent pattern for large-HTML extraction

For "extract X from this big page" (a price table, the nav structure, a
product grid), the AI spawns a subagent whose task carries the `pageRef`
(or url). The child holds the full HTML in ITS context and returns only
the distilled result → the parent chat stays lean. This is the same
context-isolation subagents already provide; no new machinery, just
guidance in the skills (§6) and `pageRef` passthrough.

## 3. The page handle + render cache (load once, reuse everywhere)

The load-bearing piece (explicitly requested): a `pageRef` returned by
`inspect_external_page` that `query_page_html` / `read_page_more` / a
subagent can point at so **the page is never rendered twice**.

- On `inspect_external_page`, after Chromium renders the page, capture
  `page.content()` (the **post-JS rendered HTML**) plus the extracted
  Markdown, and cache them under `pageRef` (a hash of url + a nonce).
- **Selector engine = reuse the Playwright page (decided).** Concretely:
  `query_page_html({pageRef})` re-hydrates the cached rendered HTML into a
  fresh lightweight page via `page.setContent(cachedHtml)` (cheap: no
  network, no JS re-fetch — the JS already ran at inspect time) and runs
  css/xpath/keyword through Playwright locators. This satisfies both
  goals: query the *rendered* DOM via Playwright, with **no re-fetch /
  no re-render**.
- **Cache scope + lifecycle:** in-memory, keyed by `pageRef`, scoped to
  the chat session (or a short TTL + LRU cap). Because subagents run
  in-process (`spawnChildChatTurn`), a child can share the parent's cache
  by `pageRef` — passing the handle is enough. On `url`-only fallback,
  `query_page_html` renders once and populates the cache too.
- **Fetch/render cost fixes fold in here:** one browser reused across a
  session (not launch+dispose per inspect), and a lighter capture wait
  (`waitUntil: "domcontentloaded"` or a short `networkidle` cap) so the
  30s stalls disappear.

Open: whether to persist the render cache anywhere (DB) or keep it purely
in-memory. Default recommendation: in-memory, session-scoped, LRU-capped
— a `pageRef` that has been evicted falls back to a re-render from `url`.

## 4. Decisions taken

- **Plan-first** before code (this doc). — user, this session.
- **Selector engine: reuse the Playwright page** (no new DOM-parse
  dependency; queries the JS-rendered DOM). Follow-ups reuse the cached
  rendered HTML via `pageRef` + `setContent`, not a network re-fetch. —
  user, this session.

## 5. Dependencies / licensing (verify before adding — CLAUDE.md §3)

- **Turndown** (HTML→Markdown) — MIT (verify current version).
- **@mozilla/readability** (main-content extraction) — Apache-2.0
  (verify). Both MPL-2.0-compatible per §3; pin exact versions and record
  licenses in the PR.
- No new DOM-query dependency — Playwright (already present) handles
  css/xpath/keyword.

## 6. Skill updates (the flows that use these tools)

- `site-migrate` / onboarding: Step 1 "understand" → `inspect_external_page`
  (screenshot + Markdown). Enable `links: true` on the FIRST / homepage
  inspect to discover site structure; leave links OFF for the following
  content inspects. Then propose the crawl and STOP. Step 3 "build a
  template from a sample" → `query_page_html` (targeted) or a subagent for
  big pages. Make explicit: do NOT pull raw HTML into the main chat for
  understanding.
- `import-page`, `site-genesis` (parity inspection): same split.

## 7. Phases

1. **DONE — Gist-first `inspect_external_page` + render cache + lighter
   wait.** `markdown` facet (+ `read_page_more` cursor), `pageRef` cache,
   links default-off, capped screenshot settle wait. Removes the context
   bloat + most latency. (Browser reuse + the skills' Step-1 migration
   still to land — see below.)
2. **`query_page_html`** (pageRef-first; url fallback) with keyword / css /
   xpath via the reused Playwright page. Update Step-3 guidance.
3. **Subagent-for-large-HTML** guidance + `pageRef` passthrough into spawn
   specs.
4. **Browser reuse** (one Chromium per session, idle-close) + the
   **skill-guidance migration**: migrate/onboarding/import Step-1 → gist
   default + `links:true` only on the first inspect + `read_page_more`;
   Step-3 → `query_page_html`; add the new tools to those skills'
   allowlists (preload hints).

## 8. Verification

- Unit: Markdown extraction shape + truncation/cursor; `query_page_html`
  selector/keyword matching against a fixture page; cache hit reuses the
  render (assert no second navigation).
- e2e-livedit (`scenario-onboarding`, `scenario-migrate`): the overview
  turn stays well under the idle timeout; assert `tokensIn` growth and
  per-turn wall-clock drop vs. the current baseline (numbers from this
  session: onboarding 8.1m → target < ~2m; `tokensIn` peak 230K → target
  far lower).

## 9. Open questions

- Truncation budget for the Markdown facet (tokens) + default
  `contextChars` / `maxMatches` for `query_page_html`.
- Cache eviction policy (TTL vs. LRU vs. session-end) and cap.
- Whether `query_page_html` should also accept an internal (already
  imported) page, not just external — i.e. unify with `inspect_page_render`.
- Do we keep a `rawHtml` escape-hatch facet on `inspect_external_page`, or
  force all structure access through `query_page_html`?
