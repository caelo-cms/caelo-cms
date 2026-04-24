# Caelo CMS — Implementation Plans

This directory is the planning source of truth for the project. It is version-controlled alongside the code so decisions, phase boundaries, and verification criteria are reviewable in the same PRs as the implementation.

## Layout

- **[`MASTER_PLAN.md`](./MASTER_PLAN.md)** — phase index, dependency graph, CLAUDE.md spec, verification strategy. Read this first.
- **[`phases/`](./phases/)** — one file per phase (`phase_0_bootstrap.md` through `phase_17_docs_release.md`). Each starts as a stub with goal + dependencies + verification anchor + open-decisions list, and is expanded with full task detail when the phase is picked up for execution.

## Source of truth

`CMS_REQUIREMENTS.md` at the repo root is the authoritative spec. Plans reference it; they do not override it. If a plan and the requirements conflict, the requirements win and the plan is updated.

## Workflow

1. Master plan approved → all phase stubs exist.
2. When starting a phase, expand its stub into a full phase file (tasks, file paths, schemas, tests, exit criteria) and open a PR for review *before* writing code.
3. Implementation PRs link back to the phase file and include the phase's end-to-end verification output in the PR description.
4. Phase file is updated with actual outcomes / deviations before the phase is closed.
