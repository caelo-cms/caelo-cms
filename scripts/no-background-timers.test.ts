// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1140 — the admin only does work inside a request. Periodic work
 * runs on the scheduler tick (`POST /api/internal/scheduler/tick`, admin-core
 * `scheduler/`), plugin workers included, so it runs on the CPU a request is
 * billed for and never relies on an idle instance (CLAUDE.md §11.B Tier 5).
 *
 * This static scan lists every server-side source of the admin that starts
 * an interval timer (`setInterval`) or a firing cron job (a croner `Cron`
 * with a callback). The list must match {@link ALLOWED} exactly: a new
 * background loop fails here until someone decides it belongs — and the
 * answer is almost always a task on the tick instead. An entry that no
 * longer starts a timer fails too, so the list stays the truth.
 *
 * Allowed are timers scoped to a request or an operation that runs anyway
 * (a stream's keep-alive, a lease renewed while its work runs), and the
 * loops whose move has a tracked issue (`FIXME`-style entries naming it).
 * Browser code has its own guard (scripts/no-timer-polling.test.ts).
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Server-side sources that may start an interval timer, and why each may. */
const ALLOWED: Record<string, string> = {
  // Request- or operation-scoped: the timer lives exactly as long as work
  // that runs on a request's CPU anyway.
  "apps/admin/src/routes/(authed)/content/chat/[sessionId]/stream/+server.ts":
    "the chat stream's SSE keep-alive and heartbeat, cleared when the stream closes",
  "apps/admin/src/routes/(authed)/settings/gateway/live/+server.ts":
    "the gateway live view's SSE stream, cleared when the client disconnects",
  "packages/admin-core/src/ai/chat-runner/agent-runs.ts":
    "a running agent's heartbeat (and stop check), cleared when the run ends",
  "packages/admin-core/src/ai/chat-runner/turn-serializer.ts":
    "a running chat turn's lease heartbeat, cleared when the turn ends",
  "packages/admin-core/src/deploy/deploy-run-lock.ts":
    "a deploy run's lease renewal while the run works",
  "packages/admin-core/src/deploy/redirect-sync.ts":
    "the redirect sync's lease renewal while it pushes to the provider",
  "packages/admin-core/src/ops/security/mcp_power.ts":
    "a long Power-MCP tool call keeps its agent listed while the call runs",
  "packages/admin-core/src/reporting-jobs/run-job.ts":
    "a reporting job's lease renewal while its attempt runs (in the job's container; inside the admin only on self-hosted and development installs), cleared when the attempt ends",
  "packages/plugin-host/src/activation-lock.ts":
    "a plugin activation's lock renewal while the activation runs",
  "packages/plugin-host/src/change-consumers.ts":
    "a change consumer's claim renewal while its drain runs (a hint: the commit takes the claim back, #1361)",
  "packages/plugin-host/src/runtime-health.ts":
    "the plugin runtime heartbeat's renewal while an admin request is in flight (a chat turn, a Stage, a tick), stopped with the last one (#1361)",
  // Dev and test runs only: no scheduler calls them.
  "apps/admin/src/hooks.server.ts":
    "the dev/test scheduler clock (bootstrapDevSchedulerClock): never with NODE_ENV=production, where the install's scheduler calls the tick",
  // Tracked moves (#1140 follow-ups).
  "packages/admin-core/src/site-import/crawl-worker.ts":
    "FIXME(issue #1360): the site-import crawl moves into a container job that reports back",
};

const ROOTS = [
  "apps/admin/src",
  "packages/admin-core/src",
  "packages/plugin-host/src",
  "packages/query-api/src",
  "packages/site-importer/src",
  "packages/migrations/src",
];

/** In apps/admin only server code runs in the admin process. */
function isServerSource(path: string): boolean {
  if (!path.endsWith(".ts") || path.endsWith(".d.ts")) return false;
  if (/\.(test|bench|browser)\.ts$/.test(path) || /\/__tests__\//.test(path)) return false;
  if (!path.startsWith("apps/admin/")) return true;
  return (
    /(^|\/)lib\/server\//.test(path) || /\.server\.ts$/.test(path) || /\+server\.ts$/.test(path)
  );
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else out.push(path);
  }
  return out;
}

/**
 * An interval timer, or a croner job given a callback on the same line (a
 * pattern-only `Cron` fires nothing).
 */
const TIMER = /\bsetInterval\s*\(|\bnew\s+Cron\s*\([^;\n]*(=>|\bfunction\b)/;

const SCANNED = ROOTS.flatMap((root) => sources(resolve(REPO_ROOT, root)))
  .map((path) => relative(REPO_ROOT, path))
  .filter(isServerSource)
  .map((path) => ({ path, text: readFileSync(resolve(REPO_ROOT, path), "utf8") }));

describe("no background timer does the admin's work (#1140)", () => {
  it("scans the real sources", () => {
    expect(SCANNED.length).toBeGreaterThan(300);
    expect(SCANNED.some((s) => s.path === "apps/admin/src/hooks.server.ts")).toBe(true);
  });

  it("only the reviewed sources start an interval timer or a firing cron job", () => {
    const found = SCANNED.filter((s) => TIMER.test(s.text))
      .map((s) => s.path)
      .sort();
    expect(found).toEqual(Object.keys(ALLOWED).sort());
  });

  it("recognises the shapes it guards against", () => {
    expect(TIMER.test("handle = setInterval(() => sweep(), 60_000);")).toBe(true);
    expect(TIMER.test("new Cron(w.cron, { paused: false }, async () => run())")).toBe(true);
    // A pattern evaluator never fires (plugin-host/scheduler.ts).
    expect(TIMER.test("pattern: new Cron(w.cron, { paused: true }),")).toBe(false);
    expect(TIMER.test("setTimeout(resolve, 50)")).toBe(false);
  });

  it("the dev clock never runs in production", () => {
    const hooks = SCANNED.find((s) => s.path === "apps/admin/src/hooks.server.ts")?.text ?? "";
    expect(hooks).toContain('process.env.NODE_ENV === "production"');
    // Its only interval is the dev clock's.
    expect(hooks.match(/\bsetInterval\s*\(/g)).toHaveLength(1);
    expect(hooks).toMatch(/setInterval\(tick, DEV_CLOCK_INTERVAL_MS\)/);
  });

  it("plugin workers run from the tick, never from a timer per plugin", () => {
    const scheduler = SCANNED.find((s) => s.path === "packages/plugin-host/src/scheduler.ts")?.text;
    expect(scheduler).toBeDefined();
    expect(TIMER.test(scheduler ?? "")).toBe(false);
    expect(scheduler).toContain("paused: true");
  });

  it("the plugin host keeps nothing current on an idle timer: request start and the tick do (#1361)", () => {
    const text = (path: string) => SCANNED.find((s) => s.path === path)?.text ?? "";
    // The plugin-row sync starts no timer at all.
    expect(text("packages/plugin-host/src/reconcile.ts")).not.toMatch(
      /\bset(Interval|Timeout)\s*\(/,
    );
    // The heartbeat's one interval is the renewal a request in flight holds
    // (holdRuntimeHeartbeat, released by the admin's handle when the
    // response body ends); it has no timeout either. A sub-request holds
    // nothing: its body may go unread, and a hold it took would never end.
    const health = text("packages/plugin-host/src/runtime-health.ts");
    expect(health.match(/\bsetInterval\s*\(/g)).toEqual(["setInterval("]);
    expect(health).not.toMatch(/\bsetTimeout\s*\(/);
    expect(health).toMatch(/export function holdRuntimeHeartbeat\(\)[\s\S]*?setInterval\(/);
    const hooks = text("apps/admin/src/hooks.server.ts");
    expect(hooks).toContain("const release = holdRuntimeHeartbeat();");
    expect(hooks).toContain("releaseWhenSent(await handleRequest(input), release)");
    expect(hooks).toContain("if (input.event.isSubRequest) return handleRequest(input);");
    // The change consumers' only timeout is a wake-up's 50 ms coalescing,
    // which runs on the CPU of whatever woke it; a retry rides the next
    // request start or tick instead of a timer.
    expect(
      text("packages/plugin-host/src/change-consumers.ts").match(/\bsetTimeout\s*\(/g),
    ).toEqual(["setTimeout("]);
    expect(text("packages/plugin-host/src/request-start.ts")).toContain(
      "resumeDueChangeConsumers()",
    );
  });
});
