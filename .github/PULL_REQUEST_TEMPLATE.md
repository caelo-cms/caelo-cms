<!--
Caelo CMS PR template. Reviewers expect every section filled in.
The full reviewer checklist lives in CONTRIBUTING.md and CLAUDE.md §9.
-->

## What changed

<!-- One-paragraph summary of the user-visible change. Not a diff dump. -->

## Why

<!-- Link the requirements section + plan phase if applicable.
     - Requirements: link to a §X heading in CMS_REQUIREMENTS.md
     - Plan: link to plans/MASTER_PLAN.md or plans/phases/phase_<N>_*.md
     If there's no spec for this, explain what problem it solves and what alternatives you considered. -->

## How verified

<!-- Bullet list of evidence the change works. Reviewers will replay these.
     - `bun test` passes locally (X new tests added)
     - `bunx playwright test` passes (or: which existing flow is now covered)
     - Manual repro: <steps>
     - Specific scenarios from CLAUDE.md §6 testing matrix
-->

## New dependencies

<!-- For every new dependency added (root or any workspace):
     - Name + version
     - License (must be MPL-2.0-compatible: MPL/Apache-2.0/MIT/BSD/ISC/0BSD/CC0-1.0)
     - Why this dep over alternatives
   If no new dependencies: write "None".
-->

<!-- An automated AI security review runs on every PR (CONTRIBUTING.md → "AI
     security review"). Add the `skip-ai-review` label if this PR should
     bypass it (e.g. a docs-only mass rename). The review is informational —
     human approval is still required for merge. -->

## Reviewer checklist

- [ ] Permission layer respected (no AI tool reaches a write op the AI actor can't dispatch)
- [ ] Query API only — no raw SQL outside of Query API handlers
- [ ] Snapshots emitted for every write that affects authoring state
- [ ] Zod validation present at every external boundary (tool calls, HTTP requests, plugin SDK surfaces)
- [ ] Tests added (unit + integration + Playwright per CLAUDE.md §6)
- [ ] Docs updated when behaviour is user-visible (`docs-site/` for end-user docs; `CLAUDE.md` / `ARCHITECTURE.md` for engineering principles)
- [ ] `// SPDX-License-Identifier: MPL-2.0` header on every new source file
