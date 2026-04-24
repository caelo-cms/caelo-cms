# Phase 0 — Repo bootstrap, tooling & CLAUDE.md

**Status:** ✓ complete — scaffold verified end-to-end on 2026-04-24. `bun install && docker compose up -d && bun run lint && bun run typecheck && bun run test` all green.
**Dependencies:** none (greenfield).
**Unblocks:** P1, P2.

## Goal (from master plan)
Initialise the Bun monorepo with TypeScript (strict), Biome, Zod, Vitest, a root `docker-compose.yml` with PostgreSQL, GitHub Actions CI (typecheck + lint + test), and `CLAUDE.md` at the repo root. Deliverable: `bun install && docker compose up -d && bun test` green on empty scaffold; `CLAUDE.md` reviewed.

## End-to-end verification
`bun install && docker compose up -d && bun test` green on empty scaffold.

## Versions pinned (verified against npm registry at time of scaffold)

| Tool | Version | Source |
|---|---|---|
| Bun (runtime + package manager) | 1.3.13 | github.com/oven-sh/bun latest release |
| TypeScript | 5.9.3 | npm registry (5.x chosen for tooling-compat stability; 6.x is on `latest` but we keep to 5.x until Biome/@types/bun confirm support) |
| @biomejs/biome | 2.4.13 | npm registry `latest` |
| Zod | 4.3.6 | npm registry `latest` |
| Vitest | 4.1.5 | npm registry `latest` |
| PostgreSQL image | `postgres:17-alpine` | Docker Hub |

## Files created

```
/Users/michaelweber/Projects/caleo-cms/
├── .editorconfig
├── .github/workflows/ci.yml
├── .gitignore
├── CLAUDE.md                         # Full engineering principles (§1–11 from master plan)
├── CMS_REQUIREMENTS.md               # (pre-existing, v1.3)
├── LICENSE                           # MPL 2.0 full text
├── README.md                         # Quickstart
├── biome.json                        # Biome 2.x config
├── docker-compose.yml                # postgres:17-alpine + healthcheck
├── package.json                      # workspaces root, dev deps, scripts
├── tsconfig.base.json                # strict TypeScript base config
├── tsconfig.json                     # solution file, references all workspaces
├── vitest.config.ts                  # Vitest root config
├── apps/
│   ├── admin/                        # SvelteKit admin (scaffold only)
│   ├── api-gateway/                  # Bun HTTP gateway (scaffold only)
│   └── static-generator/             # Astro static gen (scaffold only)
└── packages/
    ├── migrations/                   # (empty, populated in P1)
    ├── plugin-sdk/                   # Plugin SDK (scaffold only)
    ├── provisioning/                 # Pulumi (scaffold only)
    ├── query-api/                    # Query API (scaffold only)
    └── shared/                       # Zod/shared types + placeholder test
```

Every workspace has: `package.json` (name `@caelo/<slug>`, `license: MPL-2.0`, `type: module`, `typecheck` script), `tsconfig.json` extending the base with `composite: true` + appropriate `references`, and an `src/index.ts` placeholder carrying the SPDX header.

`packages/shared/src/index.test.ts` is the seed test that makes `bun test` meaningful on the empty scaffold.

## How to verify locally

```bash
cd /Users/michaelweber/Projects/caleo-cms

# If Bun is not installed:
curl -fsSL https://bun.sh/install | bash

bun install
docker compose up -d
bun run lint
bun run typecheck
bun run test
```

All three commands should pass. The GitHub Actions workflow in `.github/workflows/ci.yml` runs the same three commands against a PostgreSQL 17 service container on every push + PR.

## Verified outcomes

| Check | Result |
|---|---|
| `bun install` | 106 packages installed, clean lockfile |
| `docker compose up -d` | `caelo-postgres` healthy on :5432 |
| `bun run lint` | 27 files checked, 0 issues |
| `bun run typecheck` | all 7 workspaces pass |
| `bun run test` | 1 file / 1 test passing (the shared-scaffold smoke test) |

Two small fixes were needed during first-run verification and are recorded for any future regeneration:

- Biome 2.2+ dropped the trailing `/**` in folder-ignore globs — patterns are now `!**/dist` not `!**/dist/**`.
- Internal relative test imports must use `./index.js` (or no extension), not `./index.ts`, unless `allowImportingTsExtensions` is enabled — we keep it disabled so emitted declarations resolve cleanly.

## Known follow-ups (for P1+)

- `packages/migrations/` is empty by design — migration tooling choice (drizzle-kit vs Atlas) is a P1 decision.
- `apps/admin/` is a stub; SvelteKit + svelte-adapter-bun install is a P2 task.
- `apps/static-generator/` is a stub; Astro install is a P6 task.
- TypeScript is pinned to 5.9.3 pending Biome 2.x / `@types/bun` confirmation of 6.x compat — revisit before P1 starts (npm shows 6.0.3 on `latest`).
