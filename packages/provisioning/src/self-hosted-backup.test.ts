// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSE_APP_SERVICES } from "./compose.js";
import {
  BACKUP_FORMAT,
  backupSelfHosted,
  checkArchive,
  restoreSelfHosted,
} from "./self-hosted-backup.js";
import {
  bunHostRunner,
  type CommandResult,
  type HostRunner,
  type HostRunOptions,
} from "./self-hosted-release.js";

let caeloDir: string;
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "caelo-backup-test-"));
  caeloDir = join(scratch, ".caelo");
  mkdirSync(caeloDir);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

interface Call {
  readonly cmd: string;
  readonly opts?: HostRunOptions;
}

/**
 * Docker is faked (every call recorded, dumps written as stand-in bytes);
 * host `tar` runs for real, so the archive round-trip is the real one.
 */
function runner(fail?: (cmd: string) => boolean): HostRunner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(argv, opts): Promise<CommandResult> {
      if (argv[0] === "tar") return bunHostRunner.run(argv, opts);
      const cmd = argv.join(" ").replace(`docker compose -f ${caeloDir}/docker-compose.yml `, "");
      calls.push({ cmd, ...(opts ? { opts } : {}) });
      if (fail?.(cmd)) return { exitCode: 1, stdout: "", stderr: "boom" };
      if (opts?.stdoutPath) writeFileSync(opts.stdoutPath, `stand-in for: ${cmd}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

const AT = new Date("2026-10-14T12:00:00.000Z");
const quiet = { log: () => {}, now: () => AT };

describe("backupSelfHosted", () => {
  it("dumps both databases, archives site + media through the admin, writes one mode-600 .tar.gz", async () => {
    const r = runner();
    const to = join(scratch, "b.tar.gz");
    const out = await backupSelfHosted(to, "0.10.49", { caeloDir, runner: r, ...quiet });
    expect(out).toEqual({ ok: true, path: to });
    expect(r.calls.map((c) => c.cmd)).toEqual([
      "exec -T postgres pg_isready -U caelo",
      "exec -T postgres pg_dumpall -U caelo --globals-only",
      "exec -T postgres pg_dump -U caelo -Fc cms_admin",
      "exec -T postgres pg_dump -U caelo -Fc cms_public",
      "run --rm --no-deps -T --entrypoint tar caelo-admin -C / -cf - srv/caelo data/media",
    ]);
    expect(statSync(to).mode & 0o777).toBe(0o600);
    // The scratch dir is gone; only the archive remains.
    expect(readdirSync(join(caeloDir, "backups"))).toEqual([]);

    const unpacked = join(scratch, "unpacked");
    mkdirSync(unpacked);
    await bunHostRunner.run(["tar", "-xzf", to, "-C", unpacked]);
    const checked = checkArchive(unpacked);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.manifest).toEqual({
        format: BACKUP_FORMAT,
        caeloVersion: "0.10.49",
        createdAt: AT.toISOString(),
      });
    }
    expect(existsSync(join(unpacked, "db", "globals.sql"))).toBe(true);
  });

  it("refuses when Postgres is not running and writes nothing", async () => {
    const r = runner((c) => c.includes("pg_isready"));
    const to = join(scratch, "b.tar.gz");
    const out = await backupSelfHosted(to, "0.10.49", { caeloDir, runner: r, ...quiet });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("Postgres is not running");
    expect(existsSync(to)).toBe(false);
  });
});

/** A real backup archive made by backupSelfHosted with the fake docker. */
async function makeArchive(): Promise<string> {
  const to = join(scratch, "b.tar.gz");
  const made = await backupSelfHosted(to, "0.10.49", { caeloDir, runner: runner(), ...quiet });
  if (!made.ok) throw new Error(made.error);
  return to;
}

describe("restoreSelfHosted", () => {
  it("restores in order: stop the Caelo services, re-create + restore the databases, files, start, health", async () => {
    const archive = await makeArchive();
    const r = runner();
    let converged = 0;
    const out = await restoreSelfHosted(archive, {
      caeloDir,
      runner: r,
      ...quiet,
      convergeRoles: async () => {
        converged++;
        r.calls.push({ cmd: "<converge roles>" });
        return { ok: true };
      },
    });
    expect(out.ok).toBe(true);
    expect(converged).toBe(2);
    const cmds = r.calls.map((c) => c.cmd.replace(/ -e .*/, " -e <probe>"));
    expect(cmds).toEqual([
      "stop caelo-admin caelo-gateway",
      "up -d --wait postgres",
      "exec -T postgres psql -U caelo -d postgres -v ON_ERROR_STOP=1 -c DROP DATABASE IF EXISTS cms_admin WITH (FORCE) -c DROP DATABASE IF EXISTS cms_public WITH (FORCE)",
      "<converge roles>",
      "exec -T postgres pg_restore -U caelo -d cms_admin --exit-on-error --single-transaction",
      "exec -T postgres pg_restore -U caelo -d cms_public --exit-on-error --single-transaction",
      "<converge roles>",
      "run --rm --no-deps -T --entrypoint sh caelo-admin -c set -e; find /srv/caelo /data/media -mindepth 1 -delete; tar -C / -xf -",
      "up -d --remove-orphans",
      "exec -T caelo-admin bun -e <probe>",
      "exec -T caelo-gateway bun -e <probe>",
    ]);
    // pg_restore and the file restore read the archive's parts on stdin.
    const stdin = r.calls.filter((c) => c.opts?.stdinPath).map((c) => c.opts?.stdinPath ?? "");
    expect(stdin.map((p) => p.split("/").slice(-2).join("/"))).toEqual([
      "db/cms_admin.dump",
      "db/cms_public.dump",
      expect.stringMatching(/files\.tar$/),
    ]);
  });

  it("stops only services the Compose file defines — no orchestrator / runner (#707)", async () => {
    const archive = await makeArchive();
    const r = runner();
    await restoreSelfHosted(archive, {
      caeloDir,
      runner: r,
      ...quiet,
      convergeRoles: async () => ({ ok: true }),
    });
    const stop = r.calls.find((c) => c.cmd.startsWith("stop "));
    expect(stop?.cmd).toBe(`stop ${COMPOSE_APP_SERVICES.join(" ")}`);
    expect(r.calls.some((c) => /orchestrator|runner/.test(c.cmd))).toBe(false);
  });

  it("leaves the install untouched when the archive is incomplete", async () => {
    const parts = join(scratch, "parts");
    mkdirSync(join(parts, "db"), { recursive: true });
    writeFileSync(
      join(parts, "manifest.json"),
      JSON.stringify({ format: BACKUP_FORMAT, caeloVersion: "x", createdAt: "y" }),
    );
    writeFileSync(join(parts, "db", "cms_admin.dump"), "x");
    const archive = join(scratch, "partial.tar.gz");
    await bunHostRunner.run(["tar", "-czf", archive, "-C", parts, "."]);
    const r = runner();
    const out = await restoreSelfHosted(archive, {
      caeloDir,
      runner: r,
      ...quiet,
      convergeRoles: async () => ({ ok: true }),
    });
    expect(out).toEqual({
      ok: false,
      installChanged: false,
      error:
        "The archive is incomplete: db/cms_public.dump is missing or empty. Nothing on the install was changed.",
    });
    expect(r.calls).toEqual([]);
  });

  it("reports a failed pg_restore as a partial restore", async () => {
    const archive = await makeArchive();
    const out = await restoreSelfHosted(archive, {
      caeloDir,
      runner: runner((c) => c.includes("pg_restore -U caelo -d cms_public")),
      ...quiet,
      convergeRoles: async () => ({ ok: true }),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.installChanged).toBe(true);
      expect(out.error).toContain("pg_restore of cms_public failed");
    }
  });
});

describe("checkArchive", () => {
  it("refuses a directory that is not a Caelo backup, and another format", () => {
    const dir = join(scratch, "x");
    mkdirSync(dir);
    expect(checkArchive(dir)).toEqual({
      ok: false,
      error: "The archive has no manifest.json — it is not a Caelo backup.",
    });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ format: 99, caeloVersion: "9.9.9", createdAt: "" }),
    );
    const r = checkArchive(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("format 99");
  });
});
