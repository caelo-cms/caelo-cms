// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSE_APP_SERVICES } from "./compose.js";
import {
  BACKUP_FORMAT,
  backupSelfHosted,
  checkArchive,
  checkArchiveMembers,
  checkFilesTar,
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

/** Like the admin container's GNU tar: no macOS AppleDouble members. */
const NO_MAC = { env: { COPYFILE_DISABLE: "1" } };

interface Call {
  readonly cmd: string;
  readonly opts?: HostRunOptions;
}

/** A real tar of `files` (path → content, `->target` makes a symlink), built in `scratch`. */
async function makeTar(files: Record<string, string>, out: string, gzip = false): Promise<void> {
  const root = mkdtempSync(join(scratch, "tar-src-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    if (content.startsWith("->")) symlinkSync(content.slice(2), full);
    else writeFileSync(full, content);
  }
  const r = await bunHostRunner.run(["tar", gzip ? "-czf" : "-cf", out, "-C", root, "."], NO_MAC);
  if (r.exitCode !== 0) throw new Error(r.stderr);
}

/** A files.tar like the admin container writes (members `srv/caelo/…`, `data/media/…`). */
async function contentTar(out: string): Promise<void> {
  const root = mkdtempSync(join(scratch, "content-"));
  mkdirSync(join(root, "srv/caelo/output/production/current"), { recursive: true });
  mkdirSync(join(root, "data/media"), { recursive: true });
  writeFileSync(join(root, "srv/caelo/output/production/current/index.html"), "<h1>home</h1>");
  writeFileSync(join(root, "data/media/logo.png"), "png");
  const r = await bunHostRunner.run(
    ["tar", "-cf", out, "-C", root, "srv/caelo", "data/media"],
    NO_MAC,
  );
  if (r.exitCode !== 0) throw new Error(r.stderr);
}

/**
 * Docker is faked (every call recorded, dumps written as stand-in bytes,
 * the file archive as a real tar); host `tar` runs for real, so the archive
 * round-trip and its checks are the real ones.
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
      if (opts?.stdoutPath) {
        if (cmd.includes("--entrypoint tar")) await contentTar(opts.stdoutPath);
        else writeFileSync(opts.stdoutPath, `stand-in for: ${cmd}`);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

const AT = new Date("2026-10-14T12:00:00.000Z");
const quiet = { log: () => {}, now: () => AT };
const probe = (cmds: string[]) => cmds.map((c) => c.replace(/ -e .*/, " -e <probe>"));

