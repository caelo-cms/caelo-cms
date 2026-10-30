// SPDX-License-Identifier: MPL-2.0

/**
 * Which repo paths each real-AI scenario covers — the selection manifest for
 * `.github/workflows/e2e-livedit.yml` (the planner is `lib/plan.ts`).
 *
 * The suite costs real money per run (~$5 for all scenarios, measured
 * 2026-10-20..26), so a pull request labelled `real-ai` runs only what its
 * change can break (unlabelled PRs run nothing; `real-ai-full` runs all):
 *
 *   - no AI-relevant file changed (UI-only, docs, CI, provisioning…) →
 *     nothing runs, the required check passes as skipped;
 *   - otherwise the CORE scenario (always) plus every scenario whose
 *     `paths` match a changed file;
 *   - a harness change (`HARNESS_PATHS`) runs every scenario.
 *
 * A scenario whose covered files the PR has not changed since a run of the
 * same PR where it passed keeps that result instead of running again
 * (`lib/plan.ts`, result keys). The release gate uses the same mapping to
 * re-run only the scenarios whose covered files changed since their last
 * green on main (`lib/main-greens.ts`).
 *
 * `lib/plan.test.ts` fails when a file under `AI_RELEVANT_PATHS` is matched
 * by no CI scenario and is not listed in `NO_REAL_AI_COVERAGE` — a new AI
 * area is either mapped to the scenario that exercises it or consciously
 * declared uncovered here, never silently skipped.
 *
 * Globs are `Bun.Glob` patterns relative to the repo root.
 */

/** One scenario spec under `apps/admin/e2e-livedit/`. */
export interface ScenarioCoverage {
  /** Short stable id (used in the per-scenario result keys). */
  readonly id: string;
  /** Spec file name inside `apps/admin/e2e-livedit/`. */
  readonly file: string;
  /**
   * The always-on core: runs on every PR with an AI-relevant change, and its
   * result key covers every AI-relevant file (any such change re-runs it).
   */
  readonly core?: true;
  /**
   * Env flag the spec needs to run at all. CI never sets these, so the
   * planner never selects an opt-in scenario (it would only skip itself).
   */
  readonly optIn?: string;
  /** Repo paths the scenario exercises (beyond its own spec and the harness). */
  readonly paths: readonly string[];
}

const A = "packages/admin-core/src";
const SHARED = "packages/shared/src";
const ADMIN = "apps/admin/src";

/** Plugin runtime: host, SDK, sandbox, component kit, plugin ops + tools. */
const PLUGIN_RUNTIME = [
  "packages/plugin-host/**",
  "packages/plugin-sdk/**",
  "packages/plugin-sandbox/**",
  "packages/plugin-component-kit/**",
  `${A}/ops/plugins/**`,
  `${A}/ops/plugin-data.ts`,
  `${A}/plugin-data/**`,
  `${A}/ai/plugin-*.ts`,
  `${A}/ai/tools/activate-plugin.ts`,
  `${A}/ai/tools/add-plugin-to-page.ts`,
  `${A}/ai/tools/list-plugins.ts`,
  `${A}/ai/tools/plugin-lifecycle-tools.ts`,
  `${A}/ai/tools/_plugin-write-hints.ts`,
  `${ADMIN}/lib/server/plugin-*.ts`,
  `${SHARED}/plugin-preview.ts`,
] as const;

/** Lists, list types and page types (epic #1107). */
const LISTS = [
  `${A}/lists/**`,
  `${A}/ops/lists/**`,
  `${A}/ai/tools/_list-tool-*.ts`,
  `${A}/ai/tools/list-type-tools.ts`,
  `${A}/ai/tools/page-type-tools.ts`,
  `${A}/ai/tools/_shared-list-guard.ts`,
  `${SHARED}/lists/**`,
  `${ADMIN}/lib/server/lists.ts`,
] as const;

/** Layout chrome: layouts, template blocks, layout placements. */
const LAYOUTS = [
  `${A}/ops/content/layout*.ts`,
  `${A}/ops/content/template_blocks.ts`,
  `${A}/ai/tools/create-layout.ts`,
  `${A}/ai/tools/list-layouts.ts`,
  `${A}/ai/tools/set-template-layout.ts`,
  `${A}/ai/tools/_layout-module-fields.ts`,
  `${A}/ai/tools/_block-*.ts`,
] as const;

