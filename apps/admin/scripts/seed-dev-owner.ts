// SPDX-License-Identifier: MPL-2.0

/**
 * Idempotent dev-owner seed for manual inspection.
 *
 * Why this exists: tests deliberately use scoped emails (e.g.
 * `auth-test-owner@example.com`) and clean themselves up, so a fresh DB has no
 * known login. Manual screenshot runs and Playwright debug sessions need a
 * stable account whose password they know. This script provides one without
 * touching the first-owner bootstrap path (which only runs when the users
 * table is empty and is a poor fit for repeatable dev seeds).
 *
 * Usage:
 *   bun run apps/admin/scripts/seed-dev-owner.ts
 *
 * Env:
 *   ADMIN_DATABASE_URL              required
 *   DEV_OWNER_EMAIL    (default dev-owner@example.com)
 *   DEV_OWNER_PASSWORD (default dev owner password)
 *
 * Re-running with the same email refreshes the password and re-attaches the
 * owner role; user_roles rows orphaned by an earlier integration test no
 * longer block manual login.
 */

import { hashPassword } from "@caelo-cms/admin-core";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) {
  console.error("ADMIN_DATABASE_URL is required");
  process.exit(1);
}

const EMAIL = process.env.DEV_OWNER_EMAIL ?? "dev-owner@example.com";
const PASSWORD = process.env.DEV_OWNER_PASSWORD ?? "dev owner password";

