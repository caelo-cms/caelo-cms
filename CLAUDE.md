# CLAUDE.md — Engineering principles for Caelo CMS

Read this file at the start of every session in this repo. It is authoritative. Where something conflicts with `CMS_REQUIREMENTS.md`, the requirements win and this file is updated.

Every rule has a short *why* so you can make judgment calls instead of following blindly.

---

## 1. Project identity

Caelo is an AI-first, open-source CMS, MPL 2.0 licensed. Key architectural anchors (see `CMS_REQUIREMENTS.md` for depth):

- **Layered permission model** (§3.1) — Module, Template, Page, Content, SEO, Redirect, Plugin, Skill, Media, i18n, Security, Deployment. Each layer constrains what AI can do.
- **Two-database split** (§12) — `cms_admin` (authoring) and `cms_public` (plugin data + visitor sessions), two isolated Postgres roles, RLS on every table.
- **Module / snapshot architecture** (§3.2, §5) — pages assemble modules by live reference; every write emits a snapshot; snapshots group by chat task; chat-keyed Undo is the primary history surface.
- **Skills system** (§17A) — Claude-style skills extend AI behaviour; auto-engaged per call; user can override per chat; new skills require human Owner site-wide activation.

### Content layer wiring — how a page becomes HTML

The content layer has four primitives — **layout, template, page, module** — plus a sideband of **structured sets** for typed lists. They wire together top-down: a layout owns site-wide chrome, a template defines a page-type's blocks, a page binds to one template and references modules into the template's blocks, modules are the content units. Composition is two-pass: template fills first, then the layout wraps it.

```
                         LAYOUT  (site-wide chrome)
                         ───────────────────────────────────────
                         html with named <caelo-slot> elements
                         e.g. <header><caelo-slot name="header"/>
                              <main><caelo-slot name="content"/>
                              <footer><caelo-slot name="footer"/>
                         layout_blocks: header, content, footer
                          ▲                            │
                          │                            │ fills its non-content
              templates.layout_id                      │ blocks (header / footer)
                          │                            │ from
                          │                            ▼
                         TEMPLATE  (page-type structure)             ┌──────────┐
                         ───────────────────────────────────────     │  layout_ │
                         html, fills the layout's `content` slot     │  modules │
                         template_blocks: hero, body, sidebar, …     │  rows    │
                          ▲                            ▲             └──────────┘
                          │                            │                  │
              pages.template_id                        │                  │ each row:
                          │                            │                  │ (layout, block,
                          │                            │ fills its         │  position) → module
                          ▼                            │ blocks from       ▼
                         PAGE  (the URL surface)                    ┌──────────┐
                         ───────────────────────────────────────    │  MODULE  │
                         slug, locale, title, status                │ html+css │
                         pages.template_id, pages.layout_id (via)   │  +js     │
                         live-references modules through            │ (live    │
                          │                            ▲            │  refs)   │
                          │                            │            └──────────┘
                          ▼                            │                  ▲
                         page_modules rows ────────────┘                  │
                         (page, block, position) → module ────────────────┘
                                                       reused across pages

         ┌───────────────────── COMPOSER (two-pass) ──────────────────────┐
         │  packages/shared/preview-compose.ts                             │
         │                                                                 │
         │  pass 1: applySlotReplacements(template.html, page_modules)     │
         │          → fills template's named slots, returns inner body     │
         │  pass 2: applySlotReplacements(layout.html, {                   │
         │            content: <pass-1 body>,                              │
         │            header / footer / nav: layout_modules                │
         │          })                                                     │
         │                                                                 │
         │  No-fallback: missing `content` slot in layout html →           │
         │    `ComposeError("layout-missing-content")`, not silent render. │
         │  Used by both /edit preview AND apps/static-generator (deploy). │
         └─────────────────────────────────────────────────────────────────┘

         ┌─── STRUCTURED SETS (sideband, render-time injection) ──────────┐
         │  packages/shared/structured-sets.ts                             │
         │                                                                 │
         │  kind=nav-menu  → renders into modules whose slug starts        │
         │                   with `nav-menu-…` (header-main, footer-main)  │
         │  kind=theme     → emits <style>:root{--token:value}</style>     │
         │                   into <head> at compose time                   │
         │  kind=taxonomy / tags / link-list — driven by future plugins    │
         │                                                                 │
         │  page-slug change rewrites every nav-menu / link-list href      │
         │  in the same transaction as the redirect insert.                │
         └─────────────────────────────────────────────────────────────────┘

         ┌─── SITE DEFAULTS (create-time resolver, NOT a fallback) ────────┐
         │  pages.create / templates.create with no layoutId/templateId:   │
         │    consult site_defaults singleton row → use those ids.         │
         │  Render time NEVER consults defaults — missing data crashes     │
         │  loudly per CLAUDE.md §2 no-fallbacks.                          │
         └─────────────────────────────────────────────────────────────────┘
```

