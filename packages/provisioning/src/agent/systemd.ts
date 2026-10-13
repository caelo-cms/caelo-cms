// SPDX-License-Identifier: MPL-2.0

/**
 * Installs, re-pins and removes the agent's systemd --user units (#696
 * Phase 4c). Every command goes through a {@link HostRunner} and the unit
 * directory is a parameter, so tests run against a fake and a temp dir —
 * nothing here touches the real systemd of the machine running the tests.
 *
 * User units stop with the user's last session unless the user "lingers";
 * {@link installAgentUnits} turns lingering on (allowed for oneself on
 * systemd-logind's default policy) and, where it may not, says which one
 * command an administrator runs.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostRunner } from "../self-hosted-release.js";
import {
  type AgentUnitSpec,
  agentServiceUnit,
  agentTimerUnit,
  pinnedAgentVersion,
} from "./units.js";

/** The host the units go to. */
export interface AgentHost {
  readonly runner: HostRunner;
  /** `~/.config/systemd/user` (or `$XDG_CONFIG_HOME/systemd/user`). */
  readonly unitDir: string;
  /** The operator's login name (for lingering). */
  readonly user: string;
  readonly platform: NodeJS.Platform;
}

/** The real host: this user's systemd user-unit directory. */
export function currentAgentHost(runner: HostRunner): AgentHost {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return {
    runner,
    unitDir: join(config, "systemd", "user"),
    user: process.env.USER || process.env.LOGNAME || "",
    platform: process.platform,
  };
}

/**
 * Why the agent cannot be installed on this host, or null. Linux with a
 * systemd user manager is the supported target; macOS (Docker Desktop) is
 * a development setup, and there `upgrade` is run by hand.
 */
export async function agentHostProblem(host: AgentHost): Promise<string | null> {
  if (host.platform !== "linux") {
    return `the update agent runs on Linux hosts with systemd (this is ${host.platform}). Install updates with the upgrade command instead.`;
  }
  const r = await host.runner.run(["systemctl", "--user", "show-environment"]);
  if (r.exitCode !== 0) {
    return `systemd's user manager is not reachable (\`systemctl --user\`: ${r.stderr.trim().slice(0, 200) || `exit ${r.exitCode}`}). Log in to the host as this user directly (not via \`su\`), or install updates with the upgrade command.`;
  }
  return null;
}

/** `<unitDir>/<name>.service` + `.timer`. */
export function agentUnitPaths(host: Pick<AgentHost, "unitDir">, name: string) {
  return {
    service: join(host.unitDir, `${name}.service`),
    timer: join(host.unitDir, `${name}.timer`),
  };
}

export type AgentUnitsResult =
  | { readonly ok: true; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string };

async function systemctl(host: AgentHost, ...args: string[]): Promise<string | null> {
  const r = await host.runner.run(["systemctl", "--user", ...args]);
  return r.exitCode === 0
    ? null
    : `systemctl --user ${args.join(" ")}: ${r.stderr.trim().slice(0, 300) || `exit ${r.exitCode}`}`;
}

/**
 * Write both units, reload, enable + start the timer, and make sure the
 * user lingers. Idempotent: re-running rewrites the same files.
 */
export async function installAgentUnits(
  spec: AgentUnitSpec,
  host: AgentHost,
): Promise<AgentUnitsResult> {
  const paths = agentUnitPaths(host, spec.name);
  try {
    mkdirSync(host.unitDir, { recursive: true });
    writeFileSync(paths.service, agentServiceUnit(spec), { mode: 0o644 });
    writeFileSync(paths.timer, agentTimerUnit(spec), { mode: 0o644 });
  } catch (e) {
    return { ok: false, error: `could not write the units: ${(e as Error).message}` };
  }
  for (const args of [["daemon-reload"], ["enable", "--now", `${spec.name}.timer`]]) {
    const error = await systemctl(host, ...args);
    if (error) return { ok: false, error };
  }
  const warnings: string[] = [];
  const linger = await ensureLinger(host);
  if (linger) warnings.push(linger);
  return { ok: true, warnings };
}

/** Lingering on for the user; returns a warning when it could not be. */
async function ensureLinger(host: AgentHost): Promise<string | null> {
  if (!host.user) return "could not tell the user name, so lingering was not checked";
  const show = await host.runner.run(["loginctl", "show-user", host.user, "--property=Linger"]);
  if (show.exitCode === 0 && show.stdout.trim() === "Linger=yes") return null;
  const enable = await host.runner.run(["loginctl", "enable-linger", host.user]);
  if (enable.exitCode === 0) return null;
  return `the agent only runs while ${host.user} is logged in: lingering could not be switched on (${enable.stderr.trim().slice(0, 200) || `exit ${enable.exitCode}`}). Have an administrator run \`sudo loginctl enable-linger ${host.user}\` once.`;
}

/** The release the installed service runs, or null when it is not installed. */
export function installedAgentVersion(host: AgentHost, name: string): string | null {
  const { service } = agentUnitPaths(host, name);
  if (!existsSync(service)) return null;
  return pinnedAgentVersion(readFileSync(service, "utf8"));
}

/**
 * Re-pin an installed agent to `spec.version` (after an update). Does
 * nothing when the agent is not installed.
 */
export async function repinAgentUnits(
  spec: AgentUnitSpec,
  host: AgentHost,
): Promise<AgentUnitsResult & { readonly installed?: boolean }> {
  const { service } = agentUnitPaths(host, spec.name);
  if (!existsSync(service)) return { ok: true, warnings: [], installed: false };
  try {
    writeFileSync(service, agentServiceUnit(spec), { mode: 0o644 });
  } catch (e) {
    return { ok: false, error: `could not rewrite ${service}: ${(e as Error).message}` };
  }
  const error = await systemctl(host, "daemon-reload");
  return error ? { ok: false, error } : { ok: true, warnings: [], installed: true };
}

/** Stop + disable the timer and delete both units. */
export async function uninstallAgentUnits(
  host: AgentHost,
  name: string,
): Promise<AgentUnitsResult> {
  const warnings: string[] = [];
  const disabled = await systemctl(host, "disable", "--now", `${name}.timer`);
  if (disabled) warnings.push(disabled);
  const paths = agentUnitPaths(host, name);
  rmSync(paths.service, { force: true });
  rmSync(paths.timer, { force: true });
  const reload = await systemctl(host, "daemon-reload");
  if (reload) warnings.push(reload);
  return { ok: true, warnings };
}

/** `systemctl --user status` of both units (text for the terminal). */
export async function agentUnitStatus(host: AgentHost, name: string): Promise<string> {
  const r = await host.runner.run([
    "systemctl",
    "--user",
    "--no-pager",
    "status",
    `${name}.timer`,
    `${name}.service`,
  ]);
  // status exits 3 for an inactive oneshot service; the text is what matters.
  return (r.stdout || r.stderr).trim();
}

/** The argv that shows the agent's log (journald). */
export function agentLogsArgv(name: string, opts: { lines: number; follow: boolean }): string[] {
  return [
    "journalctl",
    "--user",
    "--no-pager",
    "-u",
    `${name}.service`,
    "-n",
    String(opts.lines),
    ...(opts.follow ? ["-f"] : []),
  ];
}
