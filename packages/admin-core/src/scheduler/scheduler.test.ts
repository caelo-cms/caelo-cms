// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1140 — the scheduler's pure parts: which tasks a tick knows, the
 * plugin workers it turns into tasks, and the self-hosted clock's config and
 * token. The tick against Postgres: __tests__/scheduler-tick.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import type { ScheduledWorker } from "@caelo-cms/plugin-host";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { BugIntakeClient } from "../bug-forwarding/client.js";
import { SCHEDULED_TASK_KEY } from "../ops/scheduled_tasks.js";
import { callTick, clockConfigFromEnv, mintTickToken } from "./clock.js";
import { coreScheduledTasks } from "./core-tasks.js";
import { pluginWorkerTaskKey, pluginWorkerTasks } from "./plugin-workers.js";

const deps = (over: Partial<Parameters<typeof coreScheduledTasks>[0]> = {}) => ({
  adapter: {} as DatabaseAdapter,
  registry: {} as OperationRegistry,
  projectionPublisher: () => null,
  bugIntake: {} as BugIntakeClient,
  releaseCheck: { readManifest: async () => null, provider: "gcp" },
  autoUpdate: {
    upgrader: () => ({ ok: true as const, trigger: null }),
    converge: () => ({ ok: true as const, trigger: null }),
    readManifest: async () => null,
    provider: "gcp",
    holder: "h",
  },
  ...over,
});

describe("coreScheduledTasks", () => {
  it("carries the maintainer's due-table defaults, every-tick tasks first", () => {
    const tasks = coreScheduledTasks(deps());
    const cadence = Object.fromEntries(
      tasks.map((t) => [t.key, "everySeconds" in t.cadence ? t.cadence.everySeconds : "cron"]),
    );
    expect(cadence).toEqual({
      "core:projection-backstop": 0,
      "core:redirect-sync-retry": 0,
      "core:bug-forwarding-send": 0,
      "core:mail-outbox": 0,
      "core:reporting-jobs": 0,
      "core:plugin-data-build": 300,
      "core:update-scheduler": 900,
      "core:release-check": 3600,
      "core:rate-limit-gc": 3600,
      "core:change-journal-gc": 3600,
      "core:bug-forwarding-status": 21_600,
      "core:proposal-gc": 86_400,
      "core:chat-image-gc": 86_400,
      "core:reporting-jobs-gc": 86_400,
    });
    for (const t of tasks) expect(SCHEDULED_TASK_KEY.test(t.key)).toBe(true);
  });

  it("leaves out the release check and the update scheduler when they are off (test runs)", () => {
    const keys = coreScheduledTasks(deps({ releaseCheck: null, autoUpdate: null })).map(
      (t) => t.key,
    );
    expect(keys).not.toContain("core:release-check");
    expect(keys).not.toContain("core:update-scheduler");
  });

  it("the projection backstop fails loudly when the publisher never started", async () => {
    const backstop = coreScheduledTasks(deps()).find((t) => t.key === "core:projection-backstop");
    await expect(backstop?.run() ?? Promise.resolve()).rejects.toThrow(/did not start/);
  });
});

function worker(over: Partial<ScheduledWorker> = {}): ScheduledWorker & { calls: number } {
  const w = {
    pluginSlug: "newsletter",
    workerName: "drain_sends",
    cron: "0 * * * * *",
    operationName: "_drain_sends",
    active: true,
    calls: 0,
    nextAfter: (from: Date) => new Date(from.getTime() + 60_000),
    run: async () => {
      w.calls += 1;
    },
    ...over,
  };
  return w;
}

describe("pluginWorkerTasks (#1140 category C)", () => {
  it("turns each active worker into a cron task keyed by plugin and worker", async () => {
    const w = worker();
    const [task, ...rest] = pluginWorkerTasks([
      w,
      worker({ pluginSlug: "ratings", active: false }),
    ]);
    expect(rest).toEqual([]);
    expect(task?.key).toBe("plugin:newsletter/drain_sends");
    const from = new Date("2026-11-02T10:00:30Z");
    expect("nextAfter" in (task?.cadence ?? {}) && task?.cadence.nextAfter(from)).toEqual(
      new Date("2026-11-02T10:01:30Z"),
    );
    await task?.run();
    expect(w.calls).toBe(1);
  });

  it("reports a worker whose name cannot be a key instead of dropping it silently", () => {
    const lines: string[] = [];
    const tasks = pluginWorkerTasks([worker({ workerName: "a/b" })], (l) => lines.push(l));
    expect(tasks).toEqual([]);
    expect(lines.join("\n")).toContain("newsletter/a/b does not run");
  });

  it("keys match the due-table's shape", () => {
    expect(SCHEDULED_TASK_KEY.test(pluginWorkerTaskKey(worker()))).toBe(true);
    expect(
      SCHEDULED_TASK_KEY.test(
        pluginWorkerTaskKey({ pluginSlug: "consent-manager", workerName: "consent-embed-scan" }),
      ),
    ).toBe(true);
  });
});

describe("the self-hosted clock", () => {
  const env = {
    CAELO_SCHEDULER_TICK_URL: "http://caelo-admin:3000/api/internal/scheduler/tick",
    CAELO_INTERNAL_SECRET: "x".repeat(40),
    CAELO_SCHEDULER_INTERVAL_MINUTES: "5",
  };

  it("reads its env", () => {
    expect(clockConfigFromEnv(env)).toEqual({
      tickUrl: env.CAELO_SCHEDULER_TICK_URL,
      secret: env.CAELO_INTERNAL_SECRET,
      intervalMinutes: 5,
    });
  });

  it("refuses an interval outside 1–15 minutes, a short secret and another URL, naming each", () => {
    for (const minutes of ["0", "16", "2.5", ""]) {
      expect(() =>
        clockConfigFromEnv({ ...env, CAELO_SCHEDULER_INTERVAL_MINUTES: minutes }),
      ).toThrow(/CAELO_SCHEDULER_INTERVAL_MINUTES/);
    }
    expect(() =>
      clockConfigFromEnv({
        CAELO_SCHEDULER_TICK_URL: "http://caelo-admin:3000/api/other",
        CAELO_INTERNAL_SECRET: "short",
        CAELO_SCHEDULER_INTERVAL_MINUTES: "5",
      }),
    ).toThrow(/CAELO_SCHEDULER_TICK_URL.*CAELO_INTERNAL_SECRET/);
  });

  it("signs the scope scheduler.tick with a 5-minute expiry", async () => {
    const token = await mintTickToken("x".repeat(40), 1_000);
    const [message] = token.split(".");
    expect(Buffer.from(message ?? "", "base64url").toString()).toBe("1000:301000:scheduler.tick");
  });

  it("posts the token and throws on a refusal", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const config = clockConfigFromEnv(env);
    expect(await callTick(config, { fetch: ok })).toBe('{"ok":true}');
    expect(seen[0]?.url).toBe(env.CAELO_SCHEDULER_TICK_URL);
    expect(seen[0]?.auth).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const refused = (async () =>
      new Response('{"ok":false,"error":"expired"}', { status: 401 })) as unknown as typeof fetch;
    await expect(callTick(config, { fetch: refused })).rejects.toThrow(/HTTP 401/);
  });
});
