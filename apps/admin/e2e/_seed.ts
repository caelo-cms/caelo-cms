// SPDX-License-Identifier: MPL-2.0

/**
 * Shared dev-owner + `ai_providers` seed for the Playwright suites.
 *
 * Both `apps/admin/e2e/global-setup.ts` (mock-AI fixture suite) and
 * `apps/admin/e2e-livedit/global-setup.ts` (real-AI suite, issue #47)
 * import this so the dev-owner credentials + the placeholder
 * `ai_providers` row are produced by exactly one code path.
 *
 * The seeded `ai_providers` row carries a dummy encryption triplet
 * (`decode('00', 'hex')` × 2 + `'e2e-seed'` fingerprint). The existing
 * mock-AI suite never decrypts (it routes through the
 * `x-caelo-test-provider` header path); the real-AI suite relies on
 * provider-resolver's env-var fallback (`process.env.ANTHROPIC_API_KEY`)
 * which fires after secret-box throws on the dummy bytes — neither
 * suite touches secret-box decryption.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Best-effort .env loader. Playwright runs under Node and does not auto-load
 * the workspace .env; we read it ourselves so `bun run --filter @caelo-cms/admin
 * e2e` works without a separate `bun --env-file` wrapper.
 */
export function loadEnvFile(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "../../../.env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function runBun(script: string, extraEnv: Record<string, string> = {}): void {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const result = spawnSync("bun", ["-e", script], { env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `globalSetup bun -e failed (status ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
}

