// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";

/**
 * Playwright runs under Node — we cannot import `bun` here directly. This
 * helper spawns a small Bun subprocess so test fixtures can use Bun's native
 * SQL driver (and any `@caelo/admin-core` helpers it pulls in).
 */
/**
 * Runs a Bun-runtime script with optional extra env vars. Pass user-supplied
 * values through `extraEnv` and read them via `process.env.X` inside the
 * script — splicing them directly into the script string is unsafe and
 * confuses Bun's SQL tagged-template parser.
 *
 * `bun -e <script>` (not `bun run -e`) is the correct invocation; `bun run`
 * expects a file or package.json script name.
 */
export function runBunInline(script: string, extraEnv: Record<string, string> = {}): void {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const result = spawnSync("bun", ["-e", script], { env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`bun -e failed (status ${result.status}): ${result.stderr || result.stdout}`);
  }
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
): Promise<string> {
  const res = await fetch(`${baseURL}/__test/providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, events }),
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
