// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1140 — the self-hosted scheduler: `bun --bun
 * /app/packages/admin-core/src/scheduler/clock.ts`, the `caelo-scheduler`
 * Compose service (packages/provisioning/src/compose.ts), running the admin
 * image with nothing but this file.
 *
 * Self-hosted has no Cloud Scheduler. This process is its stand-in: every
 * `CAELO_SCHEDULER_INTERVAL_MINUTES` it calls the admin's
 * `POST /api/internal/scheduler/tick` with a fresh internal token (scope
 * `scheduler.tick`, the 5-minute HMAC token of
 * apps/admin/src/lib/server/internal-jwt.ts). It does no work itself and
 * reaches no database: the admin runs the tick inside that request, the
 * same handlers as on every provider. Calls never overlap; a failed call
 * is logged and the next one comes on schedule (the due-table keeps what
 * was not done).
 *
 * Deliberately dependency-free (node built-ins only), so the container
 * loads nothing of the admin it does not need.
 */

const SCOPE = "scheduler.tick";
/** The admin's replay window; a token never outlives it. */
const TOKEN_TTL_MS = 5 * 60 * 1000;
/** A tick holds its request up to its budget (tick.ts) plus one task's lease. */
const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

/** The clock's configuration, from its env. */
export interface ClockConfig {
  readonly tickUrl: string;
  readonly secret: string;
  readonly intervalMinutes: number;
}

/**
 * Read the clock's env; throws naming every problem (no defaults: the
 * Compose file sets all three).
 */
export function clockConfigFromEnv(env: Record<string, string | undefined>): ClockConfig {
  const problems: string[] = [];
  const tickUrl = env.CAELO_SCHEDULER_TICK_URL?.trim() ?? "";
  if (!/^https?:\/\/[^/]+\/api\/internal\/scheduler\/tick$/.test(tickUrl)) {
    problems.push(
      `CAELO_SCHEDULER_TICK_URL must be the admin's http(s)://<host>/api/internal/scheduler/tick, got ${JSON.stringify(tickUrl)}`,
    );
  }
  const secret = env.CAELO_INTERNAL_SECRET ?? "";
  if (secret.length < 32)
    problems.push("CAELO_INTERNAL_SECRET is not set or shorter than 32 characters");
  const raw = env.CAELO_SCHEDULER_INTERVAL_MINUTES?.trim() ?? "";
  const intervalMinutes = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(intervalMinutes >= 1 && intervalMinutes <= 15)) {
    problems.push(
      `CAELO_SCHEDULER_INTERVAL_MINUTES must be a whole number from 1 to 15, got ${JSON.stringify(raw)}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`caelo-scheduler: ${problems.join("; ")} — re-run \`cms-provision up\`.`);
  }
  return { tickUrl, secret, intervalMinutes };
}

/** The admin's internal token for `scope` (same format as internal-jwt.ts). */
export async function mintTickToken(secret: string, now: number = Date.now()): Promise<string> {
  const message = `${now}:${now + TOKEN_TTL_MS}:${SCOPE}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return `${Buffer.from(message).toString("base64url")}.${Buffer.from(sig).toString("base64url")}`;
}

/**
 * Call the tick once.
 *
 * @returns a one-line outcome for the log
 */
export async function callTick(
  config: ClockConfig,
  deps: { readonly fetch?: typeof fetch; readonly now?: () => number } = {},
): Promise<string> {
  const doFetch = deps.fetch ?? fetch;
  const token = await mintTickToken(config.secret, (deps.now ?? Date.now)());
  const res = await doFetch(config.tickUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`tick answered HTTP ${res.status}: ${text.slice(0, 500)}`);
  return text.slice(0, 500);
}

/** Tick now, then every interval; never two calls at once. Runs until the process stops. */
async function main(): Promise<void> {
  const config = clockConfigFromEnv(process.env);
  console.error(
    `[caelo-scheduler] ticking ${config.tickUrl} every ${config.intervalMinutes} minute(s)`,
  );
  const intervalMs = config.intervalMinutes * 60 * 1000;
  for (;;) {
    const started = Date.now();
    try {
      console.error(`[caelo-scheduler] tick: ${await callTick(config)}`);
    } catch (e) {
      console.error(`[caelo-scheduler] tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, intervalMs - (Date.now() - started))));
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`[caelo-scheduler] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
