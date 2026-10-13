// SPDX-License-Identifier: MPL-2.0

/**
 * The agent's systemd units (agent/units.ts) and their installation
 * (agent/systemd.ts) — against a temp unit directory and a fake runner, so
 * no real systemd is touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, HostRunner } from "../self-hosted-release.js";
import {
  type AgentHost,
  agentHostProblem,
  agentLogsArgv,
  installAgentUnits,
  installedAgentVersion,
  repinAgentUnits,
  uninstallAgentUnits,
} from "./systemd.js";
import {
  type AgentUnitSpec,
  agentServiceUnit,
  agentTimerUnit,
  agentUnitName,
  pinnedAgentVersion,
} from "./units.js";

const SPEC: AgentUnitSpec = {
  name: "caelo-agent-example-com",
  domain: "example.com",
  version: "0.10.47",
  bunPath: "/home/op/.bun/bin/bun",
  caeloDir: "/srv/caelo site/.caelo",
  workDir: "/srv/caelo site",
  path: "/home/op/.bun/bin:/usr/local/bin:/usr/bin:/bin",
};

describe("agent units", () => {
  it("names one agent per install after its domain", () => {
    expect(agentUnitName("Example.com")).toBe("caelo-agent-example-com");
    expect(agentUnitName("blog.my-site.co.uk")).toBe("caelo-agent-blog-my-site-co-uk");
    expect(() => agentUnitName("...")).toThrow();
  });

  it("runs the pinned CLI as a oneshot, as the user, never as root", () => {
    const unit = agentServiceUnit(SPEC);
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain(
      'ExecStart="/home/op/.bun/bin/bun" "x" "--bun" "@caelo-cms/provisioning@0.10.47" "agent" "run"',
    );
    expect(unit).toContain('WorkingDirectory="/srv/caelo site"');
    expect(unit).toContain('Environment="CAELO_SELF_HOSTED_DIR=/srv/caelo site/.caelo"');
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("NoNewPrivileges=yes");
    expect(unit).not.toMatch(/^User=|^Group=|docker\.sock/m);
    expect(unit).not.toContain("DOCKER_HOST");
    expect(pinnedAgentVersion(unit)).toBe("0.10.47");
  });

  it("passes a rootless DOCKER_HOST through and escapes systemd specifiers", () => {
    const unit = agentServiceUnit({
      ...SPEC,
      dockerHost: "unix:///run/user/1000/docker.sock",
      workDir: "/srv/100%",
    });
    expect(unit).toContain('Environment="DOCKER_HOST=unix:///run/user/1000/docker.sock"');
    expect(unit).toContain('WorkingDirectory="/srv/100%%"');
  });

  it("refuses values that cannot be one systemd word", () => {
    expect(() => agentServiceUnit({ ...SPEC, workDir: '/srv/"x"' })).toThrow();
    expect(() => agentServiceUnit({ ...SPEC, path: "/bin\nExecStartPre=/evil" })).toThrow();
    expect(() => agentServiceUnit({ ...SPEC, version: "latest" })).toThrow();
  });

  it("polls a minute after each run ends, from boot", () => {
    const timer = agentTimerUnit(SPEC);
    expect(timer).toContain("OnUnitInactiveSec=60s");
    expect(timer).toContain("OnBootSec=2min");
    expect(timer).toContain("Unit=caelo-agent-example-com.service");
    expect(timer).toContain("WantedBy=timers.target");
  });

  it("shows the service's journal", () => {
    expect(agentLogsArgv("caelo-agent-x", { lines: 50, follow: true })).toEqual([
      "journalctl",
      "--user",
      "--no-pager",
      "-u",
      "caelo-agent-x.service",
      "-n",
      "50",
      "-f",
    ]);
  });
});

type Rule = (line: string) => Partial<CommandResult> | undefined;

function fakeRunner(rules: Rule[] = []): HostRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(argv) {
      const line = argv.join(" ");
      calls.push(line);
      const hit = rules.map((r) => r(line)).find((r) => r !== undefined);
      return { exitCode: 0, stdout: "", stderr: "", ...hit };
    },
  };
}

describe("agent units on the host", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caelo-agent-units-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const hostWith = (runner: HostRunner, platform: NodeJS.Platform = "linux"): AgentHost => ({
    runner,
    unitDir: join(dir, "systemd", "user"),
    user: "op",
    platform,
  });

  it("supports Linux with a systemd user manager only", async () => {
    expect(await agentHostProblem(hostWith(fakeRunner(), "darwin"))).toContain("Linux");
    const noBus = fakeRunner([
      (l) =>
        l.includes("show-environment")
          ? { exitCode: 1, stderr: "Failed to connect to bus" }
          : undefined,
    ]);
    expect(await agentHostProblem(hostWith(noBus))).toContain("Failed to connect to bus");
    expect(await agentHostProblem(hostWith(fakeRunner()))).toBeNull();
  });

  it("writes both units, enables the timer and switches lingering on — idempotently", async () => {
    const runner = fakeRunner([
      (l) => (l.startsWith("loginctl show-user") ? { stdout: "Linger=no\n" } : undefined),
    ]);
    const host = hostWith(runner);
    for (let i = 0; i < 2; i++) {
      expect(await installAgentUnits(SPEC, host)).toEqual({ ok: true, warnings: [] });
    }
    const service = readFileSync(join(host.unitDir, `${SPEC.name}.service`), "utf8");
    expect(service).toBe(agentServiceUnit(SPEC));
    expect(existsSync(join(host.unitDir, `${SPEC.name}.timer`))).toBe(true);
    expect(runner.calls).toContain("systemctl --user daemon-reload");
    expect(runner.calls).toContain(`systemctl --user enable --now ${SPEC.name}.timer`);
    expect(runner.calls).toContain("loginctl enable-linger op");
    expect(installedAgentVersion(host, SPEC.name)).toBe("0.10.47");
  });

  it("says what an administrator runs when lingering may not be switched on", async () => {
    const runner = fakeRunner([
      (l) =>
        l.startsWith("loginctl enable-linger")
          ? { exitCode: 1, stderr: "Access denied" }
          : undefined,
    ]);
    const r = await installAgentUnits(SPEC, hostWith(runner));
    expect(r.ok && r.warnings.join(" ")).toContain("sudo loginctl enable-linger op");
  });

  it("fails loudly when systemd refuses the timer", async () => {
    const runner = fakeRunner([
      (l) => (l.includes("enable --now") ? { exitCode: 1, stderr: "Unit not found" } : undefined),
    ]);
    const r = await installAgentUnits(SPEC, hostWith(runner));
    expect(r).toEqual({
      ok: false,
      error: `systemctl --user enable --now ${SPEC.name}.timer: Unit not found`,
    });
  });

  it("re-pins an installed agent after an update, and leaves an absent one absent", async () => {
    const runner = fakeRunner();
    const host = hostWith(runner);
    expect(await repinAgentUnits({ ...SPEC, version: "0.11.0" }, host)).toMatchObject({
      ok: true,
      installed: false,
    });
    expect(installedAgentVersion(host, SPEC.name)).toBeNull();
    await installAgentUnits(SPEC, host);
    expect(await repinAgentUnits({ ...SPEC, version: "0.11.0" }, host)).toMatchObject({
      ok: true,
      installed: true,
    });
    expect(installedAgentVersion(host, SPEC.name)).toBe("0.11.0");
  });

  it("uninstalls: timer off, both files gone", async () => {
    const runner = fakeRunner();
    const host = hostWith(runner);
    await installAgentUnits(SPEC, host);
    expect((await uninstallAgentUnits(host, SPEC.name)).ok).toBe(true);
    expect(runner.calls).toContain(`systemctl --user disable --now ${SPEC.name}.timer`);
    expect(existsSync(join(host.unitDir, `${SPEC.name}.service`))).toBe(false);
    expect(existsSync(join(host.unitDir, `${SPEC.name}.timer`))).toBe(false);
  });
});