**AI tool surface — three "add module" paths, picked by intent:**

```
   user says…                              tool                            blast radius
   ────────────────────────────────────────────────────────────────────────────────────
   "add a CTA on this page"            →  add_module_to_page              one page
   "add a hero on every blog post"     →  add_module_to_template          all pages on template
   "add a footer on every page"        →  add_module_to_layout            all pages on layout
   "move the hero to the header"       →  move_module                     same page, cross-block
   "show testimonials before gallery"  →  reorder_module                  same page, same block
   "duplicate this page"               →  duplicate_page                  modules carry by reference
   "switch this page to landing-tpl"   →  change_template                 modules migrate / orphan-disposition
   "edit the menu"                     →  set_nav_menu                    structured_sets, kind=nav-menu
   "make the primary brighter"         →  update_theme                    structured_sets, kind=theme
```

Mutations on layouts and site_defaults are Owner-only (`actorScope: ["human","system"]`); AI calls return `ActorScopeRejected` and the chat surfaces a permission message instead of trying again.

---

## 2. Non-negotiable invariants

These cannot be violated by any change, AI-generated or human:

- **No raw SQL anywhere.** All database access goes through the Query API → Validator → Database Adapter chain. If you need a new DB operation, add a named op; do not reach past the API.
- **RLS on every table, both DBs, `FORCE`d for owners too.** Role isolation alone is not enough — per-actor and per-plugin scoping live at the Postgres layer.
- **No raw HTML on pages.** Pages are assembled from module references only. Raw HTML belongs inside modules.
- **No raw HTML into `<head>`.** SEO is structured fields only.
- **Plugins never bypass the sandbox.** Deno subprocess + oxc-parser validator + schema declaration + Shadow DOM on every Web Component — disabling any one is a security regression, not an optimisation.
- **Plugin activation requires human confirmation.** AI submits; human Owner flips to active. No auto-activation, ever.
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
- **Dependency review on every PR.** New deps justified in the PR description.

---

## 8. AI-generated code standards

This project is largely AI-authored. AI contributions are held to a *higher*, not lower, bar because they will be reviewed asynchronously by OSS contributors.

- **No half-finished implementations.** If a change introduces a function, it is tested and wired up.
- **Match the permission layer** — a change to the Page Layer cannot add raw HTML; a Plugin Layer change cannot reach the DB directly.
- **Prefer existing modules/utilities** — grep the repo before creating new primitives.
- **Preview diffs must be minimal.** Unrelated formatting churn blocks review.

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

## 11. When in doubt

- Read the relevant section of `CMS_REQUIREMENTS.md` first — most architectural questions have already been decided.
- Then consult `plans/MASTER_PLAN.md` and the relevant `plans/phases/phase_<N>_*.md` for execution specifics.
- If a spec is genuinely ambiguous, open an issue rather than guessing. Do not silently re-interpret.
