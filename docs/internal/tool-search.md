# Anthropic Tool Search (default on)

The AI tool catalogue passed ~125 tools. Shipping every description + JSON
schema on every request cost tens of thousands of prompt tokens per cold
call, so Caelo defers the long tail behind Anthropic's server-side Tool
Search and keeps only the everyday workflow tools fully loaded.

## How it works

Three pieces cooperate; keep them in sync when touching any one:

1. **Core set** — `packages/admin-core/src/ai/tools/core-tools.ts` names
   the ~24 always-loaded workflow tools (`build_page`, `add_module`,
   `edit_module`, `set_page_module_content`, …). `buildToolCatalogue`
   tags them `alwaysLoaded: true` on the provider-neutral
   `ToolDefinition`.
2. **Provider transform** — `providers/anthropic.ts` marks every tool
   WITHOUT the flag as `deferLoading: true` and injects the search tool
   (`bm25` scoring by default, `regex` optional). Deferred tools cost no
   description tokens until the model searches for them; a search loads
   the matching definitions into context and the model then calls them
   through the normal tool loop. The transform only engages when the
   catalogue has ≥ 10 tools (`CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD`),
   so narrowed subagent catalogues ship fully loaded.
3. **Tool playbook** — the `tool-playbook` system-prompt chunk
   (`system-prompt.ts`) maps operator intent → exact tool names (create /
   modify / extend a page, import a site, media, redirects, theme, …) and
   tells the model that more tools exist and how to load them via the
   search tool. This is how the model knows WHICH deferred tool to search
   for without blind discovery. Every tool the playbook presents as a
   default path must be in the core set — `tool-catalogue.test.ts` guards
   the core list against registry drift.

## Configuration

| Env | Values | Default | Effect |
|---|---|---|---|
| `CAELO_ANTHROPIC_TOOL_SEARCH` | `off` / `bm25` / `regex` | `bm25` | Search algorithm; `off` restores the ship-everything behaviour (needed for models predating Tool Search, i.e. older than Opus 4.5 / Sonnet 4.5). |
| `CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD` | integer ≥ 1 | `10` | Minimum catalogue size before the transform engages. |
| `CAELO_DEBUG_TOOL_SEARCH` | `1` | unset | Logs per-call whether the transform engaged. |

Non-Anthropic providers ignore all of this and receive the full
catalogue; the playbook's search-tool sentence is phrased conditionally
("when present") so it stays truthful there.

## Cache-breakpoint interaction

Anthropic rejects requests with more than 4 `cache_control` breakpoints.
The playbook chunk pushed the composer past the old exactly-4 cacheable
shape, so `buildSystemAndMessages` now tags only the LAST 4 cacheable
chunks — earlier chunks still ride inside every later breakpoint's
cached prefix (a breakpoint caches everything before it). Covered by the
cache-cap test in `__tests__/tool-search.test.ts`.
