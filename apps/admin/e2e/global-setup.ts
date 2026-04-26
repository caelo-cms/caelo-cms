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
 * the workspace .env; we read it ourselves so `bun run --filter @caelo/admin
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
  import { hashPassword } from "@caelo/admin-core";

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
        INSERT INTO users (id, email, password_hash, is_first_owner)
        VALUES (\${actorId}::uuid, \${email}, \${passwordHash}, false)
      \`;
    }
    await tx\`
      INSERT INTO user_roles (user_id, role_id)
      SELECT \${actorId}::uuid, r.id FROM roles r WHERE r.name = 'owner'
      ON CONFLICT DO NOTHING
    \`;

    await tx\`DELETE FROM rate_limit_buckets WHERE key LIKE 'login:%'\`;
  });
  await sql.end();
`;

export default async function globalSetup(): Promise<void> {
  loadEnvFile();
  if (!process.env["ADMIN_DATABASE_URL"]) {
    throw new Error("ADMIN_DATABASE_URL must be set for Playwright e2e");
  }
  runBun(SETUP_SCRIPT);
}
