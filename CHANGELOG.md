# Changelog

## v0.10.20

### Fixes
- 034ad9d set_nav_menu — full per-item JSON Schema + inline items in system prompt

## v0.10.19

### Fixes
- 682d14e release per-entity locks at chat.merge_to_main (Stage), not just publish

## v0.10.18

### Tests
- 9b61050 align provider-fixture-replay with v0.10.17 done-event shape

## v0.10.17

### Other
- 6e9e47d capture provider stop_reason + warnings on empty-response (root-cause hunt)

## v0.10.16

### Fixes
- f5ace73 drop false-positive passive-response warning on legitimate question-asking turns

## v0.10.15

### Fixes
- a51389a cross-chat banner counted already-merged work as pending

## v0.10.14

### Tests
- c6fdf06 seed template_blocks in chained-branched-page-layout test

## v0.10.13

### Fixes
- 563c796 branched page-layout overlay — chained add_module_to_page → reorder_module no longer fails

## v0.10.12

### Features
- f5f132a "Publish live" + persistent staging link + live-matches-staging indicator

## v0.10.11

### Fixes
- 9e95e83 Firebase promote now patches robots.txt with destination env's robotsDefault

## v0.10.10

### Fixes
- 2aadb32 post-Stage modal showed phantom layout-chrome + "Promote staging" opened Stage modal

## v0.10.9

### Fixes
- da19491 Promote button hidden after Stage — use chat.last_staged_at as 'has staged' signal

## v0.10.8

### Fixes
- 90da798 pending-changes badge resets to 0 after Stage (last_staged_at on chat_sessions)

## v0.10.7

### Fixes
- 3508186 pages.set_status — bypass jsonb_set; write whole jsonb blob via ::jsonb cast

## v0.10.6

### Fixes
- ec3063e pages.set_status — split CTE+UPDATE into two simple queries (bun-sql workaround)

## v0.10.5

### Fixes
- d7c78d1 pages.set_status — rewrite snapshot UPDATE as CTE so bun-sql parses it

## v0.10.4

### Chores
- 331ec5d log full pages.set_status error to stderr for Cloud Run diagnosis

## v0.10.3

### Fixes
- 6f1e766 pages.set_status referenced non-existent updated_by column

## v0.10.2

### Tests
- ac1714a use the seeded test-AI actor id so audit FK resolves

## v0.10.1

### Tests
- a57dce0 surface modules.update error in chained-edits regression test

## v0.10.0

### Features
- f30e3b9 chained branched edits compose without losing intermediate state

## v0.9.13

### Features
- 02d107c AI status-flip tools (singular + bulk) wrapping pages.set_status

## v0.9.12

### Fixes
- 40d0b81 status toggle reverts on Stage — branched page_snapshot was never patched

## v0.9.11

### Fixes
- 83bed9a status toggle badge didn't update — pages.update with branch ctx skips the live row

## v0.9.10

### Chores
- 2457a38 biome auto-format on v0.9.9 changes

## v0.9.9

### Features
- 99daa4f Stage ≡ Production + per-page status toggle + AI status policy

## v0.9.8

### Fixes
- c34defb staging deploys were shipping zero pages because static-gen filtered out drafts

## v0.9.7

### Fixes
- adac131 iframe click-through dropped ?branch= → branched pages 404'd

## v0.9.6

### Fixes
- 3543608 /edit preview iframe was 404ing for AI-branched pages

## v0.9.5

### Fixes
- af76687 /edit seen-set effect looped forever when data.pages was empty

## v0.9.4

### Fixes
- 6d1af8e floating overlay drag/resize/Send broken — iframe ate the pointer-up

## v0.9.3

### Fixes
- a1a6fe5 /edit page-load is now branch-aware — AI's branched-create pages were invisible

## v0.9.2

### Fixes
- d3b60fd upgrade lifecycle ran migrations against the OLD image

## v0.9.1

### Chores
- 57c0d38 biome lint cleanup (exclude claude-workflow + auto-fixes)

## v0.9.0

### Features
- 6425bff branched-create with same-chat visibility + cross-chat write-block

## v0.8.1

### Fixes
- 2edc572 StageDeployButton popover dismissal + Promote-only fallback

## v0.8.0

### Features
- 8cec2ca Stage to toolbar, accurate counter, cross-chat awareness, lock humanization

## v0.7.5

### Fixes
- bd1162f restore add_module_to_layout to bootstrap-site + compose-page skill allowlists

## v0.7.4

### Fixes
- 0fb163f bootstrap_site_scaffold told AI to stop when it should continue

## v0.7.3

### Fixes
- 3a1d0cb StageDeployButton stayed hidden when chat had branch edits

## v0.7.2

### Chores
- 3c75862 remove orphaned stage_change AI tools + polish StageDeployButton error UX

## v0.7.1

### Chores
- 1fcb65a clean up legacy Stage UI + polish StageDeployButton

## v0.7.0

### Features
- 90b8158 Stage / Publish UX redesign — 1:1 staging preview + selective production publish

## v0.6.6

### Fixes
- db7f53f Pulumi IAM hardening — telemetry roles + drop dead resend secret + stale comment

## v0.6.5

### Fixes
- 6385c65 grant admin SA roles/run.viewer on gateway for Firebase Hosting deploy

## v0.6.4

### Fixes
- ba8c2d6 queue approve-during-stream nudges + flush when streaming ends

## v0.6.3

### Fixes
- eebd339 Firebase Hosting headers REST shape — map<string,string>, not array-of-{key,value}

## v0.6.2

### Fixes
- f3d7efb position string-number coercion + chrome-block redirect + ToolCardRouter heuristic

## v0.6.1

### Features
- 55a2fcc branch-aware placement check + SEO tools in allowlists + composite SEO auto-fill

## v0.6.0

### Features
- f098a0e deferred topics — compose_page_from_spec, revert_chat_changes, delete_pages_many needsApproval reference
- 15691cd state-aware AI tools — describe(state), Tool Search, nextAction, composite bootstrap, needsApproval gate
- b54d1e1 upgrade to AI SDK 6 + provider v3

