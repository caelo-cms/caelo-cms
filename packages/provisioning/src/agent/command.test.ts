// SPDX-License-Identifier: MPL-2.0

/**
 * The agent's database side on a running install (#721 maintainer
 * decision): Postgres restarts once — on the first agent install, announced
 * first — and never again once it publishes the agent's loopback port.
 */

import { describe, expect, it } from "bun:test";
import type { CommandResult, HostRunner } from "../self-hosted-release.js";
import { applyDatabaseSide, POSTGRES_RESTART_NOTICE } from "./command.js";

function runner(published: string | null): HostRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(argv): Promise<CommandResult> {
      const line = argv.join(" ");
      calls.push(line);
      if (line.endsWith("port postgres 5432")) {
        return published === null
          ? { exitCode: 1, stdout: "", stderr: "no port" }
          : { exitCode: 0, stdout: `${published}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

const ctx = { caeloDir: "/srv/.caelo", convergeRoles: async () => ({ ok: true as const }) };

describe("applyDatabaseSide", () => {
  it("skips the restart when Postgres already publishes the agent's port (re-run)", async () => {
    const r = runner("127.0.0.1:15432");
    const notices: string[] = [];
    expect(await applyDatabaseSide(ctx, r, 15432, { notice: (m) => notices.push(m) })).toEqual({
      ok: true,
      restarted: false,
    });
    expect(r.calls.some((c) => c.includes(" up -d postgres"))).toBe(false);
    expect(notices).toEqual([]);
  });

  it("restarts Postgres once, after the notice, on the first install", async () => {
    const r = runner(null);
    const notices: string[] = [];
    const out = await applyDatabaseSide(ctx, r, 15432, {
      notice: (m) => notices.push(m),
      sleep: async () => {},
    });
    expect(out).toEqual({ ok: true, restarted: true });
    expect(notices).toEqual([POSTGRES_RESTART_NOTICE]);
    expect(POSTGRES_RESTART_NOTICE).toContain("Postgres restarts once, a few seconds of downtime");
    expect(r.calls.filter((c) => c.includes(" up -d postgres"))).toHaveLength(1);
  });

  it("restarts when the port is published elsewhere than the configured one", async () => {
    const r = runner("127.0.0.1:15433");
    const out = await applyDatabaseSide(ctx, r, 15432, { notice: () => {}, sleep: async () => {} });
    expect(out).toEqual({ ok: true, restarted: true });
  });

  it("does not touch Postgres when the login cannot be created", async () => {
    const r = runner(null);
    const out = await applyDatabaseSide(
      {
        ...ctx,
        convergeRoles: async () => ({ ok: false as const, reachable: true, error: "denied" }),
      },
      r,
      15432,
      { notice: () => {} },
    );
    expect(out.ok).toBe(false);
    expect(r.calls).toEqual([]);
  });
});
