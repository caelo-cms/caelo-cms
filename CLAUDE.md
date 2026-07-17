# CLAUDE.md — Engineering principles for Caelo CMS

Read this file at the start of every session in this repo. It is authoritative. Where something conflicts with `CMS_REQUIREMENTS.md`, the requirements win and this file is updated.

Every rule has a short *why* so you can make judgment calls instead of following blindly.

---

## 1A. The operator describes outcomes; the AI decides implementation

**This is the load-bearing principle for every surface in Caelo.** Internalize it before reading the rest.

The operator says *"I need a pricing page"*, *"add a footer to the blog"*, *"the homepage hero feels stale"* — never *"create a header module, then a hero module, then a CTA module"*. The AI translates intent into the right modules, layout, copy, and bindings. The operator is non-technical and does not think in modules, placements, content_instances, or sync_mode. They think in pages, sections, and outcomes.

That makes the design test for every AI-facing surface — every tool description, every system-prompt context block, every error message, every list returned to the AI: **can the AI make the right call without round-tripping back to the operator?** If the AI has to ask *"should this be the site header or a product header?"*, an implementation question has leaked through to a human who shouldn't have to hold the answer. The fix is never to teach the operator the question; the fix is always to enrich the surface so the AI doesn't need to ask.

Concretely, this means every domain object the AI might reach for ships with **decision-support context**, not just identity:

- **Modules** carry a `description` (what this module is for + when to use it) AND a `kind` (`chrome | hero | content | cta | utility`) AND a usage signal (placement count, top sample pages, last-edit timestamp). The AI sees enough to pick the right one without asking.
- **Content instances** carry a `purpose` (why this row exists as a shared instance — operator's intent or AI's inferred reason) plus the same usage signal, so the AI can decide *reuse the synced row* vs *fork to unsynced* vs *mint new* without a tool call.
- **Pages** carry a `kind` derivable from their template so a module appearing on three product pages reads as "this is a product-page pattern", not three coincidences.
- **Field names inside modules** are semantic snake_case (`hero_title`, `primary_cta_href`), authored by the AI in the same call that authors the HTML — not minted by server-side heuristics from tag names. The extractor heuristic is a fallback for messy human-authored HTML, not the canonical AI path.
- **Repeating content is a list field** (`text-list`, `link-list`, or a `module-list` of sub-modules), never numbered scalars (`label`, `label2`, `label3`, …). A menu with 10 items is one field with 10 items.

**Reviewer test for any new AI-facing surface:** an operator who has never heard the word "module" can use it. If a surface only makes sense to a developer, the AI hasn't been given enough context.

This principle is older than v0.12 but v0.12 is where it becomes load-bearing — the content_instances primitive only earns its keep if the AI can reason about *which* instance to reuse, fork, or mint without operator help. See §11 (op + tool design conventions) for the mechanical consequences.

---

## 1. Project identity

Caelo is an AI-first, open-source CMS, MPL 2.0 licensed. Key architectural anchors (see `CMS_REQUIREMENTS.md` for depth):

- **Layered permission model** (§3.1) — Module, Template, Page, Content, SEO, Redirect, Plugin, Skill, Media, i18n, Security, Deployment. Each layer constrains what AI can do.
- **Two-database split** (§12) — `cms_admin` (authoring) and `cms_public` (plugin data + visitor sessions), two isolated Postgres roles, RLS on every table.
- **Module / snapshot architecture** (§3.2, §5) — pages assemble modules by live reference; every write emits a snapshot; snapshots group by chat task; chat-keyed Undo is the primary history surface.
- **Skills system** (§17A) — Claude-style skills extend AI behaviour; auto-engaged per call; user can override per chat; new skills require human Owner site-wide activation.

**For a deep architecture overview** (system, composition, write path, data model) **see [`ARCHITECTURE.md`](./ARCHITECTURE.md).**

---

## 2. Non-negotiable invariants

These cannot be violated by any change, AI-generated or human:

