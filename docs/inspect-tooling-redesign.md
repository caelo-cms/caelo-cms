<!-- SPDX-License-Identifier: MPL-2.0 -->

# External-page inspection redesign — gist-first + on-demand HTML query

Status: **FULLY IMPLEMENTED** (Phase 1 + Phase 2 + browser reuse + skill
migration), live-validated on scenario-onboarding (8.1m timeout-fail →
82s pass). Done: links default-off, capped screenshot wait,
`htmlToMarkdown`, gist `markdown` facet + `pageRef` render cache +
`read_page_more`, `query_page_html` (keyword / cssSelector / xpath /
describe-small-model), shared-Chromium reuse (idle-close), and the
site-migrate / import-page skill guidance (gist-first + crawl-first).

Rendered-DOM preference: DONE. When an inspect renders the page
(screenshot/tokens), the screenshotter also captures `page.content()`
(the JS-applied DOM) and the pageRef cache stores it as `renderedHtml`;
`query_page_html` prefers `renderedHtml ?? html`, so selectors run against
the real DOM when one was rendered and fall back to the static fetch
otherwise. No known remaining work.

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
  pageRef?,            // reuse the already-fetched page (preferred — no re-fetch)
  url?,                // fallback: fetch on demand if no pageRef
  // exactly ONE mode:
  keyword?,            // text search → return the enclosing element + surrounding context
  cssSelector?,        // return matching elements' outerHTML
  xpath?,              // same, via xpath
  describe?,           // natural language → a SMALL model (Haiku) extracts it (below)
  maxMatches?, contextChars?
}) → { matches: [{ html, path }], truncated }  // or the small model's extraction for `describe`
```

Three query modes; the caller picks whichever fits:

- **`keyword` / `cssSelector` / `xpath`** — deterministic. `pageRef` is the
  primary input; querying must NOT re-fetch. Returns matching fragments
  with surrounding context (enclosing element + N chars/siblings), capped
  by `maxMatches` / `contextChars`. Selector modes run via the reused
  Playwright page (`setContent` on the cached HTML).
- **`describe`** (natural language) — when the caller can't name a
  selector, it describes what it wants ("the pricing table", "the primary
  nav structure", "every product card's title + price"). The tool runs a
  **small model (Haiku) one-shot** over the cached page HTML and returns
  only the extracted fragment(s)/answer. This REPLACES a separate
  large-HTML subagent (§2.4): the big HTML is passed to the cheap model
  inside the tool and never enters the main chat's context — same
  context-isolation win, but one tool call instead of spawn orchestration,
  and a Haiku-priced extraction instead of a full child turn.

### 2.3 `read_page_more` — Markdown pagination (new, small)

```
read_page_more({ pageRef, cursor }) → { text, cursor|null }
```

Continues the Markdown from §2.1 without re-rendering — same `pageRef`.

### 2.4 Large-HTML extraction — folded into `query_page_html`'s `describe` mode

Superseded by §2.2's `describe` mode (user decision). Rather than spawn a
full subagent for "extract X from this big page", `query_page_html`
handles it internally: it runs a small model (Haiku) one-shot over the
cached HTML and returns only the distilled result. The big HTML lives in
the cheap model's one call, not the parent chat and not a spawned child.
Cheaper (Haiku vs a full child turn) and simpler (one tool call, no spawn
machinery), same context-isolation guarantee.

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
2. **DONE — `query_page_html`** (pageRef-first; url fallback): keyword,
   cssSelector, xpath, and describe (small-model) modes all landed.
3. **DONE (folded in) — large-HTML extraction** is `query_page_html`'s
   `describe` mode (small model), not a separate subagent.
4. **DONE — Browser reuse** (one Chromium per session, idle-close) + the
   **skill-guidance migration**: migrate/onboarding/import Step-1 → gist
   default + `links:true` only on the first inspect + `read_page_more`;
   Step-3 → `query_page_html`; crawl-first guard; new tools preloaded in
   import-page's allowlist.

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