describe("backupSelfHosted", () => {
  it("quiesces the services, dumps, archives site + media, writes one mode-600 .tar.gz, restarts", async () => {
    const r = runner();
    const to = join(scratch, "b.tar.gz");
    const out = await backupSelfHosted(to, "0.10.49", { caeloDir, runner: r, ...quiet });
    expect(out).toEqual({ ok: true, path: to });
    expect(probe(r.calls.map((c) => c.cmd))).toEqual([
      "exec -T postgres pg_isready -U caelo",
      "stop caelo-admin caelo-gateway",
      "exec -T postgres pg_dumpall -U caelo --globals-only",
      "exec -T postgres pg_dump -U caelo -Fc cms_admin",
      "exec -T postgres pg_dump -U caelo -Fc cms_public",
      "run --rm --no-deps -T --entrypoint tar caelo-admin -C / -cf - srv/caelo data/media",
      "up -d caelo-admin caelo-gateway",
      "exec -T caelo-admin bun -e <probe>",
      "exec -T caelo-gateway bun -e <probe>",
    ]);
    expect(statSync(to).mode & 0o777).toBe(0o600);
    // The scratch dir is gone; only the archive remains.
    expect(readdirSync(join(caeloDir, "backups"))).toEqual([]);
    expect(checkArchiveMembers(to)).toEqual({ ok: true });

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

  it("starts the services again when the backup itself fails", async () => {
    const r = runner((c) => c.includes("pg_dump -U caelo -Fc cms_public"));
    const out = await backupSelfHosted(join(scratch, "b.tar.gz"), "0.10.49", {
      caeloDir,
      runner: r,
      ...quiet,
    });
    expect(out.ok).toBe(false);
    expect(r.calls.map((c) => c.cmd)).toContain("up -d caelo-admin caelo-gateway");
  });

  it("refuses when Postgres is not running and changes nothing", async () => {
    const r = runner((c) => c.includes("pg_isready"));
    const to = join(scratch, "b.tar.gz");
    const out = await backupSelfHosted(to, "0.10.49", { caeloDir, runner: r, ...quiet });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("Postgres is not running");
    expect(existsSync(to)).toBe(false);
    expect(r.calls).toHaveLength(1);
  });
});

/** A real backup archive made by backupSelfHosted with the fake docker. */
async function makeArchive(): Promise<string> {
  const to = join(scratch, "b.tar.gz");
  const made = await backupSelfHosted(to, "0.10.49", { caeloDir, runner: runner(), ...quiet });
  if (!made.ok) throw new Error(made.error);
  return to;
}

function restoreDeps(r: HostRunner & { calls: Call[] }) {
  return {
    caeloDir,
    runner: r,
    ...quiet,
    convergeRoles: async () => {
      r.calls.push({ cmd: "<converge roles>" });
      return { ok: true as const };
    },
    refreshCaddy: async () => {
      r.calls.push({ cmd: "<re-render + reload Caddyfile>" });
      return { ok: true as const };
    },
  };
}

const MIGRATE =
  "run --rm --no-deps -T caelo-admin bun --bun /app/packages/migrations/src/migrate.ts";

describe("restoreSelfHosted", () => {
  it("restores in order: stop, re-create + restore the DBs, migrate, files, start, health, Caddy", async () => {
    const archive = await makeArchive();
    const r = runner();
    const out = await restoreSelfHosted(archive, restoreDeps(r));
    expect(out.ok).toBe(true);
    expect(probe(r.calls.map((c) => c.cmd))).toEqual([
      "stop caelo-admin caelo-gateway",
      "up -d --wait postgres",
      "exec -T postgres psql -U caelo -d postgres -v ON_ERROR_STOP=1 -c DROP DATABASE IF EXISTS cms_admin WITH (FORCE) -c DROP DATABASE IF EXISTS cms_public WITH (FORCE)",
      "<converge roles>",
      "exec -T postgres pg_restore -U caelo -d cms_admin --exit-on-error --single-transaction",
      "exec -T postgres pg_restore -U caelo -d cms_public --exit-on-error --single-transaction",
      "<converge roles>",
      `${MIGRATE} admin`,
      `${MIGRATE} public`,
      "run --rm --no-deps -T --entrypoint sh caelo-admin -c set -e; find /srv/caelo /data/media -mindepth 1 -delete; tar -C / -xf -",
      "up -d --remove-orphans",
      "exec -T caelo-admin bun -e <probe>",
      "exec -T caelo-gateway bun -e <probe>",
      "<re-render + reload Caddyfile>",
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
    await restoreSelfHosted(archive, restoreDeps(r));
    const stop = r.calls.find((c) => c.cmd.startsWith("stop "));
    expect(stop?.cmd).toBe(`stop ${COMPOSE_APP_SERVICES.join(" ")}`);
    expect(r.calls.some((c) => /orchestrator|runner/.test(c.cmd))).toBe(false);
  });

  it("leaves the install untouched when the archive is incomplete", async () => {
    const archive = join(scratch, "partial.tar.gz");
    await makeTar(
      {
        "manifest.json": JSON.stringify({
          format: BACKUP_FORMAT,
          caeloVersion: "x",
          createdAt: "y",
        }),
        "db/cms_admin.dump": "x",
      },
      archive,
      true,
    );
    const r = runner();
    const out = await restoreSelfHosted(archive, restoreDeps(r));
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
    const out = await restoreSelfHosted(
      archive,
      restoreDeps(runner((c) => c.includes("pg_restore -U caelo -d cms_public"))),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.installChanged).toBe(true);
      expect(out.error).toContain("pg_restore of cms_public failed");
    }
  });
});

describe("archive checks run before anything is extracted (PR #755 review)", () => {
  it("refuses an archive with a member a backup never writes, and extracts nothing", async () => {
    const archive = join(scratch, "evil.tar.gz");
    await makeTar(
      {
        "manifest.json": JSON.stringify({
          format: BACKUP_FORMAT,
          caeloVersion: "x",
          createdAt: "y",
        }),
        "db/cms_admin.dump": "x",
        "db/cms_public.dump": "x",
        "files.tar": "x",
        "etc/cron.d/backdoor": "* * * * * root sh",
      },
      archive,
      true,
    );
    const members = checkArchiveMembers(archive);
    expect(members.ok).toBe(false);
    if (!members.ok) expect(members.error).toMatch(/unexpected member "\.\/etc/);
    const r = runner();
    const out = await restoreSelfHosted(archive, restoreDeps(r));
    expect(out.ok).toBe(false);
    expect(r.calls).toEqual([]);
    expect(existsSync(join(caeloDir, "backups"))).toBe(true);
    expect(readdirSync(join(caeloDir, "backups"))).toEqual([]);
  });

  it("refuses a symlink where a backup writes a file", async () => {
    const archive = join(scratch, "link.tar.gz");
    await makeTar({ "manifest.json": "->/etc/passwd" }, archive, true);
    const r = checkArchiveMembers(archive);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("is a symlink");
  });

  it("files.tar: only the site and media trees, no member below a symlink", async () => {
    const ok = join(scratch, "ok.tar");
    await contentTar(ok);
    expect(checkFilesTar(ok)).toEqual({ ok: true });

    const outside = join(scratch, "outside.tar");
    await makeTar({ "app/server.js": "evil" }, outside);
    const o = checkFilesTar(outside);
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.error).toContain("outside the site and media directories");

    const viaLink = join(scratch, "via-link.tar");
    const root = mkdtempSync(join(scratch, "via-"));
    mkdirSync(join(root, "srv/caelo"), { recursive: true });
    symlinkSync("/app", join(root, "srv/caelo/x"));
    await bunHostRunner.run(["tar", "-cf", viaLink, "-C", root, "srv/caelo"], NO_MAC);
    const l = checkFilesTar(viaLink);
    expect(l.ok).toBe(false);
    if (!l.ok) expect(l.error).toContain("links outside its directory");
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