export const SETUP_SCRIPT = `
  import { SQL } from "bun";
  import { hashPassword } from "@caelo-cms/admin-core";

  const email = "dev-owner@example.com";
  const password = "dev owner password";
  const passwordHash = await hashPassword(password);

  const sql = new SQL(process.env.ADMIN_DATABASE_URL);
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");

    const existing = await tx\`SELECT id::text AS id FROM users WHERE email = \${email}\`;
    let actorId;
    if (existing[0]) {
      actorId = existing[0].id;
      await tx\`UPDATE users SET password_hash = \${passwordHash}, deleted_at = NULL WHERE id = \${actorId}::uuid\`;
    } else {
      const actor = await tx\`
        INSERT INTO actors (kind, display_name) VALUES ('human', 'Dev Owner')
        RETURNING id::text AS id
      \`;
      actorId = actor[0].id;
      await tx\`
        INSERT INTO users (id, email, password_hash, is_first_owner, onboarded_at)
        VALUES (\${actorId}::uuid, \${email}, \${passwordHash}, true, now())
      \`;
    }
    // Defensive: flip is_first_owner = true so specs that fixture-up
    // state by querying \`WHERE is_first_owner = true LIMIT 1\` (e.g.
    // propose-execute-flow, content-reviewer-readonly) find the dev-
    // owner.
    //
    // v0.11.4 (issue #76 follow-up) — the post-login /onboarding
    // redirect was removed (Caelo is chat-first per CLAUDE.md §1A —
    // operator opens /edit and describes outcomes, AI captures site
    // identity via \`set_site_identity\`). The \`onboarded_at\` bump
    // here is harmless but no longer load-bearing; left in place so
    // specs that read the column see a stable value.
    await tx\`
      UPDATE users
      SET onboarded_at = COALESCE(onboarded_at, now()),
          is_first_owner = true
      WHERE email = \${email}
    \`;
    await tx\`
      INSERT INTO user_roles (user_id, role_id)
      SELECT \${actorId}::uuid, r.id FROM roles r WHERE r.name = 'owner'
      ON CONFLICT DO NOTHING
    \`;

    await tx\`DELETE FROM rate_limit_buckets WHERE key LIKE 'login:%'\`;

    // Seed an active AI provider so the post-login first-run gate at
    // /(authed)/+layout.server.ts (which calls ai_providers.any_configured)
    // doesn't redirect every test off / to /security/ai?firstRun=1. The
    // encryption triplet is dummy bytea/text — the e2e suite uses the
    // in-memory test provider registered via POST /__test/providers, so
    // these bytes are never actually decrypted. All three encryption
    // fields must travel together (ai_providers_key_triplet_consistent
    // check constraint added in migration 0052), hence the NOT NULL set.
    await tx\`
      INSERT INTO ai_providers (name, display_name, is_active,
                                api_key_encrypted, api_key_iv, api_key_kek_fp,
                                api_key_set_at)
      VALUES ('anthropic', 'Anthropic (e2e seed)', true,
              decode('00', 'hex'), decode('00', 'hex'), 'e2e-seed',
              now())
      ON CONFLICT (name) DO UPDATE SET
        is_active = EXCLUDED.is_active,
        api_key_encrypted = EXCLUDED.api_key_encrypted,
        api_key_iv = EXCLUDED.api_key_iv,
        api_key_kek_fp = EXCLUDED.api_key_kek_fp,
        api_key_set_at = EXCLUDED.api_key_set_at
    \`;

    // An image-capable Google provider so generate_image has a target
    // (Anthropic — the chat primary — can't do images). The key resolves
    // via GOOGLE_GENERATIVE_AI_API_KEY in env (the same env fallback the
    // chat uses over the dummy-encrypted config), so the encrypted triplet
    // stays dummy. imageModel = Nano Banana (gemini-2.5-flash-image).
    await tx\`
      INSERT INTO ai_providers (name, display_name, is_active, config,
                                api_key_encrypted, api_key_iv, api_key_kek_fp,
                                api_key_set_at)
      VALUES ('google', 'Google (e2e image seed)', true,
              '{"imageModel":"gemini-2.5-flash-image"}'::jsonb,
              decode('00', 'hex'), decode('00', 'hex'), 'e2e-seed',
              now())
      ON CONFLICT (name) DO UPDATE SET
        is_active = EXCLUDED.is_active,
        config = EXCLUDED.config,
        api_key_encrypted = EXCLUDED.api_key_encrypted,
        api_key_iv = EXCLUDED.api_key_iv,
        api_key_kek_fp = EXCLUDED.api_key_kek_fp,
        api_key_set_at = EXCLUDED.api_key_set_at
    \`;

    // v0.11.4 (issue #76 follow-up) — NO post-onboarding state seeded
    // here. Caelo is chat-first per CLAUDE.md §1A: the AI captures site
    // identity (\`set_site_identity\`) and evolves the theme (\`set_theme_tokens\`)
    // from the operator's first chat prompt. The e2e-livedit scenarios
    // exercise that cold-start path. Mock-AI suites that don't need
    // to test cold-start call \`POST_CHAT_SEED_SCRIPT\` AFTER this one
    // to populate the post-AI-chat state so cold-start gates don't fire.
  });
  await sql.end();
`;

/**
 * v0.11.4 (issue #76 follow-up) — fast-forward the install past the
 * cold-start state so mock-AI tests that don't exercise the chat-first
 * setup path aren't blocked by the cold-start gate on
 * build_page / add_module_to_page / add_module_to_layout
 * (etc.).
 *
 * Real-AI scenarios (e2e-livedit) should NOT call this — they need
 * cold-start state to exercise `set_site_identity` + `set_theme_tokens`.
 *
 * Mirrors what the AI's cold-start sequence would have produced on its
 * first chat: site identity captured, theme origin flipped to
 * `operator` (the actor that seeds state in this script), indigo
 * primary so theme-aware modules render in brand colors.
 *
 * Idempotent via COALESCE + WHERE origin='seed'. Re-running never
 * overwrites operator-customised state.
 *
 * #112 self-heal: if NO active theme exists (the table was emptied —
 * e.g. by a pre-fix test-preload truncation, or a hand-wiped dev DB),
 * re-create the post-chat state directly: an active operator-origin
 * theme with a described indigo document. Inline jsonb literals, not
 * parameters — Bun.SQL string params into jsonb columns double-encode
 * (stored as a JSON string), which breaks jsonb_set and ->> reads.
 */
