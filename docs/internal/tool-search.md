# Anthropic Tool Search (default on)

The AI tool catalogue passed ~125 tools. Shipping every description + JSON
schema on every request cost tens of thousands of prompt tokens per cold
call, so Caelo defers the long tail behind Anthropic's server-side Tool
Search and keeps only the everyday workflow tools fully loaded.

## How it works

Three pieces cooperate; keep them in sync when touching any one:

1. **Core set** — `packages/admin-core/src/ai/tools/core-tools.ts` names
   the ~33 always-loaded workflow tools (`build_page`, `add_module`,
   `update_modules_many`, `set_page_module_content_many`, …). `buildToolCatalogue`
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

## Retired tool names (alias layer)

Every write tool that had a bulk twin was retired in favour of the twin
(CLAUDE.md §11: the singular is the n=1 case of bulk), and every bulk tool
whose top-level array holds per-item objects calls that array `items`.
This keeps the always-loaded core small and gives the model one tool per
job. Old names still arrive — chat history the model copies from,
Owner-edited skills and subagent specs, external Power-MCP agents,
approval rows queued before a rename — so
`packages/admin-core/src/ai/tools/retired-tools.ts` keeps one explicit
alias table:

- `RETIRED_TOOLS` — retired name → live tool + an `adapt` function that
  rewrites the old argument shape (usually `{ items: [args] }`).
- `ARG_RENAMES` — live tool → old wrapper key → `items`.

It is consulted at four seams: `ToolRegistry.get` / `dispatch`
(dispatch.ts — chat, Power-MCP, subagents, approval re-dispatch), the AI
SDK `repairToolCall` hook (`providers/_sdk-shared.ts`), skill allowlists
(`chat-runner/allowlist-mapping.ts`) and subagent `allowedToolNames`
(`spawn-subagent.ts`). Aliases never appear in the catalogue, the core set
or Power-MCP `tools/list`; every use logs `[tool.alias-used] old -> new`.
Nothing outside the two tables is guessed (CLAUDE.md §2).

### Retiring a tool

1. Move whatever only the old tool did into the surviving tool (result
   notes, guards, refusal flags), with tests on the survivor.
2. Delete the old tool file and its registration; add a `RETIRED_TOOLS`
   entry (or an `ARG_RENAMES` entry for a renamed key) and a case in
   `ai/tools/__tests__/retired-tools.test.ts`.
3. Rewrite every AI-facing mention to the live name, with the n=1 call
   shape where a call is shown: the system prompt, tool descriptions and
   result/error messages, quality-check `fix.tool` values, static-generator
   errors, shipped plugin strings and docs. `git grep -w <old_name>` must
   find only the alias table, its tests and history notes.
4. Add a cms_admin migration that rewrites the stored skill rows
   (`allowlisted_tools` mapped and deduplicated, bodies by guarded
   `replace()`), as `0364_skills_retired_tool_names.sql` does.
5. Regenerate `packages/mcp-server/power-catalogue.json`
   (`scripts/power-catalogue.test.ts` says how) and update the admin chat
   UI where it switches on tool names, keeping the old name for history
   rows.

Keep an alias until no stored data or supported external client can still
send the old name; removing one is a breaking change for Power-MCP agents.