### Fixes
- 49e4be3 close all alpha.3 loose ends — dispatch result propagation, retry helper extraction, cross-actor test
- 5ef5256 close all alpha.2 loose ends — chat.get_branch_id, schema-validated retry, integration tests
- 453cc8e close all alpha.1 loose ends — W5 persistence, raw-SQL fix, real W3 retry, nextAction coverage, skill bodies

### Chores
- 93bc715 v0.6.0-alpha.2
- 103fd9c v0.6.0-alpha.1
- ca5c723 v0.6.0-alpha.0

## v0.6.0-alpha.4

### Fixes
- **T (high):** Approve route now appends the dispatched tool's actual result to the chat as a `role: "tool"` message via `chat.append_message`. AI sees the real outcome (e.g., for `delete_pages_many`: how many actually deleted, what was already-deleted, what was not-found) on its next turn — was: only saw a generic "proposal applied" client-side notification.
- **X (high):** Integration-test wipe broadened from `chat_session_id = SESSION_ID` to `tool_name = 'integration_test_gated_tool'` — catches rows the first test inserts without a chatSessionId. Prevents dev-DB pollution.
- **R:** Approve route documents the actor-scope constraint: Owner-ctx dispatch means tools with `actorScope` excluding "human" would fail at approve-time. Every currently-shipped gated tool has `["human", "ai", "system"]`; future ai-only gated tools would need scope widened.
- **V:** `docs/propose-execute-pattern.md` extended with a "v0.6.0 alternative — `needsApproval` predicate" section + a "when to use which" table + the three documented constraints (built-in-tools-only, Owner-ctx dispatch, live-commit semantics).
- **W:** W3 auto-recovery logic lifted from `chat-runner.ts` (135 lines, 5 nesting levels) to `auto-recovery.ts` (focused module with helper functions, 2 nesting levels). chat-runner call site is now ~15 lines.

