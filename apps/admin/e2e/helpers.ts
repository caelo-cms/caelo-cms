// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";

/**
 * Playwright runs under Node — we cannot import `bun` here directly. This
 * helper spawns a small Bun subprocess so test fixtures can use Bun's native
 * SQL driver (and any `@caelo-cms/admin-core` helpers it pulls in).
 */
/**
 * Runs a Bun-runtime script with optional extra env vars. Pass user-supplied
 * values through `extraEnv` and read them via `process.env.X` inside the
 * script — splicing them directly into the script string is unsafe and
 * confuses Bun's SQL tagged-template parser.
 *
 * `bun -e <script>` (not `bun run -e`) is the correct invocation; `bun run`
 * expects a file or package.json script name.
 *
 * @returns the script's stdout, for a script that reports a value.
 */
export function runBunInline(script: string, extraEnv: Record<string, string> = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const result = spawnSync("bun", ["-e", script], { env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`bun -e failed (status ${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * Clears the per-IP login rate-limit bucket. globalSetup clears it once at
 * suite start; per-spec login attempts in a long batch run can re-fill it,
 * so chat specs that login from multiple browser contexts call this in
 * test.beforeAll.
 */
export function clearLoginRateBucket(): void {
  runBunInline(`
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx\`DELETE FROM rate_limit_buckets WHERE key LIKE 'login:%'\`;
    });
    await sql.end();
  `);
}

/**
 * Resets the dev-owner's edit_overlay_layout user_preference so live-edit
 * specs don't inherit a viewport-busting drag from a previous run. Without
 * this, persisted x/y can land the overlay outside the 1280×720 Playwright
 * viewport — the chat composer is rendered but offscreen, and Send-button
 * clicks time out with "element is outside of the viewport".
 *
 * RLS on user_preferences scopes by `caelo.actor_id`, so the cleanup needs
 * to set actor_id to dev-owner explicitly — system kind alone doesn't pass
 * the per-user policy.
 */
export function resetOverlayLayoutFor(email: string): void {
  runBunInline(
    `
    import { SQL } from "bun";
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const u = await tx\`SELECT id::text AS id FROM users WHERE email = \${process.env.EMAIL}\`;
      if (u.length === 0) return;
      await tx.unsafe(\`SET LOCAL caelo.actor_id = '\${u[0].id}'\`);
      await tx\`DELETE FROM user_preferences WHERE key = 'edit_overlay_layout'\`;
    });
    await sql.end();
    `,
    { EMAIL: email },
  );
}

/**
 * P5.2 #1 — register a per-spec fixture provider in the running admin
 * process. Pass any unique `name` (typically `${spec}-${Date.now()}`)
 * and the SSE endpoint will resolve it via `x-caelo-test-provider`.
 *
 * Returns the same name so callers can pass it straight to fetch.
 */
export async function registerTestProvider(
  baseURL: string,
  name: string,
  events: unknown[] | unknown[][],
  /** Multi-step fixtures: hold each step this long (a turn still running when a test acts). */
  stepDelayMs = 0,
): Promise<string> {
  const res = await fetch(`${baseURL}/__test/providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, events, ...(stepDelayMs > 0 ? { stepDelayMs } : {}) }),
  });
  if (!res.ok) {
    throw new Error(`registerTestProvider failed: ${res.status} ${await res.text()}`);
  }
  return name;
}

export async function clearTestProvider(baseURL: string, name: string): Promise<void> {
  await fetch(`${baseURL}/__test/providers?name=${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

/**
 * Wires a Playwright BrowserContext so every chat-stream POST carries
 * the `x-caelo-test-provider: <name>` header. Lives on the context, not
 * the global state, so two specs can run in parallel without colliding.
 */
import type { BrowserContext } from "@playwright/test";

export async function attachTestProviderHeader(ctx: BrowserContext, name: string): Promise<void> {
  await ctx.route(/\/content\/chat\/[^/]+\/stream$/, async (route) => {
    const req = route.request();
    const headers = { ...req.headers(), "x-caelo-test-provider": name };
    await route.continue({ headers });
  });
}

/** Password of every {@link ensureIsolatedOwner} account. */
export const ISOLATED_OWNER_PASSWORD = "isolated owner password";

/**
 * Issue #665 — an Owner account of the spec's own. Live Edit resumes the
 * operator's most recent chat, and an external agent working in a chat
 * keeps the Live Edit AI out of it for a while; a spec that drives an
 * external agent (or a long turn) as the shared dev-owner would therefore
 * land in a parallel spec's Live Edit chat. Its own Owner keeps it apart.
 *
 * @returns the account's actor id.
 */
export function ensureIsolatedOwner(email: string): string {
  return runBunInline(
    `
    import { SQL } from "bun";
    import { hashPassword } from "@caelo-cms/admin-core";
    const email = process.env.OWNER_EMAIL;
    const passwordHash = await hashPassword(process.env.OWNER_PASSWORD);
    const sql = new SQL(process.env.ADMIN_DATABASE_URL);
    const id = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // Parallel workers seed the same account: serialize on the email.
      await tx\`SELECT pg_advisory_xact_lock(hashtext(\${email}))\`;
      const existing = await tx\`SELECT id::text AS id FROM users WHERE email = \${email}\`;
      let actorId = existing[0]?.id;
      if (actorId) {
        await tx\`UPDATE users SET password_hash = \${passwordHash}, deleted_at = NULL WHERE id = \${actorId}::uuid\`;
      } else {
        const actor = await tx\`INSERT INTO actors (kind, display_name) VALUES ('human', \${email}) RETURNING id::text AS id\`;
        actorId = actor[0].id;
        await tx\`INSERT INTO users (id, email, password_hash, onboarded_at)
                 VALUES (\${actorId}::uuid, \${email}, \${passwordHash}, now())\`;
      }
      await tx\`INSERT INTO user_roles (user_id, role_id)
               SELECT \${actorId}::uuid, r.id FROM roles r WHERE r.name = 'owner'
               ON CONFLICT DO NOTHING\`;
      return actorId;
    });
    process.stdout.write(id);
    await sql.end();
    `,
    { OWNER_EMAIL: email, OWNER_PASSWORD: ISOLATED_OWNER_PASSWORD },
  ).trim();
}

/** Mint an admin-scoped Power-MCP token for `actorId`; returns the plaintext. */
export function mintAdminMcpToken(actorId: string, displayName: string): string {
  return runBunInline(
    `
    import { DatabaseAdapter, OperationRegistry, execute } from "@caelo-cms/query-api";
    import { registerAdminOps } from "@caelo-cms/admin-core";
    const adapter = new DatabaseAdapter({ adminDatabaseUrl: process.env.ADMIN_DATABASE_URL, publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL });
    const registry = new OperationRegistry(); registerAdminOps(registry);
    const r = await execute(registry, adapter, { actorId: process.env.ACTOR_ID, actorKind: "human", requestId: "e2e-mint-mcp" }, "mcp_tokens.create", { displayName: process.env.DISPLAY_NAME, scope: "admin" });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    process.stdout.write(r.value.plaintextToken);
    await adapter.close();
    `,
    { ACTOR_ID: actorId, DISPLAY_NAME: displayName },
  ).trim();
}