/** Modules, fields, content instances and the template engine that renders them. */
const MODULES = [
  `${A}/ops/content/modules.ts`,
  `${A}/ops/content/module-placements.ts`,
  `${A}/ops/content/content-instance*.ts`,
  `${A}/ops/content/shared-content.ts`,
  `${A}/ops/content/page-module-*.ts`,
  `${A}/ops/content/extract-module-*.ts`,
  `${A}/ops/content/preview*.ts`,
  // #1212 — the whole-site view every preview renders against.
  `${A}/site-view.ts`,
  `${A}/ai/tools/_mint-module.ts`,
  `${A}/ai/tools/_module-fields-schema.ts`,
  `${A}/ai/tools/add-module.ts`,
  `${A}/ai/tools/bulk-pages-modules.ts`,
  `${A}/ai/tools/content-maintenance-tools.ts`,
  `${A}/ai/tools/*content-instance*.ts`,
  `${SHARED}/template-*.ts`,
  `${SHARED}/nested-module-render.ts`,
  `${SHARED}/preview-compose.ts`,
] as const;

/**
 * Every scenario spec. A spec file that is not listed here fails
 * `lib/plan.test.ts`.
 */
export const SCENARIOS: readonly ScenarioCoverage[] = [
  {
    // Why the homepage is the core: it is the one scenario that drives the
    // whole loop on every AI surface at once — cold start, theme compose,
    // page + module build through the full tool catalogue and the system
    // prompt, AI Stage, quality audit, human Publish, re-edit, vision
    // verdict — and it carries the token/loop ceilings (lib/metrics-core.ts).
    // Every tool description and schema rides in every request it makes, so
    // a catalogue or prompt regression anywhere shows up here first.
    id: "homepage",
    file: "scenario-homepage.browser.ts",
    core: true,
    paths: [
      // The AI layer: chat-runner, system prompt, providers, the whole tool
      // catalogue (every definition rides in every request).
      `${A}/ai/**`,
      // #1217 — where screenshot_page's server-side renders run (in-process
      // on the CI install; the GCP job shares the protocol and preview hand-over).
      `${A}/capture/**`,
      `${A}/preview-document.ts`,
      // What a homepage build → Stage → Publish → re-edit writes and reads.
      `${A}/ops/chat/**`,
      `${A}/ops/content/**`,
      `${A}/ops/themes*.ts`,
      `${A}/ops/theme-font-*.ts`,
      `${A}/ops/quality/**`,
      `${A}/ops/snapshots/**`,
      `${A}/ops/stage_readiness.ts`,
      `${A}/ops/site_defaults*.ts`,
      `${A}/ops/seo*.ts`,
      // Page SEO rides the chat's draft through Stage (#1156): autofill before
      // the first Stage, the staged read, the publish.
      `${A}/seo/**`,
      `${A}/ops/skills/**`,
      `${A}/ops/subagents/**`,
      `${A}/ops/ai/**`,
      `${A}/ops/deploy*.ts`,
      `${A}/ops/page_log.ts`,
      `${A}/ops/tool_approvals.ts`,
      `${A}/ops/pending_proposals.ts`,
      // #1215 — every chat turn's stream forwards the live-refresh topics
      // its commits announce (agents, pending, quality …).
      `${A}/live-events.ts`,
      `${SHARED}/live-events.ts`,
      `${A}/ops/_*.ts`,
      `${A}/ops/links*.ts`,
      `${A}/stage/**`,
      `${A}/quality/**`,
      `${A}/snapshots/**`,
      `${A}/deploy/**`,
      `${A}/draft.ts`,
      `${A}/branch.ts`,
      `${A}/locks.ts`,
      `${A}/tool-call-version.ts`,
      `${A}/lock-takeover.ts`,
      `${A}/entity-*.ts`,
      `${A}/links/**`,
      `${A}/untrusted/**`,
      `${A}/bug-forwarding/**`,
      `${A}/register.ts`,
      `${A}/index.ts`,
      `${A}/audit.ts`,
      `${A}/permissions.ts`,
      `${A}/sql-helpers.ts`,
      `${A}/tokens.ts`,
      `${A}/domain-events.ts`,
      `${A}/public-projection.ts`,
      `${A}/theme-document-input.ts`,
      `${A}/rate-limit.ts`,
      // Rendering + composition the published page goes through.
      `${SHARED}/content.ts`,
      `${SHARED}/build-page.ts`,
      `${SHARED}/ai-tools.ts`,
      `${SHARED}/theme*.ts`,
      `${SHARED}/base-css.ts`,
      `${SHARED}/css-*.ts`,
      `${SHARED}/font*.ts`,
      `${SHARED}/seo.ts`,
      `${SHARED}/url.ts`,
      `${SHARED}/link-refs.ts`,
      `${SHARED}/edit-markers.ts`,
      `${SHARED}/preview-*.ts`,
      `${SHARED}/markup-structure.ts`,
      `${SHARED}/snapshots.ts`,
      `${SHARED}/subagents.ts`,
      `${SHARED}/skills.ts`,
      `${SHARED}/index.ts`,
      // Plumbing every request and the publish path run through.
      `${SHARED}/{context,logger,result,cap-failures,untrusted-tool-result,run-batched,safe-keys}.ts`,
      `${SHARED}/{raw-text-escape,html-blank,id-safe-truncate,strip-cdata,uuid-diagnose,version}.ts`,
      `${SHARED}/{phase-timer,source-text-transport,escaped-line-breaks,module-id-tag}.ts`,
      `${SHARED}/{link-canonicalise,interactions}.ts`,
      `${SHARED}/{page-log,proposal-status,document-language,database-url,screenshot-capture}.ts`,
      `${SHARED}/{static-cache-policy,static-security-headers,publish-live-parity,staging-gate}.ts`,
      `${A}/ops/notifications.ts`,
      "packages/query-api/src/**",
      "packages/migrations/**",
      "packages/plugins/**",
      "packages/font-service/src/**",
      "apps/static-generator/**",
      `${ADMIN}/hooks.server.ts`,
      `${ADMIN}/lib/server/**`,
      `${ADMIN}/lib/components/chat/**`,
      `${ADMIN}/lib/components/edit/**`,
      `${ADMIN}/routes/(authed)/edit/**`,
      `${ADMIN}/routes/(authed)/api/chat/**`,
      `${ADMIN}/routes/(authed)/api/agents/**`,
      "bun.lock",
      "package.json",
      "packages/*/package.json",
      "apps/*/package.json",
    ],
  },
  {
    id: "ai-layout-footer",
    file: "scenario-ai-layout-footer.browser.ts",
    // Release gate v0.11.1 (run 40532297620) failed here on module source
    // sent with escaped line breaks: the decode and the js syntax check.
    paths: [
      ...LAYOUTS,
      ...LISTS,
      `${SHARED}/{source-text-transport,escaped-line-breaks}.ts`,
      `${A}/ops/content/module-js-syntax.ts`,
    ],
  },
  {
    id: "lists-mega-menu",
    file: "scenario-lists-mega-menu.browser.ts",
    paths: [...LAYOUTS, ...LISTS],
  },
  {
    id: "lists-blog-categories",
    file: "scenario-lists-blog-categories.browser.ts",
    paths: [...LISTS, `${A}/ops/content/pages.ts`, `${A}/ai/tools/build-page.ts`],
  },
  {
    id: "ai-nested-cta",
    file: "scenario-ai-nested-cta.browser.ts",
    paths: [...MODULES],
  },
  {
    id: "nested-modules",
    file: "scenario-nested-modules.browser.ts",
    paths: [...MODULES],
  },
  {
    id: "extract-fields",
    file: "scenario-extract-fields.browser.ts",
    paths: [...MODULES],
  },
  {
    id: "content-library-shared-edit",
    file: "scenario-content-library-shared-edit.browser.ts",
    paths: [
      ...MODULES,
      `${ADMIN}/routes/(authed)/content/**`,
      `${ADMIN}/lib/components/content/**`,
    ],
  },
  {
    id: "placement-sync-toggle",
    file: "scenario-placement-sync-toggle.browser.ts",
    paths: [
      ...MODULES,
      `${A}/ai/tools/fork-placement-content.ts`,
      `${A}/ai/tools/set-placement-content.ts`,
      `${ADMIN}/routes/(authed)/content/**`,
      `${ADMIN}/lib/components/content/**`,
    ],
  },
  {
    id: "consent",
    file: "scenario-consent.browser.ts",
    paths: [...PLUGIN_RUNTIME, "packages/plugins/consent-manager/**"],
  },
  {
    id: "international-site",
    file: "scenario-international-site.browser.ts",
    paths: [
      ...PLUGIN_RUNTIME,
      "packages/plugins/international-site/**",
      `${A}/ai/chat-runner/approval*.ts`,
      `${A}/ai/chat-runner/e2e-auto-approve.ts`,
      `${A}/ai/queued-tool-approval.ts`,
      `${A}/ai/tools/gated-tools.ts`,
    ],
  },
  {
    id: "image-gen",
    file: "scenario-image-gen.browser.ts",
    paths: [
      `${A}/ai/image-*.ts`,
      `${A}/ai/plugin-image-*.ts`,
      `${A}/ai/providers/gemini.ts`,
      `${A}/ai/tools/generate-image.ts`,
      `${A}/ai/tools/edit-image.ts`,
      `${A}/ai/tools/get-image-capabilities.ts`,
      `${A}/ops/image_requests.ts`,
      `${A}/ops/media*.ts`,
      `${A}/media/**`,
      `${SHARED}/image-capabilities.ts`,
      `${SHARED}/google-models.ts`,
      `${SHARED}/media.ts`,
      `${SHARED}/responsive-images.ts`,
    ],
  },
  // Opt-in: listed so a manual run knows what they cover; never selected in CI.
  {
    id: "consistency",
    file: "scenario-consistency.browser.ts",
    optIn: "CAELO_LIVEDIT_CONSISTENCY",
    paths: [`${A}/ai/theme-guidance.ts`, `${A}/ai/tools/_design-guard.ts`, `${SHARED}/theme-*.ts`],
  },
  {
    id: "genesis",
    file: "scenario-genesis.browser.ts",
    optIn: "CAELO_LIVEDIT_GENESIS",
    paths: [`${A}/ops/genesis.ts`, `${A}/ai/tools/design-draft-tools.ts`, `${SHARED}/genesis*.ts`],
  },
  {
    id: "onboarding",
    file: "scenario-onboarding.browser.ts",
    optIn: "CAELO_LIVEDIT_ONBOARDING",
    paths: [
      `${A}/ai/tools/inspect-external-page.ts`,
      `${A}/ops/imports*.ts`,
      "packages/site-importer/**",
    ],
  },
  {
    id: "migrate",
    file: "scenario-migrate.browser.ts",
    optIn: "CAELO_LIVEDIT_MIGRATE",
    paths: [`${A}/site-import/**`, `${A}/ops/imports*.ts`, "packages/site-importer/**"],
  },
  {
    id: "google-pictbook",
    file: "google-pictbook.browser.ts",
    optIn: "CAELO_LIVE_GOOGLE_PICTBOOK",
    paths: [`${A}/ai/providers/gemini.ts`, `${A}/ai/providers/google-tool-schema.ts`],
  },
];

