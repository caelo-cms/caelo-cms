# Phase 2 — Admin shell, auth, security control panel

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P1.
**Unblocks:** P3, P5.

## Goal (from master plan)
SvelteKit + `svelte-adapter-bun` admin app. Session-based email/password login, **built-in Owner/Editor/Reviewer roles plus Owner-defined custom roles** (requirements §9.1), role-gated routes. Scaffold the security control panel (stub sections: AI provider config, domain settings, cost controls, user management) — *non-AI*, admin-only. Deliverable: fresh install → owner signup → login → land on empty dashboard. OAuth deferred to the auth plugin in P12.

## End-to-end verification
Fresh install → owner signup → login → reach dashboard; Reviewer cannot reach deploy route; Owner creates a custom role with a reduced permission set, assigns it to a user, and the user is blocked from out-of-scope routes.

## To be detailed before execution
- Session storage table in `cms_admin` (sessions, tokens, CSRF).
- Password hashing (argon2id — verify current recommended params).
- Role model: `roles` table (built-in rows seeded + custom rows created by Owner), `role_permissions` junction over a fixed permission catalog, `user_roles` junction.
- Role middleware pattern — single source of truth resolving user → roles → permissions → route allow/deny; per-route declaration references permissions, not role names.
- Custom role UI: Owner-only; edit permission checkboxes; role name + description; cannot delete built-in roles.
- First-run owner bootstrap (no signup endpoint exposed after first owner exists).
- Security control panel: read-only stubs, each section pointing to later phase that fills it.
- E2E test: Playwright scripts for login + built-in role enforcement + custom role creation and enforcement.
