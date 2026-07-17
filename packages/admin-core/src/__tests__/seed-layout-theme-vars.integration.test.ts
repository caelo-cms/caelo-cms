// SPDX-License-Identifier: MPL-2.0

/**
 * issue #157 — the 0021 layout seed bound header/footer chrome to
 * var(--color-bg,#fff) / var(--color-fg,#0f172a), names the theme
 * renderer never emits (it emits the Tailwind-4 namespace:
 * --color-background / --color-foreground). Result: the most visible
 * chrome on every page rendered the hardcoded white/slate fallbacks no
 * matter what theme the AI composed — the silent-fallback monochrome
 * trap CLAUDE.md §2 forbids, in our own seed. Migration 0104 rewrites
 * the seed string; this file pins the migration's contract.
 *
 * The test is self-contained: it restores the broken 0021 state inside
 * a transaction, replays the migration's statements from the .sql file
 * (single source — no drifting copy of the UPDATE here), asserts the
 * rewrite + the don't-clobber-edited-css guard, and rolls back. It
 * therefore stays deterministic no matter what earlier test files did
 * to the preserved `layouts` rows.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const MIGRATION_PATH = join(
  import.meta.dir,
  "../../../migrations/migrations/cms_admin/0104_p_issue_157_seed_layout_theme_vars.sql",
);

/** The exact broken seed string 0021 shipped (guard target of 0104). */
const BROKEN_0021_CSS =
  ".caelo-layout-header,.caelo-layout-footer{padding:1rem 2rem;background:var(--color-bg,#fff);color:var(--color-fg,#0f172a)}.caelo-layout-main{padding:2rem 0}";

/** An operator-edited variant that still carries the legacy var names. */
const EDITED_CSS = `${BROKEN_0021_CSS}.custom-tweak{border:1px solid red}`;

/** Migration body without BEGIN/COMMIT so it replays inside our tx. */
function migrationBody(): string {
  return readFileSync(MIGRATION_PATH, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(BEGIN|COMMIT)\s*;\s*$/.test(line))
    .join("\n");
}

function extractVarNames(css: string): string[] {
  return [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1] ?? "");
}

describe("migration 0104 — seed layout theme vars (issue #157)", () => {
  it("rewrites the pristine seed to emitted var names, leaves edited CSS alone", async () => {
    const sql = new SQL(ADMIN_URL as string);
    const conn = await sql.reserve();
    try {
      await conn`BEGIN`;
      await conn`SELECT set_config('caelo.actor_kind', 'system', true)`;

      // Restore the broken 0021 state on the seed row…
      await conn`UPDATE layouts SET css = ${BROKEN_0021_CSS} WHERE slug = 'site-default'`;
      // …and plant an operator-edited layout that must NOT be touched.
      await conn`
        INSERT INTO layouts (slug, display_name, html, css)
        VALUES ('issue-157-edited', 'Edited (issue #157 test)',
                '<html><body><caelo-slot name="content">_</caelo-slot></body></html>',
                ${EDITED_CSS})
      `;

      await conn.unsafe(migrationBody());

      const rows = (await conn`
        SELECT slug, css FROM layouts WHERE slug IN ('site-default', 'issue-157-edited')
      `) as { slug: string; css: string }[];
      const bySlug = new Map(rows.map((r) => [r.slug, r.css]));

      const fixed = bySlug.get("site-default") ?? "";
      // The rewrite binds chrome to the names theme-render.ts actually
      // emits, with NO literal fallbacks (a missing token must fail
      // visibly, not silently render white — CLAUDE.md §2).
      expect(extractVarNames(fixed).sort()).toEqual(["--color-background", "--color-foreground"]);
      expect(fixed).not.toContain("--color-bg,");
      expect(fixed).not.toContain("--color-fg,");
      expect(fixed).not.toMatch(/var\(--[a-z0-9-]+\s*,/);

      // Edited CSS byte-identical — the guard matched on the exact
      // 0021 string, so operator/AI work is never clobbered.
      expect(bySlug.get("issue-157-edited")).toBe(EDITED_CSS);

      // Idempotency: a second replay is a no-op.
      await conn.unsafe(migrationBody());
      const again = (await conn`
        SELECT css FROM layouts WHERE slug = 'site-default'
      `) as { css: string }[];
      expect(again[0]?.css).toBe(fixed);
    } finally {
      await conn`ROLLBACK`.catch(() => {});
      conn.release();
      await sql.end({ timeout: 5 });
    }
  });
});

/** The 0104-rewritten seed CSS that 0166 empties (padding + surface opinion). */
const SEED_0104_CSS =
  ".caelo-layout-header,.caelo-layout-footer{padding:1rem 2rem;background:var(--color-background);color:var(--color-foreground)}.caelo-layout-main{padding:2rem 0}";

function migration0166Body(): string {
  return readFileSync(
    join(
      import.meta.dir,
      "../../../migrations/migrations/cms_admin/0166_p_seed_layout_minimal_no_opinion.sql",
    ),
    "utf8",
  )
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

describe("migration 0166 — seed layout ships no visual opinion (white-band root cause)", () => {
  it("empties the pristine seed CSS, leaves edited layouts alone", async () => {
    const sql = new SQL(ADMIN_URL as string);
    const conn = await sql.reserve();
    try {
      await conn`BEGIN`;
      await conn`SELECT set_config('caelo.actor_kind', 'system', true)`;

      await conn`UPDATE layouts SET css = ${SEED_0104_CSS} WHERE slug = 'site-default'`;
      const editedCss = `${SEED_0104_CSS}.brand{color:hotpink}`;
      await conn`
        INSERT INTO layouts (slug, display_name, html, css)
        VALUES ('issue-166-edited', 'Edited (0166 test)',
                '<html><body><caelo-slot name="content">_</caelo-slot></body></html>',
                ${editedCss})
      `;

      await conn.unsafe(migration0166Body());

      const rows = (await conn`
        SELECT slug, css FROM layouts WHERE slug IN ('site-default', 'issue-166-edited')
      `) as { slug: string; css: string }[];
      const bySlug = new Map(rows.map((r) => [r.slug, r.css]));

      // Pristine seed → empty: no padding/background opinion survives.
      expect(bySlug.get("site-default")).toBe("");
      expect(bySlug.get("site-default")).not.toContain("padding");
      expect(bySlug.get("site-default")).not.toContain("background");

      // An edited layout is byte-identical — the guard matches the exact
      // seed string, so AI/operator layout work is never clobbered.
      expect(bySlug.get("issue-166-edited")).toBe(editedCss);

      // Idempotent replay.
      await conn.unsafe(migration0166Body());
      const again = (await conn`SELECT css FROM layouts WHERE slug = 'site-default'`) as {
        css: string;
      }[];
      expect(again[0]?.css).toBe("");
    } finally {
      await conn`ROLLBACK`.catch(() => {});
      conn.release();
      await sql.end({ timeout: 5 });
    }
  });
});