const passwordHash = await hashPassword(PASSWORD);
const sql = new SQL(ADMIN_URL);
try {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");

    // Reuse the actor behind this email if a row already exists; otherwise
    // mint a fresh one. `users.id` IS the actor uuid (FK users.id -> actors.id),
    // and user_roles.user_id -> users.id, so one uuid flows through all three.
    // The owner grant lives in user_roles (there is no inline role column).
    const existing = (await tx`
      SELECT id::text AS id FROM users WHERE email = ${EMAIL}
    `) as unknown as { id: string }[];

    let actorId: string;
    if (existing[0]) {
      actorId = existing[0].id;
      await tx`
        UPDATE users
          SET password_hash = ${passwordHash},
              deleted_at    = NULL,
              onboarded_at  = COALESCE(onboarded_at, now())
          WHERE email = ${EMAIL}
      `;
    } else {
      const actor = (await tx`
        INSERT INTO actors (kind, display_name) VALUES ('human', 'Dev Owner')
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      const id = actor[0]?.id;
      if (!id) throw new Error("seed actor insert returned no row");
      actorId = id;
      await tx`
        INSERT INTO users (id, email, password_hash, is_first_owner, onboarded_at)
        VALUES (${actorId}::uuid, ${EMAIL}, ${passwordHash}, false, now())
      `;
    }

    // Grant the owner role. user_roles.user_id -> users.id (the actor uuid).
    await tx`
      INSERT INTO user_roles (user_id, role_id)
      SELECT ${actorId}::uuid, r.id FROM roles r WHERE r.name = 'owner'
      ON CONFLICT DO NOTHING
    `;

    // epic #186 — the seed deliberately creates NO pages anymore: an
    // empty install is the wanted first-run state (the /edit chat
    // greets with the onboarding entry points, which the old seeded
    // home page suppressed). Template + site_defaults still seed so
    // the create-time resolver has its stored defaults (CLAUDE.md §2).
    {
      // P6.7.6 — every template binds to a layout. The migration seeded
      // `site-default`; bind home-template to it explicitly so a fresh
      // install (which runs migrations + seed-dev in sequence) has the
      // chrome wrapping by default.
      // Existence-guarded rather than ON CONFLICT: the unique index is a
      // partial expression index on (slug, COALESCE(chat_branch_id, ...))
      // WHERE deleted_at IS NULL, which ON CONFLICT arbiter inference can't
      // reliably match. A SELECT-then-INSERT is drift-proof.
      const tplExisting = (await tx`
        SELECT id::text AS id FROM templates
        WHERE slug = 'home-template' AND deleted_at IS NULL
      `) as unknown as { id: string }[];
      let tplId: string;
      if (tplExisting[0]) {
        tplId = tplExisting[0].id;
      } else {
        const tpl = (await tx`
          INSERT INTO templates (slug, display_name, html, css, layout_id)
          VALUES (
            'home-template',
            'Home Template',
            '<!doctype html><html><head><title>Home</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
            '',
            (SELECT id FROM layouts WHERE slug = 'site-default')
          )
          RETURNING id::text AS id
        `) as unknown as { id: string }[];
        const id = tpl[0]?.id;
        if (!id) throw new Error("seed home template returned no row");
        tplId = id;
      }

      // Idempotent: ensure site_defaults points at the seeded home-template
      // + site-default layout. The migration only INSERTs when home-template
      // exists at migrate time; on a fresh DB it doesn't, so we backfill.
      // `id` is a GENERATED ALWAYS identity (the singleton pkey) we never
      // write, so guard on row existence rather than ON CONFLICT.
      const sdExisting = (await tx`
        SELECT 1 AS x FROM site_defaults LIMIT 1
      `) as unknown as { x: number }[];
      if (sdExisting[0]) {
        await tx`
          UPDATE site_defaults SET
            default_layout_id   = (SELECT id FROM layouts WHERE slug = 'site-default'),
            default_template_id = ${tplId}::uuid,
            updated_at          = now()
        `;
      } else {
        await tx`
          INSERT INTO site_defaults (default_layout_id, default_template_id)
          VALUES (
            (SELECT id FROM layouts WHERE slug = 'site-default'),
            ${tplId}::uuid
          )
        `;
      }

      await tx`
        INSERT INTO template_blocks (template_id, name, display_name, position)
        VALUES (${tplId}::uuid, 'content', 'Content', 0)
        ON CONFLICT (template_id, name) DO NOTHING
      `;
    }

    // P6.7.5 — default structured sets so a fresh install has a
    // working header / footer / theme / tags primitive out of the box.
    // Idempotent: ON CONFLICT (kind, slug) DO NOTHING keeps user edits
    // intact across re-seed.
    await tx`
      INSERT INTO structured_sets (kind, slug, display_name, items, updated_by)
      VALUES (
        'nav-menu', 'header-main', 'Header navigation',
        ${[{ label: "Home", href: "/home" }]}::jsonb,
        ${actorId}::uuid
      )
      ON CONFLICT (kind, slug) DO NOTHING
    `;
    await tx`
      INSERT INTO structured_sets (kind, slug, display_name, items, updated_by)
      VALUES (
        'nav-menu', 'footer-main', 'Footer navigation',
        ${[]}::jsonb,
        ${actorId}::uuid
      )
      ON CONFLICT (kind, slug) DO NOTHING
    `;
    await tx`
      INSERT INTO structured_sets (kind, slug, display_name, items, updated_by)
      VALUES (
        'theme', 'site', 'Site theme',
        ${[
          { token: "color-primary", value: "#3b82f6", scope: "color" },
          { token: "color-bg", value: "#ffffff", scope: "color" },
          { token: "color-fg", value: "#0f172a", scope: "color" },
          { token: "color-accent", value: "#6366f1", scope: "color" },
          { token: "font-heading", value: "system-ui, sans-serif", scope: "font" },
          { token: "font-body", value: "system-ui, sans-serif", scope: "font" },
          { token: "space-unit", value: "0.5rem", scope: "space" },
        ]}::jsonb,
        ${actorId}::uuid
      )
      ON CONFLICT (kind, slug) DO NOTHING
    `;
    await tx`
      INSERT INTO structured_sets (kind, slug, display_name, items, updated_by)
      VALUES (
        'tags', 'blog', 'Blog tags',
        ${[]}::jsonb,
        ${actorId}::uuid
      )
      ON CONFLICT (kind, slug) DO NOTHING
    `;
  });
} finally {
  await sql.end();
}

// Never echo the password: even in a dev script, logging a credential in
// clear text is a finding (CodeQL js/clear-text-logging, must-fix per #113).
// The value is the DEV_OWNER_PASSWORD env var (default documented in this
// file's header), so the operator already knows it.
console.log(`dev owner ready: ${EMAIL} (password: $DEV_OWNER_PASSWORD)`);
