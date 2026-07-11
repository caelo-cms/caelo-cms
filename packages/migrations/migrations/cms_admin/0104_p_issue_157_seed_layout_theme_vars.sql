-- SPDX-License-Identifier: MPL-2.0
--
-- 0104 — Seed layout CSS references nonexistent theme vars (issue #157).
--
-- Problem: the 0021 layout seed binds header/footer chrome to
-- var(--color-bg,#fff) / var(--color-fg,#0f172a) — but the theme
-- renderer emits the Tailwind-4 namespace (--color-background /
-- --color-foreground; see packages/shared/src/theme-render.ts) and
-- nothing ever emits --color-bg / --color-fg. The vars never resolve,
-- so the most visible chrome on every page renders the hardcoded
-- white/slate fallbacks no matter what theme the AI composes — the
-- silent-fallback monochrome trap CLAUDE.md §2 forbids, shipped in our
-- own seed.
--
-- Fix: rewrite to the emitted var names WITHOUT literal fallbacks — a
-- theme genuinely missing color.background should render visibly broken
-- (loud), not silently white. Guarded by an exact match on the original
-- seed string so operator/AI-edited layout CSS is never clobbered
-- (matching on css, not slug, also repairs verbatim clones of the
-- broken seed). Idempotent: after the rewrite the WHERE stops matching.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE layouts
SET css = '.caelo-layout-header,.caelo-layout-footer{padding:1rem 2rem;background:var(--color-background);color:var(--color-foreground)}.caelo-layout-main{padding:2rem 0}'
WHERE css = '.caelo-layout-header,.caelo-layout-footer{padding:1rem 2rem;background:var(--color-bg,#fff);color:var(--color-fg,#0f172a)}.caelo-layout-main{padding:2rem 0}';

COMMIT;
