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
    // Defensive: existing dev-owner from prior runs may have null
    // onboarded_at after migration 0022; bump it so the post-login
    // redirect to /onboarding doesn't intercept the sweep. Also flip
    // is_first_owner = true so specs that fixture-up state by querying
    // \`WHERE is_first_owner = true LIMIT 1\` (e.g. propose-execute-flow,
    // content-reviewer-readonly) find the dev-owner.
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

    // v0.11.4 (issue #76 follow-up) — seed the post-onboarding state.
    //
    // The dev-owner above claims onboarded_at=now() so /edit doesn't
    // redirect to /onboarding. But "onboarded" without seeding what
    // onboarding PRODUCES (site identity + brand-colored theme) leaves
    // the chat-runner system prompt with no \`## Site identity\` block
    // and a seed-origin theme. Result: AI sees a generic install and
    // produces a generic monochrome page — even when the operator's
    // chat asks for a clearly-branded site like Caelo.
    //
    // A real production user would have gone through /onboarding before
    // their first chat. The seed must mirror that state so e2e tests
    // exercise the real production journey, not a state that only
    // exists because the seed faked onboarded_at.
    //
    // Idempotent UPDATE via COALESCE: only seeds when the columns are
    // still null (post-migration state). Re-running the seed never
    // overwrites an operator's customisation.
    await tx\`
      UPDATE site_defaults
      SET site_name = COALESCE(site_name, 'Caelo'),
          site_purpose = COALESCE(site_purpose,
            'An AI-first content management system for teams that want to ship pages by describing outcomes instead of building modules. Modern, developer-focused, trustworthy.')
      WHERE id = 1
    \`;

    // Mirror onboarding's theme write: indigo primary, display name =
    // site name, description = brand intent, origin = operator. This
    // is what the rewritten /onboarding ?/identity action produces
    // when the operator picks #4f46e5 as their brand color.
    await tx\`
      UPDATE themes
      SET origin = CASE WHEN origin = 'seed' THEN 'operator' ELSE origin END,
          display_name = CASE WHEN display_name = 'Site default' THEN 'Caelo' ELSE display_name END,
          description = COALESCE(description,
            'Indigo primary chosen during onboarding to signal a modern, trustworthy AI-first product for developers.'),
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