/**
 * Files whose change can alter what the AI sees or does, or the chat → Stage
 * → Publish loop the suite drives. A PR that touches none of them does not
 * run the suite at all. Excluded below: tests, and `NO_REAL_AI_COVERAGE`.
 */
export const AI_RELEVANT_PATHS: readonly string[] = [
  `${A}/**`,
  `${SHARED}/**`,
  "packages/query-api/src/**",
  "packages/migrations/**",
  "packages/plugins/**",
  "packages/plugin-host/**",
  "packages/plugin-sdk/**",
  "packages/plugin-sandbox/**",
  "packages/plugin-component-kit/**",
  "packages/site-importer/**",
  "packages/font-service/src/**",
  "apps/static-generator/**",
  `${ADMIN}/hooks.server.ts`,
  `${ADMIN}/lib/server/**`,
  `${ADMIN}/lib/components/chat/**`,
  `${ADMIN}/lib/components/edit/**`,
  `${ADMIN}/routes/(authed)/edit/**`,
  `${ADMIN}/routes/(authed)/api/chat/**`,
  `${ADMIN}/routes/(authed)/api/agents/**`,
  "bun.lock",
  "package.json",
  "packages/*/package.json",
  "apps/*/package.json",
];

/** Never AI-relevant: tests and benches change no runtime behaviour. */
export const NON_RUNTIME_PATHS: readonly string[] = [
  "**/*.test.ts",
  "**/*.bench.ts",
  "**/__tests__/**",
  "**/*.md",
];

