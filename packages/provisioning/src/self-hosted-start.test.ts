// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { CommandResult, HostRunner } from "./self-hosted-release.js";
import { startSelfHosted } from "./self-hosted-start.js";

const DIR = "/srv/install/.caelo";

/** A runner that records every command (minus the `docker compose -f <file>` prefix). */
function fakeRunner(
  fail?: (cmd: string) => boolean,
  services = "postgres\ncaddy\ncaelo-admin\ncaelo-gateway\n",
): HostRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(argv): Promise<CommandResult> {
      const cmd = argv.join(" ").replace(`docker compose -f ${DIR}/docker-compose.yml `, "");
      calls.push(cmd);
      const stdout = cmd === "config --services" ? services : "";
      return { exitCode: fail?.(cmd) ? 1 : 0, stdout, stderr: fail?.(cmd) ? "boom" : "" };
    },
  };
}

const MIGRATE =
  "run --rm --no-deps -T caelo-admin bun --bun /app/packages/migrations/src/migrate.ts";

describe("startSelfHosted (#707 — one command ends with a serving install)", () => {
  it("pulls, starts Postgres, migrates, starts everything, then health-checks both services", async () => {
    const runner = fakeRunner();
    const r = await startSelfHosted({ caeloDir: DIR, runner, log: () => {} });
    expect(r).toEqual({ ok: true });
    expect(runner.calls.map((c) => c.replace(/ -e .*/, " -e <probe>"))).toEqual([
      "pull",
      "up -d --wait postgres",
      `${MIGRATE} admin`,
      `${MIGRATE} public`,
      `${MIGRATE} public-staging`,
      "up -d --remove-orphans",
      "config --services",
      "exec -T caelo-admin bun -e <probe>",
      "exec -T caelo-gateway bun -e <probe>",
      "exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile",
    ]);
  });

  it("#1328 — health-checks the MCP-Auth-Proxy too when the release runs one", async () => {
    const runner = fakeRunner(undefined, "caelo-admin\ncaelo-gateway\ncaelo-mcp-auth-proxy\n");
    const r = await startSelfHosted({ caeloDir: DIR, runner, log: () => {} });
    expect(r).toEqual({ ok: true });
    const probe = runner.calls.find((c) => c.startsWith("exec -T caelo-mcp-auth-proxy bun -e "));
    expect(probe).toContain("/api/mcp/health");
  });

  it("#1328 — reports an unhealthy MCP-Auth-Proxy with where to look", async () => {
    const runner = fakeRunner(
      (c) => c.startsWith("exec -T caelo-mcp-auth-proxy"),
      "caelo-admin\ncaelo-gateway\ncaelo-mcp-auth-proxy\n",
    );
    const r = await startSelfHosted({
      caeloDir: DIR,
      runner,
      log: () => {},
      healthAttempts: 1,
      sleep: async () => {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("health");
      expect(r.error).toContain("logs caelo-mcp-auth-proxy");
    }
  });

  it("stops at a failed migration — nothing else is started", async () => {
    const runner = fakeRunner((c) => c.endsWith("migrate.ts admin"));
    const r = await startSelfHosted({ caeloDir: DIR, runner, log: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("migrate");
      expect(r.error).toContain("admin migrations failed");
    }
    expect(runner.calls).not.toContain("up -d --remove-orphans");
  });

  it("reports an unhealthy admin with where to look", async () => {
    const runner = fakeRunner((c) => c.startsWith("exec -T caelo-admin"));
    const r = await startSelfHosted({
      caeloDir: DIR,
      runner,
      log: () => {},
      healthAttempts: 2,
      sleep: async () => {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("health");
      expect(r.error).toContain("logs caelo-admin");
    }
  });
});