export const POST_CHAT_SEED_SCRIPT = `
  import { SQL } from "bun";
  const sql = new SQL(process.env.ADMIN_DATABASE_URL);
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx\`
      UPDATE site_defaults
      SET site_name = COALESCE(site_name, 'Caelo'),
          site_purpose = COALESCE(site_purpose,
            'A content management system built around an AI co-editor. Modern, developer-focused, trustworthy.')
      WHERE id = 1
    \`;
    await tx.unsafe(\`
      INSERT INTO themes (slug, display_name, description, origin, is_active, tokens)
      SELECT 'site-default', 'Caelo',
             'Indigo primary chosen during setup to signal a modern, trustworthy AI-first product for developers.',
             'operator', true,
             '{
               "color": {
                 "background": {"$type": "color", "$value": "#ffffff"},
                 "foreground": {"$type": "color", "$value": "#0a0a0a"},
                 "primary": {"$type": "color", "$value": "#4f46e5"},
                 "primary-foreground": {"$type": "color", "$value": "#eef2ff"},
                 "secondary": {"$type": "color", "$value": "#f5f5f5"},
                 "secondary-foreground": {"$type": "color", "$value": "#171717"},
                 "accent": {"$type": "color", "$value": "#f5f5f5"},
                 "accent-foreground": {"$type": "color", "$value": "#171717"},
                 "muted": {"$type": "color", "$value": "#f5f5f5"},
                 "muted-foreground": {"$type": "color", "$value": "#737373"},
                 "card": {"$type": "color", "$value": "#ffffff"},
                 "card-foreground": {"$type": "color", "$value": "#0a0a0a"},
                 "border": {"$type": "color", "$value": "#e5e5e5"},
                 "ring": {"$type": "color", "$value": "#4f46e5"},
                 "destructive": {"$type": "color", "$value": "#dc2626"},
                 "destructive-foreground": {"$type": "color", "$value": "#fafafa"}
               },
               "typography": {
                 "body": {"$type": "typography", "$value": {"fontFamily": "system-ui, sans-serif", "fontSize": "1rem", "fontWeight": 400, "lineHeight": 1.5}},
                 "heading": {"$type": "typography", "$value": {"fontFamily": "system-ui, sans-serif", "fontSize": "1.875rem", "fontWeight": 700, "lineHeight": 1.2}},
                 "mono": {"$type": "typography", "$value": {"fontFamily": "ui-monospace, monospace", "fontSize": "0.875rem", "fontWeight": 400, "lineHeight": 1.5}}
               },
               "spacing": {
                 "xs": {"$type": "dimension", "$value": "0.25rem"},
                 "sm": {"$type": "dimension", "$value": "0.5rem"},
                 "md": {"$type": "dimension", "$value": "1rem"},
                 "lg": {"$type": "dimension", "$value": "1.5rem"},
                 "xl": {"$type": "dimension", "$value": "2rem"},
                 "2xl": {"$type": "dimension", "$value": "3rem"}
               },
               "radius": {
                 "sm": {"$type": "dimension", "$value": "0.25rem"},
                 "md": {"$type": "dimension", "$value": "0.5rem"},
                 "lg": {"$type": "dimension", "$value": "0.75rem"}
               }
             }'::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM themes WHERE is_active = true)
      ON CONFLICT (slug) DO NOTHING
    \`);
    await tx\`
      UPDATE themes SET is_active = true
      WHERE slug = 'site-default'
        AND NOT EXISTS (SELECT 1 FROM themes WHERE is_active = true)
    \`;
    await tx\`
      UPDATE themes
      SET origin = CASE WHEN origin = 'seed' THEN 'operator' ELSE origin END,
          display_name = CASE WHEN display_name = 'Site default' THEN 'Caelo' ELSE display_name END,
          description = COALESCE(description,
            'Indigo primary chosen during setup to signal a modern, trustworthy AI-first product for developers.'),
          tokens = jsonb_set(
            tokens,
            '{color,primary}',
            '{"$type": "color", "$value": "#4f46e5"}'::jsonb
          )
      WHERE is_active = true
        AND origin = 'seed'
    \`;
  });
  await sql.end();
`;