- **No raw SQL anywhere.** All database access goes through the Query API → Validator → Database Adapter chain. If you need a new DB operation, add a named op; do not reach past the API.
- **RLS on every table, both DBs, `FORCE`d for owners too.** Role isolation alone is not enough — per-actor and per-plugin scoping live at the Postgres layer.
- **No raw HTML on pages.** Pages are assembled from module references only. Raw HTML belongs inside modules.
- **No raw HTML into `<head>`.** SEO is structured fields only.
- **Reserved theme-asset placeholders.** Module HTML may use `{{theme_logo_url}}`, `{{theme_logo_dark_url}}`, `{{theme_favicon_url}}`, `{{theme_social_share_url}}` to reference the active theme's bound assets — the template engine resolves these from `ComposeTheme.assets` at render time, without the module needing to declare them as fields. Operators bind via `themes.set_asset`. Unbound slots stay loud-raw (CLAUDE.md §2 no-fallbacks) — the `{{…}}` survives in output AND `theme-asset-unbound:<slot>` lands in `missingSlots` so the editor's missing-content surface flags it.
- **Two plugin tiers — never blur them.** Tier 1 plugins (`packages/plugins/<slug>/`) are core code shipped with Caelo, audited, signed, run **in-process**, and may use the full SDK (cross-`cms_admin` writes, snapshot emission, chat-runner tool registration, AI provider access, background workers). Tier 2 plugins (AI-authored or Owner-installed at runtime, source in `plugins.source_code`) run **in a Deno subprocess** with `--no-read --no-write --no-net` and may touch ONLY their own `cms_public.<slug>` schema. The SDK exports the same shape; the runtime masks capabilities by tier. A Tier 2 manifest declaring `requestedCapabilities` is rejected by the validator.
- **Tier 2 plugins never bypass the sandbox.** Deno subprocess + oxc-parser validator + schema declaration + Shadow DOM on every Web Component — disabling any one is a security regression, not an optimisation. The validator runs at activation time on Tier 2 and as defense-in-depth on Tier 1 startup.
- **AI authors Tier 2 only.** AI cannot add a new file to `packages/plugins/<slug>/`. Tier 1 source comes from human contributors auditing the change, signing the manifest, and shipping with a Caelo release. AI proposing new core capabilities means proposing a Tier 1 PR text — it does not edit core plugin source itself.
- **Tier 1 activation = signed manifest + auto-on-install.** Owner can disable from `/security/plugins` but is not asked to click Approve on first run for code shipped with Caelo. **Tier 2 activation = Owner click per `active` transition.** AI submits; human Owner flips to active. No auto-activation, ever.
- **Skill creation/updates follow the same preview → snapshot → confirm path as any other AI change.** New skills additionally require human Owner activation. Behaviour-learned skill proposals are queued, never auto-applied.
- **Skills are the official way to teach AI new behaviour.** Do not hardcode new prompt scaffolding into tool handlers; ship a skill.
- **Two levels of skill activation — never conflate them.** Site-wide activation (human Owner) promotes a skill from `awaiting_activation` to `active`. Per-chat engagement (AI auto-matcher or user manual toggle) decides which active skills augment the current AI call. User manual disengagement in a chat always overrides the matcher for that chat.
- **`admin_role` and `public_role` are isolated.** Never grant cross-database privileges. Never let the API Gateway hold `admin_role` credentials.
- **Auth plugin core logic is locked from AI regeneration.** AI can configure it (protected routes, roles, OAuth provider entries where a human-approved secret exists) — not rewrite it.
- **Locale & URL strategy config is admin-only.** Every locale-config Query API op rejects AI actors at the Validator.
- **Deployment logic is locked from AI.** AI can *request* a deploy via the fixed Deploy op; it cannot modify the generator, deploy scripts, or deploy targets.
- **Every write emits a snapshot.** Reverting a site snapshot must restore both pages and modules.
- **Missing translations = clean 404**, never a fallback. This is correct SEO behaviour.
- **Staging is always `noindex` by default.** Three environments — dev / staging / production — are a first-class part of every deployment, but editors see only Draft → Live; the third environment lives in the Ops view.
- **AI provider brand never surfaces in the editor chat UI.** Editors see "AI"; brand only appears in the Owner security panel and the cost dashboard.
- **SEO fill-once, never auto-overwrite.** AI fills SEO fields before first publish via `seo-autofill`; after first publish, content edits never silently rewrite SEO. (Re)optimization happens through the explicit `seo-optimize` skill with user-supplied context.
- **Click-to-chat chips append, never fork.** Clicking an element's "Edit in chat" affordance adds a reference chip to the *current* chat composer; it does not open a new chat.
- **Chat sessions run on ephemeral preview branches.** Changes from one chat never enter another chat's view until published; publishing merges the chat's branch into main.
- **AI-written site memory is proposal-gated.** The `site-memory-learner` never writes to `site_ai_memory` directly — every suggestion goes through the Owner review queue alongside skill proposals.
- **No fallbacks pre-1.0.** Until Caelo ships its first official version, every code path that could "default to something sensible when data is missing" must instead **fail loudly with a structured error pointing at what's missing**. Defaults are stored data (e.g. `site_defaults.default_layout_id` / `default_template_id`) that the create-time resolver consults — they are NOT silent recovery paths at read time. Hidden fallbacks during pre-1.0 mask schema drift, broken seeds, and partial migrations; we want crashes that point at the missing data, not silently-degraded renders that read "fine" but use stale or substituted state.

---

## 3. Dependency & version policy

- **Always verify the current version** of a package before adding it — do not trust training-data recall. Fetch the latest stable from the npm registry (or vendor docs via context7) and pin in `package.json`. If the requirements doc specifies a library (Bun, SvelteKit, Astro, Zod, Arctic, Pulumi, oxc-parser, Deno, svelte-adapter-bun, sharp, drizzle/atlas), use it — don't re-evaluate mid-project.
- **Project licence: MPL 2.0.** Maximum freedom for developers, hosting providers, and AI-generated modules; modifications to core files must stay open; patent protection included; one licence, no dual-licensing complexity (same licence as Firefox, Brave, LibreOffice). All dependencies must be **MPL-2.0-compatible** — MPL-2.0, Apache-2.0, MIT, BSD, ISC. GPL/AGPL/SSPL/proprietary deps are blockers and must be rejected in PR review. Record the license of every new dep in the PR description.
- **Prefer fewer, well-maintained dependencies** over clever micro-libraries. OSS contributors will audit this tree.
- **Upgrade, don't pin forever.** Dependabot/renovate on; security advisories block merges.
- **No proprietary SDKs on critical paths** — vendor-neutrality is a core goal. AI providers all sit behind the Provider Abstraction Layer.

---

## 4. Code quality