/**
 * Inside the AI-relevant roots, but no CI scenario exercises them: Owner-only
 * surfaces (users, roles, step-up, platform updates, domains, gateway,
 * email), install-time code. A change here runs nothing — the honest state,
 * since no scenario would reach it. Move an entry into a scenario's `paths`
 * when a scenario starts covering it.
 */
export const NO_REAL_AI_COVERAGE: readonly string[] = [
  // Covered only by opt-in scenarios (genesis, onboarding, migrate), which
  // CI never runs.
  `${A}/ops/genesis.ts`,
  `${SHARED}/genesis*.ts`,
  `${SHARED}/design-draft-shell.ts`,
  `${A}/site-import/**`,
  `${A}/ops/imports*.ts`,
  `${A}/ops/import_media.ts`,
  "packages/site-importer/**",
  // No scenario reaches these ops: redirects, provider setup, theme import,
  // revert proposals, proposal cancel, background GC loops.
  `${A}/ops/redirects.ts`,
  // Saved redirects sync to the hosting provider on save (#1157).
  `${A}/ops/redirect_sync.ts`,
  `${A}/redirect-sync-worker.ts`,
  `${SHARED}/redirect-plan.ts`,
  `${SHARED}/redirect-target.ts`,
  `${A}/ops/ai_providers_pending.ts`,
  `${SHARED}/theme-importers/**`,
  `${A}/ops/snapshot_pending.ts`,
  `${A}/ops/cancel_proposal.ts`,
  `${A}/*-gc-worker.ts`,
  // Owner-only and install-time surfaces.
  `${A}/platform-updates/**`,
  `${A}/ops/platform-update*.ts`,
  `${A}/ops/platform_health.ts`,
  `${A}/email/**`,
  `${A}/ops/email_config*.ts`,
  `${A}/release-check-worker.ts`,
  `${A}/staging-preview-keepalive-worker.ts`,
  `${A}/password.ts`,
  `${A}/csrf.ts`,
  `${A}/healthcheck.ts`,
  // Install-time connection budget, read by provisioning (#1254).
  `${SHARED}/pool-budget.ts`,
  `${A}/security/**`,
  `${A}/ops/security/**`,
  `${A}/ops/step-up.ts`,
  `${A}/ops/owner-bootstrap-tokens.ts`,
  `${A}/ops/provisioning_outputs.ts`,
  `${A}/ops/auth.ts`,
  `${A}/ops/users.ts`,
  `${A}/ops/user_*.ts`,
  `${A}/ops/roles.ts`,
  `${A}/ops/role_pending.ts`,
  `${A}/ops/domains.ts`,
  `${A}/ops/domain_*.ts`,
  `${A}/ops/gateway.ts`,
  `${A}/ops/staging_access.ts`,
  `${A}/ops/owner_settings_*.ts`,
  `${A}/ops/mcp_*.ts`,
  `${A}/ops/credential_handoffs.ts`,
  `${SHARED}/cloud-shell-install.ts`,
  `${SHARED}/auto-update.ts`,
  `${SHARED}/platform-updates.ts`,
  `${SHARED}/provisioning-command.ts`,
  `${SHARED}/release-manifest.ts`,
  `${SHARED}/google-oauth.ts`,
  `${SHARED}/auth-forms.ts`,
  `${SHARED}/bug-intake.ts`,
  `${SHARED}/mcp-access.ts`,
  `${SHARED}/redirect-emit-*.ts`,
  `${ADMIN}/lib/server/google-iap.ts`,
  `${ADMIN}/lib/server/forgot-password.ts`,
  `${ADMIN}/lib/server/operator-access.ts`,
  `${ADMIN}/lib/server/owner-reset-route*.ts`,
  `${ADMIN}/lib/server/step-up.ts`,
  `${ADMIN}/lib/server/upgrader.ts`,
  `${ADMIN}/lib/server/release-check.ts`,
  `${ADMIN}/lib/server/mcp-*.ts`,
];

/**
 * The suite's own machinery. A change here runs EVERY scenario (the harness
 * is what every verdict rests on) and is part of every result key. Scenario
 * specs, unit tests, this manifest and the known-bugs ledger are excluded: a
 * spec change re-runs that scenario only, a mapping edit changes no test
 * behaviour, and the ledger only re-labels what the bug gate of whatever
 * runs reports.
 */
export const HARNESS_PATHS: readonly string[] = [
  "apps/admin/e2e-livedit/**",
  "apps/admin/playwright.livedit.config.ts",
  ".github/workflows/e2e-livedit.yml",
  ".github/actions/playwright-chromium/**",
  "scripts/ai-provider-preflight.ts",
  "docker-compose.yml",
];

/** Excluded from `HARNESS_PATHS` (see there). */
export const HARNESS_EXCLUDE: readonly string[] = [
  "apps/admin/e2e-livedit/*.browser.ts",
  "apps/admin/e2e-livedit/scenario-paths.ts",
  "apps/admin/e2e-livedit/lib/known-bugs.ts",
  "**/*.test.ts",
  "**/*.md",
];
