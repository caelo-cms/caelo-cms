// SPDX-License-Identifier: MPL-2.0

/**
 * Playwright globalSetup: runs once before any spec.
 *
 * 1. Seeds (or refreshes) the `dev-owner@example.com` account so every spec
 *    has a known login without depending on whatever rows happen to be in
 *    the dev DB.
 * 2. Clears the per-IP login rate-limit bucket so back-to-back runs do not
 *    trip the 5-per-5-minutes cap.
 *
 * Both steps run inside one Bun subprocess — Playwright runs under Node and
 * cannot import `bun` directly. ADMIN_DATABASE_URL flows through env.
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
function loadEnvFile(): void {
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

function runBun(script: string, extraEnv: Record<string, string> = {}): void {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const result = spawnSync("bun", ["-e", script], { env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `globalSetup bun -e failed (status ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
}

const SETUP_SCRIPT = `
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
  });
  await sql.end();
`;

export default async function globalSetup(): Promise<void> {
  loadEnvFile();
  if (!process.env.ADMIN_DATABASE_URL) {
    throw new Error("ADMIN_DATABASE_URL must be set for Playwright e2e");
  }
  runBun(SETUP_SCRIPT);
}