- **Refactor when the shape is wrong — no quick fixes, no TODO-for-later hacks, no commented-out code.** If the right fix is three files, do three files; if that's too big for one PR, open an issue and plan it — do not leave the codebase in an interim state. The exception is a truly temporary workaround behind an explicit `// FIXME(issue #N):` pointing to a tracked issue.
- **Root-cause bugs.** Do not paper over symptoms. If a test is flaky, fix the race; do not retry.
- **Never write off a failure as "the LLM is non-deterministic" or "the model did it wrong."** A capable model sits behind every AI surface; the routine things it is asked to do here — author valid HTML, emit a well-formed tool call, fill semantic fields, pick the right block — do not "just randomly fail." When an AI-driven action misbehaves, assume the cause is in *our* code, prompts, tool schemas, or context plumbing (a missing primer, a malformed tool description, a truncated context, a turn that ends before the tool block, a validator rejecting silently) and **find that root cause**. "Probably model flakiness" is not a diagnosis — it is the thing you say when you have not looked yet. If after genuine investigation you can show the failure is true provider nondeterminism, prove it (reproduce, vary the seed/prompt, cite the evidence) and then *still* fix it in our layer (retry-on-empty, stricter tool-choice, schema-forced output) rather than shrugging. The bar is the same as for any other bug: reproduce, explain, fix.
- **TypeScript strict.** No `any`, no `@ts-ignore` without a comment explaining why and what unblocks its removal.
- **Zod at every boundary** — HTTP requests, Query API ops, plugin SDK surfaces, AI tool-call arguments. Internal code trusts its types.
- **Small, composable modules.** If a file exceeds ~300 lines, consider splitting. If a function exceeds ~50 lines, consider extracting.
- **Errors are values where it matters.** Use `Result`-like returns at the Query API boundary; throw for genuinely exceptional cases.

---

## 5. Readability & comments (this is open source)

- **Name things well first.** A well-named identifier removes the need for a comment.
- **Write comments that explain *why*, not *what*.** If a reader can get the *what* from the code, the comment is noise. Good comment: *"Snapshots use live module refs (not pinned versions) because revert must apply atomically across the site — see requirements 3.3."* Bad comment: *"Loop over modules."*
- **Every exported function, type, and module has a short TSDoc block** — one or two sentences of *purpose* + at least one parameter or return note when non-obvious. This is for contributors reading in their IDE.
- **Complex invariants get a block comment** at the top of the file or function. If a reviewer would ask "why is this like this?", the answer lives in code, not PR history.
- **Examples in docs for public-facing APIs** — Plugin SDK, Query API, provisioning CLI. Each should have a runnable example.
- **No dead code.** Delete it; git remembers.
- **No emojis in code or docs** unless a user-facing string genuinely warrants one.
- **SPDX header on every source file:** `// SPDX-License-Identifier: MPL-2.0`.

---

## 6. Testing