### Features
- **U:** New `chat-get-branch-id.integration.test.ts` — 3 tests covering cross-actor lookup (AI ctx reading a human-owned chat's branch id), missing-session graceful return, and regression guard pinning that `chat.get_session` DOES still filter by `created_by` (so the separate op stays justified).
- New `auto-recovery.test.ts` — 13 unit tests for `tryAutoRecover` + `extractAtPath`: happy path, non-read-only recovery rejection, missing-from-catalogue, no-retry-spec fold, path-doesn't-resolve fold, schema-validation skip, retry-also-failed both-attempts surfacing, plus 6 `extractAtPath` edge cases.

## v0.6.0-alpha.3

### Fixes
- **A (critical):** Fix #2's `revert_chat_changes` migration to `chat.get_session` silently broke the tool for AI callers — that op filters by `created_by = ctx.actorId`, and the AI actor is never the chat's creator. New `chat.get_branch_id` op (AI scope, no creator filter) returns just the branch id + creator. Restored revert_chat_changes works against chats the human user owns.
- **B (contract):** Approve route explicitly documents live-commit semantics — `chatSessionId` carries through to the audit log but `chatBranchId` is deliberately omitted so approved gated tools commit directly to main, not to the proposing chat's branch.
- **C (constraint):** Approve route documents the built-in-tools-only constraint — `createDefaultToolRegistry()` doesn't include Tier-1 plugin tools, so any future plugin tool with `needsApproval` would queue fine but the Approve dispatch would 400. Plain comment, no behavior change.
- **D:** Dispatcher out-of-chat fallback now emits a NON-canonical `[needs-approval, non-persisted] <tool> would queue …` string so ProposeCard's regex skips it. Prevents a confusing "click Approve → 400" UX in the (currently theoretical) case where the fallback ever reaches a chat surface.
- **G:** Chat-runner validates the rewritten args against the original tool's Zod schema BEFORE re-dispatching. Misconfigured `nextAction.retryWithArgs` falls through to fold-into-content with a clear "[retry skipped — rewritten args failed schema]" marker instead of confusing the AI with an "invalid arguments" error.

### Features
- **F+H:** `list_pages`, `find_media`, `find_redirects` now populate `ToolResult.value` so the W3 retry path works for any `nextAction.retryWithArgs` pointing at them, not just `list_layouts` / `list_templates`.
- **E:** New `tool-approvals.integration.test.ts` — 5 tests against real Postgres covering queue + atomic claim + result tracking + list-pending filter + reject. Locks in the contract that the W5 persistence layer actually works.
- **I:** `/security/tool-approvals/pending` now linked from the Security control panel under "Tool approvals (queue)".
- **K (skill body):** Migration 0084 appends a one-paragraph nudge to compose-page + bootstrap-site skills explaining the "Queued proposal <uuid>: ... needs Owner approval" pattern so the AI doesn't claim success on a gated tool.

### Docs
- `ToolDescribeState.actor` + `fetchedAt` now have explicit "future extension point" comments rather than appearing unused.

## v0.6.0-alpha.2

### Fixes
- W5 persistence layer wired end-to-end: new `tool_approval_actions` table + `tool_approvals.{queue, read_for_execute, mark_result, reject_proposal, list_pending}` ops + `/security/tool-approvals/pending` route. Gated tools now emit canonical `Queued proposal <uuid>:` content; ChatPanel's ProposeCard renders the inline Approve / Reject buttons; Approve atomically claims the row and dispatches the tool with the persisted args via `createDefaultToolRegistry()`.
- `revert_chat_changes` no longer uses raw `new SQL()` (CLAUDE.md §2 violation) — switched to `chat.get_session` op.
- W3 auto-recovery now actually retries the original call. New `nextAction.retryWithArgs: {argName, fromValuePath}` declarative spec; tools populate `ToolResult.value` with structured payload; chat-runner extracts at the path and re-dispatches the original tool with corrected args. AI never sees the original failure when retry succeeds. Bounded to one retry per call.
- `nextAction` extended to 4 more ops: `add_module_to_page` block-not-found (suggests `inspect_page_render`), `add_module_to_layout` layout/block-not-found (suggests `list_layouts`, autoExecute on layout-not-found), `add_module_to_template` no-pages-bound (suggests `list_templates`), `set_page_module_content` placement-not-found (suggests `inspect_page_render`).
- Skill bodies updated: `bootstrap-site` now describes the idempotent `bootstrap_site_scaffold` flow; `compose-page` recommends `compose_page_from_spec` for multi-section pages.
- Tool Search threshold tunable via `CAELO_ANTHROPIC_TOOL_SEARCH_THRESHOLD` env (default 10); `CAELO_DEBUG_TOOL_SEARCH=1` logs whether the transform engaged each turn.
- `ToolDescribeStateLayout.blocks` now carries `position` (was dropped previously).
- `revert_chat_changes` cap message clarified — counts entity-snapshot ROWS (each is a revert operation), not unique entities.

## v0.6.0-alpha.1

### Features
- Composite tools: `compose_page_from_spec` (page + N section modules in one call), `revert_chat_changes` (one Approve undoes a whole chat).
- W5 reference: `delete_pages_many` gates at 5+ pages via `needsApproval` predicate.

## v0.6.0-alpha.0

### Features
- AI SDK 5 → 6 upgrade (`ai@6.0.183`, `@ai-sdk/anthropic@3.0.78`, `@ai-sdk/google@3.0.74`, `@ai-sdk/openai@3.0.64`).
- W1: state-aware tool descriptions via `describe(state)` callback on `ToolDefinitionWithHandler`. 6 high-value tools migrated.
- W2: Anthropic Tool Search (BM25 / regex) opt-in via `CAELO_ANTHROPIC_TOOL_SEARCH={bm25,regex}`.
- W3: structured recovery via `HandlerError.nextAction`; chat-runner auto-executes read-only recoveries.
- W4: `bootstrap_site_scaffold` composite — idempotent forward-progress across the Owner-approval gap.
- W5 (foundation): `needsApproval` + `buildApprovalPreview` predicate on tool definitions; dispatcher gate.

## v0.3.6

### Fixes
- 5a2f81e Firebase project init + admin roles for gcp-firebase (v0.3.6)

## v0.3.5

### Fixes
- 717d44c gcp-firebase stack type errors + stack-level tsconfig (v0.3.5)

## v0.3.4

### Fixes
- 74b7fbc bundle ts-node so Pulumi can load stack .ts files (v0.3.4)

## v0.3.3

### Fixes
- 7a90f5b gcp-firebase cost preview drops LB/CDN/Armor lines (v0.3.3)

## v0.3.2

### Chores
- bfeb572 drop dead anthropic-api-key wizard path (v0.3.2)

## v0.3.1

### Fixes
- fdd69ca gcp-firebase launch-readiness (v0.3.1)

## v0.3.0

### Features
- 2aacedf gcp-firebase provider (v0.3.0)

## v0.2.85

### Features
- c2aaab3 page_url_style 'no-extension' for clean URLs (v0.2.85)

## v0.2.84

### Fixes
- 2ab2083 staging-preview path + drop v0.2.83 override (v0.2.84)

## v0.2.83

### Fixes
- c387d45 config-pinned secret override preserves KEK across v0.2.81 transition (v0.2.83)

## v0.2.82

### Features
- 267b772 surface KEK-mismatch on /security/ai (v0.2.82)

## v0.2.81

### Fixes
- 984d98a KEK no longer rotates on every pulumi up (v0.2.81)

## v0.2.80

### Fixes
- 8dfe693 incremental Stage no longer crashes (v0.2.80)

## v0.2.79

### Features
- 1458a0a cascade-expansion + inspect_built_page + staging GC (v0.2.79)

## v0.2.78

### Features
- fde3ce7 cloud-portable Stage / Confirm-publish via GCS (v0.2.78)

## v0.2.77

### Fixes
- 02ccc8c surface real generator error in Stage button (v0.2.77)

## v0.2.76

### Fixes
- e73421d pending-changes badge survives page reload (v0.2.76)

## v0.2.75

### Features
- a9f98b8 post-approval auto-reload + auto-continue (v0.2.75)

## v0.2.74

### Features
- 7317d29 multimodal pipeline + screenshot_page tool — operator-browser capture (v0.2.74)

## v0.2.73

### Refactors
- 5419a2a port OpenAI / Gemini / local-OpenAI-compat to AI SDK; extract shared helpers (v0.2.73)

## v0.2.72

### Refactors
- 1073ebf Anthropic provider rewritten on Vercel AI SDK; same public shape (v0.2.72)

## v0.2.71

### Tests
- 3aa4732 SDK migration preflight spikes — all three checks PASS (v0.2.71)

## v0.2.70

### Fixes
- 8370476 inspect-page-render typecheck + add AI SDK deps for v0.3.0 spike (v0.2.70)

## v0.2.69

### Features
- 27df92c inspect_page_render tool — give the AI eyes on the rendered cascade (v0.2.69)

## v0.2.68

### Fixes
- 549bd7d expose verdict/tree/freeform schemas to the AI in tool descriptions (v0.2.68)

## v0.2.67

### Fixes
- 50a33d9 surface raw output + observed keys when verdict shape parse fails (v0.2.67)

## v0.2.66

### Fixes
- bf4ef84 teach the AI that template render slots are <caelo-slot>, not HTML comments (v0.2.66)

## v0.2.65

### Fixes
- f4bc74b pages.get_with_modules surfaces empty template_blocks; templates.update accepts blocks (v0.2.65)

## v0.2.64

### Fixes
- 7b95f0d teach the AI about the in-chat approval strip + tool-card buttons (v0.2.64)

## v0.2.63

### Features
- ec6b0df pending-proposals strip — sticky inline approval UI for queued propose_* (v0.2.63)

## v0.2.62

### Features
- b9d56a0 inline Approve / Reject buttons on propose tool-cards (v0.2.62)

## v0.2.61

### Fixes
- 1781f91 resolveChatSessionId queries chat_sessions, not the nonexistent chat_branches table (v0.2.61)

## v0.2.60

### Features
- c19bd33 live activity pill — show what the agent is doing during streaming (v0.2.60)

## v0.2.59

### Fixes
- d7f916f SSE keep-alive ping + X-Accel-Buffering: no — fix proxy idle-timeout aborts (v0.2.59)

## v0.2.58

### Fixes
- 733377e surface stream-abort to the chat UI + abort-source forensics (v0.2.58)

## v0.2.57

### Fixes
- 402526e switch chat-runner traces console.info → console.error so they actually reach Cloud Run logs (v0.2.57)

## v0.2.56

### Fixes
- bb10210 replace silent /edit→/content/chat redirect with explicit error + breadcrumbs (v0.2.56)

## v0.2.55

### Features
- 723f702 per-chat debug toggle + per-loop runner logging + manifest CORS fix (v0.2.55)

## v0.2.54

### Features
- 3aeed98 extended-thinking toggle + 32k default max_tokens (v0.2.54)

## v0.2.53

### Features
- 22c2916 bump max output tokens 4096 → 16384, add per-provider config knob (v0.2.53)

## v0.2.52

### Fixes
- 3a18f71 tool exceptions become recoverable failures + persist-fail surfaces (v0.2.52)

## v0.2.51

### Fixes
- baae7c9 SSR-safe markdown + Cloud Run admin SSE timeout (v0.2.51)

## v0.2.50

### Fixes
- 0ce0b14 clear compose-page allowlist to fix silent chat stall (v0.2.50)

## v0.2.49

### Fixes
- 5b83c5a bake post-incident defaults to prevent SQL conn exhaustion (v0.2.49)

## v0.2.48

### Fixes
- 382d1b0 alwaysOn skills no longer narrow tool catalogue (v0.2.48)

## v0.2.47

### Features
- 6106f7d composer affordances — slash / @-mention / drag-drop (v0.2.47)

## v0.2.46

### Features
- 379883b tool-result cards + inline diff + debug panel (v0.2.46)

## v0.2.45

### Features
- 6fa7572 smooth UI — autoscroll + markdown + typing indicator (v0.2.45)

## v0.2.44

### Tests
- 5f6cedc Playwright propose → approve flow (v0.2.44)

## v0.2.43

### Docs
- 90680c1 pattern reference + CLAUDE.md cross-link (v0.2.43)

## v0.2.42

### Features
- c743032 plugin_rate_limit_proposals 'superseded' status (v0.2.42)

## v0.2.41

### Fixes
- 1e07fe9 /security/pending Review button uses anchor + buttonVariants

## v0.2.40

### Features
- af7bfa1 per-domain AI activity aggregator (v0.2.40)

## v0.2.39

### Other
- 48941d2 test+fix(propose): integration test fixture + jsonb-payload parse fix (v0.2.39)

## v0.2.38

### Features
- d33a052 per-domain context blocks + AI-self-filtered pending block (v0.2.38)

## v0.2.37

### Features
- 8b6d91c GC worker + cancel_proposal AI tool (v0.2.37)

## v0.2.36

### Features
- 98f7ed4 unified /security/pending Owner inbox + chat origin per row (v0.2.36)

## v0.2.35

### Features
- 1cd9f93 schema foundation — chat origin + dedup + cancelled status (v0.2.35)

## v0.2.34

### Chores
- ce6ce5e tool-description sweep — bulk routing pointers (v0.2.34)

## v0.2.33

### Features
- 2249f14 bulk variants for pages + modules (v0.2.33)

## v0.2.32

### Features
- d56a0ea cross-domain pending-proposals aggregator + chat-runner block

## v0.2.31

### Features
- d3fd2e1 wire v0.2.20-v0.2.30 propose ops as AI tools (v0.2.31)

## v0.2.30

### Features
- 3828bbe propose/execute pairs for add/remove + widen verify

## v0.2.29

### Chores
- c676050 strip unused biome-ignore comments + fix useOptionalChain

## v0.2.28

### Features
- e1f391f propose/execute pairs for update/delete

## v0.2.27

### Features
- 1efe3c1 propose/execute pairs for create/revoke

## v0.2.26

### Features
- e1ac279 propose/execute pairs for set/clear_key

## v0.2.25

### Features
- 45eb5a5 propose/execute pair + Owner-supplies-secret pattern

## v0.2.24

### Features
- b55db8f propose/execute pairs for activate/complete

## v0.2.23

### Features
- 92200fc propose/execute pairs for site/page/template/module revert

## v0.2.22

### Features
- ea4c973 propose/execute pairs for create/update_permissions/delete

## v0.2.21

### Features
- 28609dc propose/execute pairs for create/set_roles/delete

## v0.2.20

### Features
- 8a9cf0b propose/execute pairs for create/update/delete/set_blocks

## v0.2.19

### Features
- b412660 widen Category C ops + first deploy propose/execute pair

## v0.2.18

### Features
- cd67933 comments drain to cms_admin archive (Fix D)

## v0.2.17

### Other
- 0b12d9c biome autofix on dispatch.ts

## v0.2.16

### Features
- afdc7ad Tier-2 DB-load on bootstrap + add_plugin_to_page AI tool + plugin-op auto-redeploy

## v0.2.15

### Features
- 898f0fe add Step 0 preferences capture so site_ai_memory is non-empty before first chat

## v0.2.14

### Fixes
- f3992ad site-defaults visibility, AI-set-defaults, /edit chat picker

## v0.2.13

### Fixes
- 7001018 force traffic to latest after upgrade roll

## v0.2.12

### Fixes
- 8a37b05 build @caelo-cms/shared in Docker so runtime resolver finds dist/

## v0.2.11

### Fixes
- 978b909 drop /_caelo/health HTTP probe in upgrade — always 403'd

## v0.2.10

### Fixes
- d984668 mirror cosign signatures to GCP AR via cosign copy

## v0.2.9

### Features
- cb4e13e offer to brew-install cosign when missing on macOS

## v0.2.8

### Fixes
- a4128be catch cosign-not-installed ENOENT throw with clean hint

## v0.2.7

### Fixes
- cbc3278 resolve image digest via public Docker V2 API in upgrade

## v0.2.6

### Fixes
- e42311d install Bun in verify-published so cms-provision --version runs

## v0.2.5

### Other
- 7b3bdc7 biome autofix on npm-publish-idempotent.ts

## v0.2.4

### Fixes
- 14040e9 idempotent npm publish wrapper absorbs npm 11.x --provenance race

## v0.2.3

_no changes since last tag_

## v0.2.2

### Fixes
- 9b050e7 publish @caelo-cms/shared + rewrite workspace deps in CI

## v0.2.1

### Features
- febb974 release-check sidecar — no network in DB transactions
- 82371d5 cosign verify in upgrade pre-flight
- a2fdb44 run DB migrations during upgrade (idempotent)
- 2a49399 two-phase upgrade with health probe + auto-rollback
- 6f78a6a in-admin upgrade notifier via notification bell
- 55e5421 versioned upgrade + status latest-release check
- b1ff6ea compose_from_import + /ramp-up wizard + dashboard hero
- f1a0984 create_template tool + UUID context + create_page templateId optional
- edfc48b drain legacy caelo_admin user before pulumi-up
- f331ca4 wire CAELO_SECRET_KEK + drop required Anthropic key
- b98baa2 /security/ai password input + clear-key + first-run redirect
- 18ef4e3 ProviderResolver + rewire 4 callsites to DB-backed keys
- 46fe0d3 encrypted at-rest API keys + clear_key + any_configured
- e53de0b AES-GCM secret-box helper + dev KEK auto-gen
- 65b29f3 wizard runs DB migrations via one-shot Cloud Run Job
- abc06e7 wizard uploads animated welcome page to static bucket
- 0b92526 caelo-cms lifecycle commands (§11.C commit 5/6)
- e5deb77 wizard DNS auto-create adapters (§11.C commit 4/6)
- aa8c80c wizard cost-estimate + Pulumi automation + IAP enable (§11.C commit 3/6)
- a2712d4 cms-provision wizard — GCP bootstrap automation (§11.C commit 2/6)
- f2cb1f5 cms-provision wizard scaffold (§11.C commit 1/6)
- ef743f8 pre-built admin + gateway images via GHCR — first §11.C deliverable
- d3200a8 docs-site/ content tree + sync script (PR 2A)
- a03b046 plugin host, gateway hardening, provisioning, multi-provider AI, OSS launch hygiene
- 9c7ef9d subagents — same chat-runner, called recursively via spawn_subagent
- 15f67c6 skills system + auto-engagement + base skills
- 8364f00 AI translation Mode 1 + Mode 2 + bulk dashboard + glossary + style guide
- e607b0e i18n foundation — locale registry, URL strategies, propose/execute gate
- 48394a0 SEO sidecar + sitemap.xml + multi-format redirects + slug-change link rewriter + fill-once/optimize AI tools
- 64abae0 five optimizations — responsive srcset+LCP preload, focal/crops, storage-plugin seam, processing status, AI alt proposals
- eef6a9b media library — upload pipeline, sharp variants, AI awareness, deploy-time asset copy, CDN-copy toggle
- b69d086 layout block editor + drag-and-drop on page editor + side-by-side iframe diff
- 8a074fd admin UX interactivity — deploy polling, Cmd-K palette, vim shortcuts, notification bell, onboarding tour
- 1344511 admin UX foundation — empty states, skeleton, inline Zod, axe-core AA gate, brand, motion-reduce
- 27ae90e content ops — duplicate, change-template, reorder/move modules, structured-sets editor
- d247852 layouts (site-wide chrome) + multi-layout + site_defaults + no-fallbacks invariant
- a464e34 pages lifecycle (name/title/slug split) + structured-data sets + redirects scaffold
- 3f4feee live-edit UX polish — page-bound chats, in-toolbar publish, markdown page context
- 0249399 add_module_to_template — site-wide module fan-out
- f759dc9 edit-mode toggle, page-aware AI, add_module_to_page tool, error surfacing
- e464da1 chrome-less live-edit, latest-snapshot picker, modifier-gated clicks
- 95e5ad4 close 7 live-edit overlay gaps surfaced in P6.7 audit
- dcd3081 live-edit overlay — flagship UX with branch-aware iframe + element-click chips
- 9ed456c admin UI follow-up — typed ChatPanel, toasts,  Select wrapper, clickable breadcrumbs, EmptyState
- 38f8c14 admin UI framework — Tailwind 4 + shadcn-svelte
- 41f2938 deploy hardening — subprocess generator, content-addressed  builds, async progress, preview/confirm publish, rollback
- 201622e Caddy hosts + staging gate + chained MVP spec
- 9f3cd0b chat-runner hardening — provider injection, abort,  idempotency, prompt-cache, partial publish
- 075fafc static generator + Publish + Ops dashboard — MVP complete
- c97ce8b chips + visual diff + fixture-replay + missing tests
- f7957da admin chat UI + SSE endpoint + filled security panels
- 6e424a1 chat + memory + provider config + ai_calls Query API ops
- 0e70876 AIProvider abstraction + tools + chat-runner
- 033c5fb AI chat schema + Zod tool surface + ctx.chatBranchId
- a66309c Advanced History drawer + per-entity history routes
- b1b5f52 snapshot Query API ops + op_kind + archival hook
- b3cc8e3 snapshot helpers + emit wiring on every P3 mutation
- 9547a10 snapshot schema (5 tables + RLS + cascade)
- cc828ec follow-up — version + soft-delete cascade + htmlparser2
- 92e05a4 content admin UI under /content
- 66c8ff6 content Query API ops + preview composer
- 564a701 content schema + Zod validators
- f9c0ad4 admin shell + session auth + Owner/Editor/Reviewer + custom roles
- f8e4e53 database + Query API foundation with RLS

### Fixes
- ca0f01b tag-prefix bug + lockstep CI gate + RELEASING.md docs
- 6d66e5d lifecycle commands resolve Pulumi-suffixed names + bump 0.1.2
- f7ca4c1 wire correct DB URLs per service
- aaa914a drain script async-IIFE wrapper + proven SQL
- 5900ca9 resolve VPC from network-interfaces annotation
- 99f1f26 drain step grants role membership + aborts on fail
- efb2492 SecretIamMember tracks Secret resource (depends-on)
- 3a81c37 create admin_role + public_role SQL users (not caelo_admin)
- 6c3ddb1 build-time bun shim re-exports globalThis.Bun (not throws)
- 83b0eea apply globalThis.Bun pattern to migrate.ts + gateway server
- 7d9182e read SQL/Glob from globalThis.Bun, drop bun stub package
- bab6b06 externalize 'bun' at the rollup layer, not just ssr.external
- f151bbd exact-tag match without gcloud filter
- 868e374 pin Cloud Run images by sha256 digest, not floating tag
- 0aba809 drop the build-time bun stub from runtime image
- 12924ec provision IAP service identity + grant run.invoker
- bdf7c83 wizard polls managed TLS cert until ACTIVE
- f857b79 add HTTP→HTTPS redirect on the LB
- ae87575 use Google-managed IAP, drop deprecated Brand+Client
- 9a0117b grant compute.admin + logging.configWriter to provisioner
- 4c3b883 IAP role on iap.web (not Cloud Run); domain verify pre-flight
- a34361d include apps/<service>/node_modules in runtime images + read PORT
- 23b4815 copy GHCR images via local docker pull/tag/push
- 271f2a1 copy GHCR images via wizard gcloud step, not Pulumi Command
- 15f0cdb copy public GHCR images into operator-owned AR
- 8f9be6b proxy ghcr.io via Artifact Registry remote repo
- 0a5b713 make captcha PoW wrong-nonce test deterministic
- 54de983 xargs-driven scan for ALL linux-x64 native bindings
- 8fd5a25 pin @rolldown/binding-linux-x64-gnu to actual version 1.0.0-rc.17
- 49135b2 hardcode native-binding list in one npm install
- fe7a950 batch all native-binding installs into one npm call
- e41d270 install ALL linux-x64 native bindings via bun.lock scan
- a062427 stub node_modules/bun + use bun x (no JIT) for vite build
- eb4e28a rm Bun's wrong-platform symlink before copying real binding
- f576de4 npm install rollup binding in /tmp, copy into apps/admin
- 950c359 use npm to patch the Rollup native binding install
- 193bd12 apt-install curl in oven/bun:1.3 builder
- 5690f0b grep the resolved rollup version, not the spec
- be44a48 build admin in Docker (oven/bun:1.3) with manual Rollup binding
- 03ea19d install rollup + native binding directly into apps/admin/node_modules
- 1ad9a77 manual Rollup native fetch + drop bun --bun from build script
- cf01e57 pre-build admin natively on the runner instead of inside Docker
- 597463c root-install Rollup native + bypass bun --bun for vite build
- 648d75e single-arch (amd64) + explicit Rollup linux-x64 binding
- 198f150 declare @caelo-cms/shared as a workspace dependency
- 3bf8694 clear remaining biome lint errors + pin Rollup native binaries for cross-arch admin builds
- ddfba93 drop --frozen-lockfile in admin Dockerfile (multi-arch Rollup binding)
- b726a3d GCP stack defaults to ghcr.io/caelo-cms images (§11.C contract)
- f002cc3 CI uses @caelo-cms/admin filter, not the pre-rename @caelo/admin
- 2b9afb6 expired-bucket conflict resets window + count atomically
- 6b718ab widen variant type to string for cropped variants
- 6e39c8e declare @caelo/admin-core as static-generator devDep for media-pass test
- e9a2784 self-seeding site_defaults migration for CI
- 933c338 use:enhance on publish forms — refresh no longer re-fires confirmPublish
- 2537c61 make Playwright smoke a real setup → login → dashboard flow
- f6ef54e exclude build artifacts from Biome includes
- b8d3e9a build under Bun + lazy DB-adapter init
- 0a08ef2 start adapter-bun output under Bun, not `vite preview`
- a29699b rename Playwright spec to *.browser.ts so `bun test` ignores it
- 59ff4b1 split CREATE DATABASE into separate psql invocations

### Refactors
- 68a7adc admin via LB BackendService + IAP, drop DomainMapping
- 854b78d images live in Caelo-team public AR; drop wizard copy
- 8e74f86 provisioning contract — CLAUDE.md §11.B + §11.C, 3-tier GCP rewrite
- 2fae5db rename @caelo/* → @caelo-cms/* (npm scope)
- 2d8007a optimization pass — live event streaming, bounded concurrency, in-loop cost cap, ephemeral session GC, subagents prompt hint
- 85dd6e0 review pass — AI-managed glossary, ai_calls integration, module snapshots in Mode 2, job revert + publish-completed, missing tests
- 5d0c2d9 optimization pass — trailing-slash align, bulk hreflang, translation_status_matrix, language-selector
- 75acba4 review pass — translation_status enum align, hreflang published filter, locale-aware output path, redirect creation on execute
- d047b40 AI-first cross-phase pass 2 — open content-curation ops, justify narrow scopes
- a89404f cross-phase AI-first audit — open list/get to AI, add modules.delete_many + media.delete_many, chat session search
- d7fbc20 AI-first review pass — bulk ops, broader filters, redirects AI surface, system-prompt block
- 386dd48 review pass — preview SEO parity, chat ?prompt= consumer, toPath regex, drop dead op_kind, collapse pages_seo.set
- e99e8ed review pass — orig EXIF strip, dedupe audit, /edit Cmd+M, duplicate-page usage delta, 5 verification tests
- e587c6c polish — version-conflict dialog, branch-edited modules, deferred-load streaming, aria-live, ? shortcut
- e79de01 closing pass — forced-colors, brand assets, Zod on 3 forms, diff guard, seed onboarded_at, Skeleton usage
- 3c57d2b review pass — duplicate filters dead modules, system-prompt guidance for 5 new tools, structured-editor form-state preservation
- 4af3723 review pass — narrow AI template scope, parser-based layout validation, owner UIs

### Docs
- 2c8c5c8 explain why Node-20 advisory persists despite force-flag
- b0cf2b5 add §11.A human-confirmation gate for hard-to-revert ops
- a44f869 replace inline §1 diagram with dedicated ARCHITECTURE.md
- 101bd82 focus the §1 diagram on content-layer wiring
- f723448 add architecture-at-a-glance diagram to §1
- 162e1c4 finalize phase plan to mirror what shipped
- aca47b6 finalize phase plan to mirror what shipped
- fe0b9ee finalize phase plan to mirror what shipped
- 9900038 mark phase complete with remote CI run reference
- 0f19592 mark phase complete with remote CI run reference

### Chores
- d7bceeb align everything to v0.2.0 + improve release script
- a2fdc7f opt all JS-based actions into Node 24 runtime now
- 6923bab trigger release-images for new GCP AR mirror
- f5f0e12 biome auto-format — collapse stepCopyImages signature + gcloud array
- 8d15ebd biome auto-fix sweep — import sort + useLiteralKeys (CI lint repair)
- 7d8b332 npm-publish-ready packaging for @caelo-cms/{mcp-server,provisioning}
- 119f952 follow-up 2 — explicit init, audit shape, rotating CSRF, Postgres rate-limit, soft delete
- 97827ba follow-up — security panel stubs, user mgmt, audit, CSRF, rate-limit, Playwright, svelte-check
- a774e92 follow-up 2 — typed tx, role verify, committed RLS SQL, parameterised set_config, reusable adversarial matrix
- ba2c58f follow-up — rollback test, RateLimiter stub, public_role coverage, CI bootstrap.sh, meta-table RLS
- 287699f hardening — secrets, project refs, license check, TS 6, bun-native test runner

### Tests
- 6fb87fb update mcp.integration.test.ts to new resolveProvider shape
- 8b21882 Playwright history-drawer flow
- 351b554 Playwright E2E + dev-owner seed + globalSetup

### Other
- 8118d2c atomicity — release.yml chains docker + npm + verify
- 3c618c8 npm publish + GitHub Release on v* tag push
- 59a8584 mark Playwright job continue-on-error pending server-side smoke fix
- 07f7113 first commit

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 releases follow the **no-fallbacks invariant** documented in `CLAUDE.md` §2 — code paths fail loudly with structured errors when expected data is missing rather than silently substituting defaults. This rule is relaxed deliberately at 1.0.0.

## [Unreleased]

### Added
- P17 PR4 — `caelo_chat` MCP server (`packages/mcp-server`). Single-tool MCP server lets Claude Code (or any MCP-aware client) drive a Caelo install from outside the browser. Owner UI at `/security/mcp` mints + revokes bearer tokens; the bridge dispatches every call into the existing chat-runner with the resolved Owner identity. Per-token AI cost cap enforced via P10.5's `costCapMicrocents` surface.
- P17 PR1 — project hygiene for OSS launch: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, this `CHANGELOG.md`, `.github/PULL_REQUEST_TEMPLATE.md`, three issue templates, SPDX-header lint wired into root `lint`, version bump to 0.1.0 across every workspace.

## [0.1.0] — first OSS release

### P0 — Repo bootstrap
Bun monorepo (`apps/admin`, `apps/static-generator`, `apps/api-gateway`, `packages/*`), TypeScript strict, Biome, Zod, Postgres via Docker Compose, GitHub Actions CI (lint + typecheck + test + license-check), `CLAUDE.md` engineering principles. Bun-native test runner.

### P1 — Database + Query API foundation
Two databases (`cms_admin`, `cms_public`) with two isolated PostgreSQL roles, RLS `FORCE`d on every table both ways, Query API → Validator → Database Adapter → Postgres chain. Undefined operations fail closed; cross-database / cross-actor / cross-plugin reads fail closed. `RateLimiter` interface plumbed through the executor. CI runs `bootstrap.sh` directly + integration tests against the production-shape `public_role`.

### P2 — Admin shell + auth + security control panel
SvelteKit + `svelte-adapter-bun` admin app. Session-based email/password login; built-in Owner / Editor / Reviewer roles + Owner-defined custom roles enforced via a fixed permission catalog. CSRF double-submit at the form layer. Login rate-limit (5 / 5 min per IP). System actor seed for pre-auth audit FK. Setup-race hardening via Postgres advisory lock. Security control panel scaffold.

### P3 — Module / Template / Page content model
Three content primitives via Query API only: `modules` (HTML+CSS+JS, live-referenced), `templates` (named blocks), `pages` (ordered list of module references — no raw HTML field, enforced at the Validator). Admin CRUD + preview composition.

### P4 — Snapshot versioning + revert
Every Query API write emits a snapshot. Chat-keyed Undo/Redo as the primary surface; per-module + per-site revert in the Advanced History drawer. Module A/B variants land as sibling `module_snapshots` tagged with `experiment_id` — no new versioning concept.

### P5 — AI provider abstraction + first AI module edit
Provider Abstraction Layer (Anthropic Claude Opus 4.7 first), token accounting, admin AI chat UI. Site-AI-memory store (Owner-curated brand voice / tone / banned phrases) prepended to every AI call. Chat sessions + ephemeral chat-branches + click-to-chat element references + visual content diff overlay.

### P6 — Static generator + local deploy (MVP complete)
Astro-based static generator reads `cms_admin` via the Query API and emits `dist/` of plain HTML/CSS/JS. Three-environment model (dev / staging / production); editors see Draft → Live, Ops users see the full pipeline. Reserves hooks for A/B variant emission consumed at the edge.

### P6.5 — Admin UI framework
Tailwind CSS 4 + shadcn-svelte. AppShell with persistent sidebar nav, breadcrumbs, top bar. Dark mode + design-token theming. shadcn primitives copied into `apps/admin/src/lib/components/ui/` — owned outright, no runtime dep.

### P6.7 — Live-edit overlay (the flagship UX)
Editor lands on `/edit` → rendered website in an iframe + floating draggable chat overlay. Click-to-chat references the actual element; chips accumulate so multi-element edits run in one AI turn. Branch-aware preview via `pages.render_preview(chatBranchId=...)`. Stage + Confirm-publish strip in the toolbar.

### P6.6 — Admin UX polish
Skeleton loaders, empty-state component upgrades, inline Zod validation on high-traffic forms, microcopy sweep, brand assets, `prefers-reduced-motion` + `forced-colors` honoured everywhere, axe-core AA gating in CI. Deploy-progress polling, drag-and-drop module reordering, side-by-side iframe diff, Cmd-K command palette, keyboard shortcuts, first-login onboarding tour, notification bell.

### P7 — Media library
Object-storage abstraction (local volume adapter for self-hosted), upload endpoint with MIME / size validation, sharp-driven optimisation pipeline (resize variants + WebP), media browser. AI references media by URL via Query API; never touches storage directly. Optional CDN copy at deploy for frequently-used assets.

### P8 — SEO + Redirects + sitemap / robots
Per-page structured SEO fields (no raw `<head>` HTML). Fill-once via `seo-autofill`; explicit cross-page `seo-optimize` for re-runs. Redirect manager + admin UI. `sitemap.xml`, `robots.txt`, provider-specific redirect file generators.

### P9 — i18n foundation + locale URL strategies
Per-locale `(slug, locale)` page rows + `content_hash` / `translated_from_hash` / `translation_status` fields. Locale config table supports per-locale URL strategy (subdirectory default, subdomain, separate domain). Admin-only — every locale-config Query API op rejects AI actors. Auto hreflang generation. Built-in language selector module.

### P10 — AI translation (Mode 1 + Mode 2) + dashboard
Block-level structured diff. Glossary + style guide. Translation dashboard with single-action "Bring up to date" per row + top-level "Auto-translate everything stale" bulk action. Mode 1 = new locale variant from source; Mode 2 = update existing translation with the structured diff. All translations land as drafts; user confirms via the standard publish flow.

### P10A — Skills system + auto-engagement + base skills
Claude-style skills in `cms_admin.skills`. Two-level activation: site-wide (Owner-required) and per-chat engagement (auto-matcher + manual override). Per-chat Engaged Skills panel, manual engage/disengage persists for chat life, pinned defaults per user. Base skills shipped: `compose-page`, `explain-page`, `brand-voice-guard`, `translation-mode-1`/`-mode-2`, `seo-autofill`, `seo-optimize`, `summarize-plugin-data`, `scoped-edit`, `import-site`, `site-memory-learner`.

### P10.5 — Subagents (AI spawns AI for parallel reasoning)
`spawn_subagent` + `spawn_subagents` AI tools. Each subagent runs its own `runChatTurn` invocation (same chat-runner, no special runtime) with parent attribution + cost cap + timeout. Depth cap of 1, read-only by default, no-publish defence by actor scope. `subagent_runs` table for observability.

### P11 — Two-tier plugin host
`@caelo-cms/plugin-sdk` + `@caelo-cms/plugin-sandbox` (oxc-parser validator + Ed25519 manifest verifier + Deno subprocess wrapper) + `@caelo-cms/plugin-host` (Tier 1 in-process loader + capability factory). Tier 1 = core plugins, signed, in-process, full SDK; Tier 2 = AI-authored / Owner-installed at runtime, Deno-sandboxed, locked SDK (only `cms_public.<slug>` schema, no AI provider, no chat-runner tool registration). Activation: Tier 1 auto on signature verify; Tier 2 Owner-click per `active` transition.

### P11.5 — Translation port + plugin-host runtime
Plugin host bootstrap + capability runtime (cms / ai / snapshots / tools / workers). Croner-backed worker scheduler. Dynamic AI-tool registry. Translation ops moved to a Tier 1 plugin (`packages/plugins/translation/`) as the SDK proof-of-concept.

### P12 — Five core Tier 1 plugins + minimal API gateway
`packages/plugins/{forms,comments,newsletter,ratings,auth}`, each ~3-4 hr of mechanical SDK work. `apps/api-gateway/` Bun HTTP server routing public POSTs to `plugins.run_operation`. New SDK handles: `ctx.query` (real cms_public dispatch), `ctx.api`, `ctx.email`, `ctx.visitor`, `ctx.captcha`. Owner UIs per plugin under `/security/plugins/<slug>`.

### P12A — Extended built-ins
Scheduled publish, component kits, typed content, edge-log analytics + A/B experiments dashboard. All Tier 1 plugins.

### P13 — Static + delta + auto-redeploy + gateway hardening + A/B edge split
Static generator bakes approved plugin data; Web Components fetch deltas via `since=<deploy-timestamp>`. Gateway: per-(plugin, op, visitor) rate limiting, CAPTCHA / PoW on public writes, honeypot fields, 10-15s debounced auto-redeploy. Stable-hash A/B edge router selects per-visitor variants and emits assignment logs into the analytics plugin.

### P14 — Pulumi self-hosted provisioning + Site Import Wizard
`bunx cms-provision --provider self-hosted` stands up Docker Compose with Postgres + pgBackRest + Caddy (Let's Encrypt) + MinIO + the CMS services. Three-environment stacks. Site Import Wizard: scrape an existing URL, draft modules + content, screenshot-diff per page, Owner reviews + publishes to staging.

### P15 — Cloud provisioning adapters (GCP, AWS, Azure)
Provider-specific Pulumi adapters: GCP (Cloud SQL HA + Cloud Storage + CDN + Cloud Run + Secret Manager), AWS (RDS Multi-AZ + S3 + CloudFront + Lambda + Secrets Manager), Azure (Azure DB + Blob + Front Door + API Management + Key Vault). Per-provider redirect file generators + edge A/B split rules.

### P16 — Multi-provider AI + cost dashboard + telemetry
Anthropic / OpenAI / Google / local-OpenAI-compat adapters behind the P5 abstraction. Operation-type budgets (text + image enforce independently). Owner-editable `ai_pricing` table — rate changes flow without redeploy via in-process LRU + `pg_notify` invalidation. `/security/costs` five-panel dashboard. Per-plugin cost cap with fail-closed enforcement after sustained lookup failures. `request_id` propagated through every audit row + AI call; `/security/audit/[requestId]` correlation view. Opt-in telemetry with payload preview before transmission.

### P16 hardening
Fail-closed cap-lookup tracking (`packages/shared/src/cap-failures.ts`), pricing LRU + invalidation, unified spend attribution view (plugin / user / subagent / system), telemetry payload preview moved off the SvelteKit form-action surface, mechanical `requestId` sweep across 150 audit callsites + lint to keep them honest.

[Unreleased]: https://github.com/caelo-cms/caelo-cms/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/caelo-cms/caelo-cms/releases/tag/v0.1.0