- **End-to-end verification per phase is mandatory** (see the verification table in `plans/MASTER_PLAN.md`).
- **Three-tier test strategy, enforced per phase** — see the Testing Strategy Matrix in the master plan. Every phase declares (a) unit tests covering its pure logic and Zod schemas, (b) integration tests covering its Query API ops / Validator rules / Adapter behaviour against a real Postgres, (c) Playwright E2E flows covering its user-visible behaviour.
- **Coverage gates in CI:** unit ≥ 90%, integration ≥ 80% of declared Query API ops, E2E: every verification-table row has a Playwright script that encodes it and CI fails if any are missing.
- **Every bug fix lands with a regression test** that would have caught it — same tier as the bug (unit/integration/E2E).
- **Tests run under `bun test`** — Bun's native test runner. Import `describe` / `it` / `expect` / etc. from `bun:test`. Do not add Vitest (or Jest) back — we deliberately standardised on Bun to cut the dep tree and match contributor instinct. Coverage: `bun test --coverage`.
- **No mocked PostgreSQL for Query API tests** — run against a real Postgres in the compose stack. Mocks diverge from prod; we've committed to two real databases, tests exercise both.
- **Playwright runs against the real compose stack**, not a dev server in isolation. Every phase adding a screen adds a Playwright flow.
- **Real-AI Playwright suite (issue #47):** `apps/admin/e2e-livedit/` drives the chat through the live Anthropic API to catch the regression classes the mock-AI suite cannot (v0.10.17 empty response, v0.10.19 orphan locks, v0.10.20 schema drift, v0.10.21 missing primers). See [`docs/internal/e2e-livedit.md`](./docs/internal/e2e-livedit.md) for local setup, the assertion-class → regression-class table, the add-a-scenario template, and the 10× determinism recipe.
- **Plugin sandbox tests include adversarial cases** — attempts to escape the sandbox must be in the test suite and must fail.
- **Skill behaviour tests:** each base skill has a fixture-driven integration test verifying the skill's output shape (tool calls made, fields populated) against a recorded AI response; also a live test (gated, opt-in, not in PR CI) against the real provider.

---

## 6A. UI components (Tailwind 4 + shadcn-svelte)

Landed in P6.5. Conventions any session touching admin UI should follow:

- **Components live in `apps/admin/src/lib/components/ui/`** — owned by this repo (the shadcn-svelte CLI generates them; we then maintain them). Adding a new one: `bunx shadcn-svelte@latest add <name>`. Do not edit generated files to fork them; treat each as a checkpointed copy that can be regenerated.
- **All styling is Tailwind utilities** + the per-component variants emitted by the shadcn CLI. Do not write new `<style>` blocks unless absolutely necessary (a one-off CSS-only animation is fine; a per-route stylesheet is not).
- **`cn()` for any class string that mixes a base + a variant** (`$lib/utils.js`). Pure-static class strings can stay as plain template literals — the rule is "if a conditional or a variant is involved, route through `cn()`".
- **`buttonVariants()` for link-as-button** elements (`<a class={buttonVariants({ variant, size })}>`). Don't hand-roll button styling on `<a>` tags — when the button design evolves, every styled link follows automatically.
- **Native `<select>`** via the `Select` wrapper at `lib/components/ui/select/`. The bits-ui `Combobox` is the right primitive for searchable / virtualised pickers (P6.7's page picker uses it); a plain `<select>` keeps form-submission semantics simple for the routine case.
- **Variant exports live in sibling `.ts` files** (e.g. `button-variants.ts`), not in a `<script module>` block — TS doesn't surface named exports from `.svelte` modules to the type system reliably yet.
- **Empty states use `<EmptyStatePlaceholder>`** at `lib/components/`. P6.6 polishes the inner shape (illustrations, primary CTAs); the hook stays.
- **Toasts via `svelte-sonner`** through `lib/components/ui/sonner`. Mounted once in the root layout. Form actions pair with `use:enhance` — a single layout-level `$effect` watches `$page.form` and fires `toast.success(...)` / `toast.error(...)`. Don't sprinkle toast calls inside route components.

---

## 7. Security posture

- **Secrets never in code or `.env` files committed to git.** Always via the provider-appropriate secrets manager, even in dev (use a local Vault/Doppler/MinIO-hosted fake).
- **Input validation before the Query API, not inside it.** The Validator enforces shape; handlers trust their inputs.
- **Public writes require CAPTCHA/PoW, rate limits, and honeypots.** No exceptions — AI-authored plugin endpoints must honour this.
- **All AI actions and DB ops pass through the audit log.** Logging is not optional; a code path that skips it is a bug.
- **Dependency review on every PR.** New deps justified in the PR description. Enforced mechanically by CodeQL static analysis (merge-blocking), the dependency-review workflow (high-severity vulns + license allow-list), and repo secret scanning + push protection — see [`docs/dev/codeql.md`](./docs/dev/codeql.md).

---

## 8. AI-generated code standards

This project is largely AI-authored. AI contributions are held to a *higher*, not lower, bar because they will be reviewed asynchronously by OSS contributors.

- **No half-finished implementations.** If a change introduces a function, it is tested and wired up.
- **Match the permission layer** — a change to the Page Layer cannot add raw HTML; a Plugin Layer change cannot reach the DB directly.
- **Prefer existing modules/utilities** — grep the repo before creating new primitives.
- **Preview diffs must be minimal.** Unrelated formatting churn blocks review.
- **Every PR runs through an automated AI security review** (`.github/workflows/security-review.yml`). It posts inline + summary review comments and cites the rule it's checking against. See *CONTRIBUTING.md → "AI security review"* for the skip rules, the `skip-ai-review` label, and where to find the raw findings artifact when a comment doesn't render.

---

## 9. Commits, PRs, and reviews

- **Conventional commits** (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`). Each commit is self-contained and passes CI.
- **PR description** always includes: *what changed*, *why*, *which requirements section this satisfies*, *how it was verified*, *licenses of any new dependencies*. The end-to-end verification from the phase file goes here.
- **No `--no-verify`, no force-push to `main`, no squashing away useful history.**
- **Reviewers check:** permission layer respected, Query API only, snapshots emitted, validation present, tests added, docs updated.

---

## 10. Documentation as you go

Every phase updates `docs/` when it introduces user-visible behaviour. Caelo's docs site is built *with Caelo itself* (dogfooding from P17) — broken docs block the release.

---

## 11. AI-first op + tool design

Caelo is AI-first not just in branding — **the AI agent is the primary user of the admin surface**. Most editors interact with Caelo by chatting; humans only fall back to the panel UI for permission-restricted Owner tasks (security, deploy, plugin activation) or when something has clearly broken. Op + tool design must reflect that:

- **Default `actorScope` is `["human", "ai", "system"]`.** Narrower scopes need a `// Why human-only:` justification at the op definition. Examples that legitimately stay narrower:
  - Auth + role mutations (humans only by definition).
  - Plugin activation, layout creation, site_defaults writes (Owner gate per requirements).
  - Locale + URL strategy config (admin-only per §17.4 of CMS_REQUIREMENTS).
  - System-only utilities like `pages.rewrite_module_links` that the AI calls indirectly through a parent tool — these don't add a separate AI tool.
- **Every routine domain ships a bulk variant alongside the singular form.** `redirects.create_many`, `pages_seo.set_many`, `media.delete_many`. The AI plans a multi-row change and posts it in one tool call; saves token cycles + tool-call rounds + a wall of `tool-call → tool-result` events in chat. The bulk handler validates + writes inside one transaction so partial-failure is impossible.
- **Read surfaces are powerful.** Every domain has a list op with filter + free-text search + sort. AI calls `redirects.list({ matches: '/old/*' })` to find what to update without paginating through everything. List ops should be open to all actor kinds (`["human", "ai", "system"]`) — the AI needs broad read to plan good writes.
- **AI tool descriptions optimise for the AI, not for human reviewers.** Each tool's `description` field carries: when to use, when NOT to use (which other tool wins), and the typical input shape. Bulk variants explicitly tell the AI to prefer them: *"Prefer `redirects.create_many` over multiple `redirects.create` calls when the user asks for >1 redirect."*
- **System-prompt context blocks save tool calls.** The chat-runner's `## Pages`, `## Media`, `## Layouts` etc. blocks let the AI plan without a `*.list` round-trip. New domains should ship a corresponding context block when the data fits in <2 KB. Stale-state risk is fine; the AI can re-list when its plan turns out wrong.
- **Bulk doesn't mean "1 + bulk".** Don't ship the singular op then bolt on a bulk variant a phase later. Singular is a special-case-of-bulk for n=1; just ship `set_many` with a 1-element array as the smallest case if the singular variant doesn't carry distinct semantics.
- **Cross-page / cross-domain patches that span >1 op call belong inside one op.** When you find yourself documenting "AI: call X, then Y, then Z in this order" — that's three round-trips of latency + token spend. Wrap it in a single op whose handler runs the chain in one tx (e.g., `change_page_slug` already does this — it does the slug update + redirect insert + structured-set rewrite + module-body rewrite in one boundary).
- **Failure surfaces are AI-actionable.** Errors include the *next step the AI should try* in the message body — not just "validation failed." Example: `pages_seo.autofill`'s `AlreadyAutofilled` error suggests using `pages_seo.optimize` instead.

When an audit finds an op that's "AI could call this but doesn't have a tool" or "AI would need 5 round-trips to do what one bulk call could", that's a review-pass item, not a future-phase polish item.

### 11.A. Human-confirmation gate (for hard-to-revert ops)

§11 says "default actorScope is `human + ai + system`" and "the AI is the primary user." Most writes follow that and are immediately applied. But a small set of ops are **hard or impossible to revert cleanly** — adding/deleting a locale fans out URL changes across the entire site, deleting a layout cascades through every page on every template that binds to it, activating a plugin runs untrusted code. Those don't go human-only. **They go AI-proposable + human-approve-by-click.**

> **Implementation reference:** see [`docs/propose-execute-pattern.md`](./docs/propose-execute-pattern.md) for the per-domain table shape, op shape, cross-cutting infrastructure (cross-domain inbox, GC worker, dedup, chat origin), three credential-handling sub-patterns, and a step-by-step "how to add a new gated domain" checklist.

The pattern, used uniformly across every gated domain:

1. **AI calls `<domain>.propose_<action>`** with the full inputs. The handler writes a row to a per-domain `<domain>_pending_actions` table with `status='pending'`, computes a `preview` jsonb (blast-radius summary — affected page count, redirects to be created, etc.), records audit, returns `{proposalId, preview}`. AI scope is `human + ai + system`.
2. **AI tells the user**: *"I prepared a proposal to add German. Click Approve at /security/locales/pending to apply."* The proposal renders in a small Owner queue with the AI-supplied payload + the computed preview + Approve / Reject / Edit-before-approving buttons.
3. **The Approve action calls `<domain>.execute_proposal({ proposalId })`** which is `human + system` only. Handler reads the row, runs the real op inside one tx, marks the row `status='applied'`. The Reject path stamps `status='rejected'` + the actor + an optional reason.
4. **The AI cannot bypass step 2.** No "auto-approve after 60 seconds." No "skip if the user said yes once before." Each instance gets its own click. The Owner panel shows the diff and the preview side-by-side.

**What's hard-to-revert?** A working list (extend per-phase as the surface grows):

| Domain | Op family | Why a click is required |
|---|---|---|
| locales | create, delete, set_default, update_strategy | URL-strategy change cascades; redirects required for every existing page in the affected locale. |
| layouts | create, delete | Site-wide chrome change; affects every bound template's pages. |
| plugins | activate | Per CMS_REQUIREMENTS §17.4 — already required; restated here for the unified pattern. |
| site_defaults | set_seo (when site_base_url changes) | Base URL change rewrites every canonical at next deploy. NOTE: `site_defaults.set` (default layout/template) is deliberately NOT gated — it's AI-writable because existing content is unaffected, the change is snapshot-revertable, and first-run UX requires it. The justification lives at the op. |
| snapshots | revert_site | Atomic site-wide rewind; one click rewinds hours of editor work. (Only `revert_site`. The granular `revert_page` / `revert_module` / `revert_template` are gated today too — whether they need to be is open: each is undoable by another revert, which by the test below argues routine.) |
| redirects | delete_many with `matches` substring matching ≥10 rows | Hard to predict the blast radius of a regex-style match; every deleted 301 strands an inbound link. Implemented as an AI-actor cap at the op (`AI_MATCHES_DELETE_LIMIT`), not a propose/execute pair: the AI is told to enumerate via `find_redirects` and delete by explicit `redirectIds`, which makes the blast radius visible instead of guessed. A human running the same call is unaffected — they ARE the decision the gate exists to obtain. |
| deploy | promote, rollback | Production-affecting. DOES get the propose/execute split (`propose_deploy_promote` / `propose_deploy_rollback` → `deploy.execute_proposal`). An earlier revision of this table said deploy was human-only with no split; the split shipped deliberately (commit b4126607) so the AI can draft the promote and the Owner just clicks. |

Routine ops — content edits, structured-sets writes, single-redirect tweaks, page slug changes, SEO field updates, media writes, alt proposals, role-list reads — stay `human + ai + system` *without* the gate. The AI proceeds on the routine 95% and asks for one click on the dangerous 5%.

**Why a button-click instead of a separate scope?** Excluding the AI from `locales.create` forces a human round-trip every time. The button-gate lets the AI:
- draft the locale row + display name + URL strategy with sensible defaults,
- compute the URL fan-out preview ("creating `de` will require 14 redirect rows for existing pages once they're translated"),
- queue the proposal,
- and the human just clicks **Approve**. Same human-in-the-loop guarantee, ten times less friction than the AI-emails-the-Owner-for-approval pattern.

Failure surface: when the AI tries `<domain>.execute_proposal` directly, it gets `ActorScopeRejected` with a message that points at the proposal flow. The AI tools' `description` field carries the two-step contract verbatim so the model says "I prepared this — click Approve" instead of claiming success: *"This is a TWO-STEP flow: (1) you propose, (2) the Owner clicks Approve at `/security/<domain>/pending`. Do not claim the action was applied."*

**System-prompt support.** The `## <Domain>` block adds an "**Your pending proposals**" sub-section, filtered to the AI's own pending rows, so the AI doesn't re-propose what's already in the queue. Renders only when at least one pending row exists.

**When to add a new gated op vs. a routine op:** ask "if the AI got this wrong, can the user undo it with one tool call?" If yes, ship it routine. If no — if the recovery is "redeploy", "manually create 20 redirects", "restore from a snapshot", "DNS-propagate a fix" — ship it gated.

---

## 11.B. Deployment architecture per provider

Every cloud provider adapter (`packages/provisioning/stacks/<provider>/`) implements the **same three-tier shape** so security + cost + scaling behaviour is identical regardless of where Caelo runs. A new adapter that diverges from this shape needs an explicit comment justifying *why* and gets extra reviewer scrutiny.

The three tiers + their primitives:

### Tier 1 — Static site (public, edge-cached)

The static-generator emits files. Serve them as files. No compute on the request path.

- **Primitive:** managed object storage + edge CDN + managed TLS cert.
  - GCP: `BackendBucket` over GCS + Cloud CDN, `ManagedSslCertificate`.
  - AWS: S3 + CloudFront + ACM.
  - Azure: Blob Storage + Front Door + managed cert.
  - Self-hosted: Caddy serving from disk + auto-Let's Encrypt.
- **Public:** yes (read-only, served by the CDN — origin is private).
- **Cost:** flat ~$18/mo (LB + cert) + GB-egress at ~$0.02/GB.
- **Why not Cloud Run / App Service for static:** compute on every request, cold starts, no edge cache, costs ~10× more for the same traffic.

### Tier 2 — Admin app (private, IAP-gated)

The admin app must **never be reachable from the public internet without authenticating against the cloud provider's identity layer FIRST**. Caelo's own session-cookie auth is the *second* line; the cloud-native identity gate is the first.

- **Primitive:** managed serverless container behind cloud-native identity proxy, with operator allowlist.
  - GCP: Cloud Run + Identity-Aware Proxy (IAP), allowlist via `iap.httpsResourceAccessor` IAM binding.
  - AWS: Lambda / Fargate behind ALB + Cognito user pool, allowlist via Cognito group.
  - Azure: Container Apps + Easy Auth (App Service Authentication), allowlist via Microsoft Entra ID group.
  - Self-hosted: Caddy with `forward_auth` to Authelia / Authentik (operator picks; documented per-install).
- **Public:** no — the identity proxy returns 403 for unauthenticated/unallowlisted requests before the admin container ever sees the request. Defense in depth: even if the admin app has an unpatched 0day, attackers can't reach it.
- **Allowlist defaults to single Owner; configurable** as a comma-list of emails / cloud-IDP groups.
- **Cost:** ~$0/mo idle (scale-to-zero); ~$2-15/mo with light editorial use depending on `adminMinInstances`.
- **Why not "just rely on Caelo's session cookie":** when (not if) a 0day lands in the admin's request path, the identity proxy IS the only thing between the attacker and the database. CMS spec calls this out implicitly via §17.4 ("admin-only" surfaces); §11.B makes the GCP/AWS/Azure mechanism explicit.

### Tier 3 — API gateway (public visitor writes, WAF-gated)

The gateway accepts public POSTs (form submissions, comments, ratings, newsletter signups, MCP `caelo_chat` calls). It is the only piece that handles untrusted traffic.

- **Primitive:** managed serverless container behind a cloud-native WAF (rate limiting + OWASP rule pack + bot detection), routed via the Tier-1 LB's URL map (`/api/*` path prefix → gateway backend).
  - GCP: Cloud Run + Cloud Armor SecurityPolicy attached to the gateway BackendService.
  - AWS: Lambda / Fargate behind the ALB + AWS WAF.
  - Azure: Container Apps behind the Front Door + Front Door WAF.
  - Self-hosted: Caddy with `rate_limit` + `crowdsec` middleware (P13 ships the equivalents in-process).
- **Public:** yes, but every request hits rate limit + WAF before the gateway runs.
- **Cost:** ~$0 idle, ~$3-5/mo light traffic. WAF basic rules free; ML-based bot mitigation +$5/mo (`cloudArmorAdaptive` knob).
- **Same LB as Tier 1** — the LB cost is already paid for the static path; adding the API path-prefix route is free.

### Tier 4 — Database (private VPC IP only)

Postgres MUST live on a private network IP that the public internet cannot reach. Cloud Run / Lambda / Container Apps connect via the cloud's serverless-VPC connector.

- **Primitive:** managed Postgres on private IP only.
  - GCP: Cloud SQL Postgres + private services connection (VPC peering).
  - AWS: RDS Postgres in a private subnet, Lambda VPC config to access.
  - Azure: Azure DB for PostgreSQL flexible-server with private endpoint.
  - Self-hosted: Postgres in Docker, only reachable on the compose network (no host port published).
- **Public:** no, ever. A managed Postgres with a public endpoint is a documented misconfiguration; provisioner refuses.
- **HA defaults to OFF** for new installs (`cloudSqlHa: false`). Operators flip to `true` for production traffic. Cost delta: HA roughly doubles the SQL line item.

### Tier 5 — Background workers

Background workers (translation, redeploy orchestrator, runner) **share the admin's Cloud Run / Lambda** — they're already long-running async loops inside the admin process. Spinning up separate compute for them adds idle cost without adding capability.

- Don't provision separate `orchestrator` / `runner` Cloud Run services.
- The admin's `apps/admin/src/hooks.server.ts` bootstraps these inline (`bootstrapTranslationWorker`, `bootstrapRedeploy`, `bootstrapMcpBridge`, `bootstrapPlugins`).

### Cross-cutting standards

| Standard | Applies to | Notes |
|---|---|---|
| **Scale-to-zero default** | Tier 2, Tier 3 | `min_instances: 0`. Operators bump to `1` to eliminate cold starts. |
| **Single LB / Front Door / ALB** | Tier 1, Tier 3 | One TLS cert, one IP, one URL map covering both. Don't provision separate LBs per tier. |
| **Secrets in cloud-native secret manager** | All tiers | Never env-var literal. Cloud Run reads via `secret_environment_variables` mounts; equivalents on AWS/Azure. |
| **Logs to a single sink** | All tiers | Cloud Logging / CloudWatch / Log Analytics. The analytics plugin queries the sink for edge-event analytics; one sink keeps that query simple. |
| **DNS records output, not provisioned by default** | Tier 1 | Stack outputs the records to create at the operator's registrar. Cloud-DNS-managed mode is opt-in (`useCloudDns: true`) for operators who want the registrar to delegate the zone. |

### The 8 config knobs every adapter exposes

| Key | Default | Operator-tunable to | Cost delta |
|---|---|---|---|
| `cloudSqlHa` | `false` | `true` | +~$20/mo (HA failover) |
| `cloudSqlTier` | `db-f1-micro` | larger tiers | +$10-30/mo per step |
| `adminMinInstances` | `0` | `1` (or higher) | +$15/mo per instance |
| `gatewayMinInstances` | `0` | `1` (or higher) | +$15/mo per instance |
| `iapAllowlist` | `[<owner-email>]` | comma-list of emails / IDP groups | $0 |
| `wafAdaptiveProtection` | `false` | `true` | +$5/mo (ML-based bot mitigation) |
| `staticCdnRegion` | `global` | `eu-only` / `us-only` / etc. | $0 (routing scope) |
| `backupRetentionDays` | `7` | up to `90` | +$5-15/mo |

Adapters MUST surface every knob via `pulumi config set caelo-<provider>:<key> <value>`. The names are identical across providers so operators can switch providers without re-learning config; the defaults match the "minimal-viable, scale-up later" goal.

---

## 11.C. Provisioning UX — the "one command" contract

Caelo's provisioner is the user's first impression of the project. Every architecture decision in §11.B is a means to one end: **`bunx @caelo-cms/provisioning --provider <name>` brings up a complete, working install with a single command, end-to-end, in under 20 minutes, on the user's own cloud account.**

This is the load-bearing UX commitment. Every contributor PR that touches provisioning is reviewed against it.

### Non-negotiables

- **Pre-built container images on a public registry.** Users do not build images. Caelo's CI publishes signed multi-arch images to `ghcr.io/caelo-cms/<service>:<version>` on every release tag; the CLI pulls them. A PR that requires the user to run `docker build` is a regression.
- **No manual `gcloud` / `aws` / `az` blocks in user-facing docs.** The CLI runs all bootstrap commands. If a step needs the user's interactive auth (e.g. `gcloud auth login`), the CLI detects state + prompts inline. If a step needs to run as the user's identity rather than a service account (project create, billing link), the CLI shells out, capturing output and handling errors.
- **No long-lived service-account keys downloaded to disk on user machines.** GCP: Workload Identity Federation. AWS: IAM Roles for Service Accounts (IRSA) when on EKS, otherwise short-lived OIDC tokens. Azure: Federated Identity Credentials. Long-lived keys land only on operator-controlled CI runners, never on a contributor laptop.
- **No raw Pulumi exposure to end users.** The CLI wraps `pulumi init / config / up / refresh / destroy`. Operators never set `PULUMI_CONFIG_PASSPHRASE_FILE` themselves; the CLI generates + persists the passphrase under `~/.caelo-<install-id>/`.
- **DNS records land automatically when the registrar API is supported** (Cloudflare, Route53, Azure DNS, GCP Cloud Domains). Otherwise the CLI prints the records, polls DNS, and continues only when resolution succeeds.
- **Cost estimate shown before any billable resource is created.** The CLI prints a per-resource cost table, gets a single y/N confirmation, then proceeds. Surprise bills are a launch-killer.
- **Idempotent re-runs.** If the user Ctrl-Cs, runs the command again, or hits a transient failure, the next invocation picks up where it left off. Pulumi state handles infra; the CLI persists progress markers (`~/.caelo-<install-id>/progress.json`).
- **Every install gets a `caelo-cms` CLI binary with first-class lifecycle commands**: `upgrade`, `backup`, `restore`, `rotate-secret`, `status`, `destroy`. These are the operations operators do regularly; they shouldn't drop into provider tools for any of them.

### The CLI's one-screen wizard

The wizard runs in any terminal, requires zero prior knowledge of the cloud provider, and succeeds even when the user makes mistakes:

1. **Auto-detect** — gcloud / aws / az auth state, billing accounts, regions, organizations
2. **Prompt** — domain, owner email, Anthropic API key (input-hidden); detect-then-confirm everything else
3. **Bootstrap** — project create, billing link, APIs enable, SA + IAM, Workload Identity Federation
4. **Plan** — print the cost table + the resource list, get the y/N
5. **Provision** — `pulumi up` wrapped in a friendly progress UI; surface errors inline with suggested fixes
6. **DNS** — auto-create records via registrar API OR print + wait-poll
7. **Cert + IAP enable** — wait for managed cert, run the post-up `gcloud run services update --iap`, verify
8. **Owner setup URL** — open the bootstrap URL in the user's browser via `open`/`xdg-open`
9. **Final state** — print summary (URLs, lifecycle commands, secrets-file location, monthly cost reminder)

### What a contributor MUST do for any provisioning-related change

- **Test on a fresh install.** No GCP project exists; no `gcloud` config set. Run the CLI from scratch. If it fails or asks the user to do something manual, the PR is rejected.
- **Update all 4 provider adapters when changing shared shape.** Adding a new knob to GCP without adding it to AWS + Azure + self-hosted is a regression — operators expect provider-portable behaviour.
- **Add cost estimate entries** for any new billable resource. The CLI's pre-flight table must reflect reality.
- **Add a troubleshooting entry** for any failure mode hit during dogfooding. The docs site's `install/<provider>` page surfaces the entries.

### Distinguishing dogfood deploys from end-user deploys

When provisioning the official Caelo docs site (`caelo-cms.com`), the maintainer follows the SAME end-user flow — no shortcut, no internal tooling. A dogfood deploy that diverges from the public flow is a missed opportunity to find the rough edges.

If the maintainer hits a manual step the CLI doesn't handle, the FIRST commit of the dogfood session is "the CLI now handles X automatically", not "I'll work around X this time". The dogfood loop's only purpose is to harden the CLI.

---

## 12. The AI provider SDK is the boundary — use its shapes, don't reinvent

We reach every model through the **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic|openai|google`). That is a deliberate choice: it is our model-swap layer (Anthropic today, OpenAI/Gemini/local behind the same `AIProvider`). The load-bearing rule that follows from that choice:

**If the SDK has a shape for something, use the SDK's shape. Do not invent a parallel format on top of it.** The moment we hand-roll what the SDK already gives us — message history, tool pairing, structured output, reasoning signatures — we take on the SDK dependency *and* the burden of keeping our parallel format correct, and we get neither the SDK's correctness guarantees nor a clean seam to swap models. This is not hypothetical: reconstructing conversation history from `streamText`'s `fullStream` instead of the SDK's `response.messages` is exactly what produced the run-B6 tool-search 400 (a `server_tool_use` block replayed without its paired `tool_search_tool_result`). The SDK pairs those blocks for us; we dropped that and rebuilt it wrong.

**The two-lane mental model.** The SDK gives every turn two outputs, and their roles must not be blurred:
- **`fullStream`** — a *live event stream* for rendering (text/reasoning deltas, tool-call announcements → SSE to the client). Display only.
- **`response.messages` / `responseMessages`** — the *canonical conversation history* the SDK assembles, with provider-executed tool blocks, reasoning + signatures, and tool pairing already correct. This is what you persist and pass back on the next call.

### SDK surface → our current status (audit, 2026-07)

The table is the reference for "where do we still diverge, and is that deliberate?" A `gap` is drift to close over time; `by design` is a divergence we keep on purpose (with the reason).

| SDK surface | Idiomatic SDK use | Our status |
|---|---|---|
| Text gen (`generateText` / `streamText`) | call it, read the stream | ✅ we call `streamText` |
| **Conversation history** | persist + replay `response.messages` | ❌ **gap** — we rebuild history from `fullStream` in our own `ChatMessageInput` format (root of the tool-search replay bug; the responseMessages work closes this) |
| **Provider-executed tools** (tool search, web search/fetch, code exec) | the SDK pairs `server_tool_use` + its result in `response.messages` | ❌ **gap** — folded into the history gap above; we currently drop server-tool blocks rather than replay them |
| **Reasoning / thinking** | reasoning parts + signatures ride in `response.messages` | ⚠️ **gap** — we hand-manage `thinkingBlocks` + `providerOptions.anthropic.signature` manually; closes with the history work |
| **Structured output** | `Output.object({ schema })` on generate/stream (v7; `generateObject` is deprecated) | ⚠️ **gap** — we force a `submit_*` tool and read its args (moduleize, subagent `submit_result`) instead of `Output.object()` |
| Tool *definition* / dispatch loop | `tool({ inputSchema, execute })` + the SDK's tool loop | ✅ **by design** — we pass tool schemas but NO `execute`; the chat-runner owns the loop so snapshot emission, audit, cost cap, and subagent spawning happen between calls. Keep. |
| **Tool approval** (human-in-the-loop) | `toolApproval` / `needsApproval` (v7) | ⚠️ **by design, but check** — our propose/execute gate (§11.A) + the W5 `needsApproval` dispatch gate are a parallel system, because we own the loop and the approval is DB-backed (proposal queue). Reasonable; revisit if the SDK's approach ever covers the queue. |
| **Image generation** | `experimental_generateImage` / provider image tools | ❌ **gap** — `image-provider.ts` calls OpenAI/Google image endpoints by raw `fetch`; migrate onto the SDK image API |
| Embeddings (`embed` / `embedMany`) | SDK embed functions | — not used yet (tool-search-with-embeddings is a possible future) |
| MCP | SDK MCP *client* (`experimental_createMCPClient`) | ✅ **by design** — we are the MCP *server* (`caleo_chat`) + a plugin host; we don't consume MCP as a client. Different direction, not drift. |
| Agent loop | `Agent` / `ToolLoopAgent` + `stopWhen` | ✅ **by design** — same reason as the tool loop: we need control the Agent class doesn't give us (branch scope, cost cap, subagent depth). Keep our chat-runner loop. |

### The rule for new work

- Before building anything that touches provider I/O — a new content type in history, a new structured-output call, a new provider capability — **check this table and the SDK docs first.** If the SDK has the shape, use it. If we already drifted there, prefer closing the gap over extending the parallel path.
- When a gap is genuinely load-bearing to close (the history/`responseMessages` one is), it gets its own focused change with a persistence migration, not a patch onto the hand-rolled format.
- A `by design` divergence needs a one-line reason at the code site (like the "no `execute` — the chat-runner owns the loop" note). If you can't write the reason, it's drift, not design.

---

## 13. When in doubt

- Read the relevant section of `CMS_REQUIREMENTS.md` first — most architectural questions have already been decided.
- Then consult `plans/MASTER_PLAN.md` and the relevant `plans/phases/phase_<N>_*.md` for execution specifics.
- If a spec is genuinely ambiguous, open an issue rather than guessing. Do not silently re-interpret.
