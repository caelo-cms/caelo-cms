// SPDX-License-Identifier: MPL-2.0

/**
 * `cms-provision backup` / `restore` for a self-hosted Compose install
 * (issue #707).
 *
 * A backup is one `.tar.gz` holding everything an install's content lives
 * in:
 *   manifest.json        format version, Caelo version, timestamp
 *   db/cms_admin.dump    pg_dump -Fc (the same dumps `upgrade` takes)
 *   db/cms_public.dump
 *   db/globals.sql       the cluster's roles — reference only, see restore
 *   files.tar            the published site (`/srv/caelo`) and the uploaded
 *                        media (`/data/media`), read through the admin's
 *                        own mounts
 * Secrets (`.caelo/config.json`, incl. the KEK that decrypts stored
 * provider keys) are NOT in the archive: it may be copied off-host, and a
 * restore targets the install whose config is already there.
 *
 * pg_dump rather than pgBackRest: the old sidecar never had access to the
 * data volume and no stanza was ever created, so it could not back up
 * anything. WAL streaming / point-in-time recovery (CMS_REQUIREMENTS §13.2)
 * needs pgBackRest inside the Postgres image and is tracked separately.
 *
 * Files go through a one-off admin container (`docker compose run`), not
 * the host: the admin writes them as root, which the operator's user may
 * not be able to replace.
 *
 * Backup stops the admin and the gateway for its duration (a short outage):
 * the two databases and the files are separate steps, and a write between
 * them would give an archive whose parts do not match each other.
 *
 * Restore order: list + check the archive and its files.tar WITHOUT
 * extracting (only the expected members, relative paths, no member below a
 * symlink — nothing on the install changes otherwise) → stop the Caelo
 * services → drop + re-create both databases with the role convergence
 * (roles, passwords and grants come from config.json, never from the
 * archive, so a restore cannot reset the superuser's password) →
 * pg_restore → converge again (re-applies the gateway grants the restored
 * functions define) → migrate with the install's admin image (a backup of
 * an older release has its older schema) → replace the files → start
 * everything and health-check it → re-render + reload the Caddyfile from
 * the restored domains table.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { COMPOSE_APP_SERVICES, MEDIA_ROOT, SITE_OUTPUT_ROOT } from "./compose.js";
import type { HostRunner } from "./self-hosted-release.js";
import type { ConvergeOutcome } from "./self-hosted-roles.js";
import {
  compose,
  DATABASE_DUMPS,
  dumpDatabases,
  runMigrations,
  waitHealthy,
} from "./self-hosted-upgrade.js";
import { escapesRoot, listTarEntries, normalizeMemberName, type TarEntry } from "./tar-entries.js";

/** The archive layout's version; a restore refuses any other. */
export const BACKUP_FORMAT = 1;

const MANIFEST = "manifest.json";
const DB_DIR = "db";
const FILES_TAR = "files.tar";

/** The content directories inside the admin container, as `tar -C /` paths. */
const CONTENT_PATHS = [SITE_OUTPUT_ROOT, MEDIA_ROOT].map((p) => p.replace(/^\//, ""));

export interface BackupManifest {
  readonly format: number;
  readonly caeloVersion: string;
  readonly createdAt: string;
}

export interface BackupDeps {
  readonly caeloDir: string;
  readonly runner: HostRunner;
  readonly log: (message: string) => void;
  readonly now?: () => Date;
  readonly healthAttempts?: number;
  readonly healthIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type BackupResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Write a backup archive of the install to `to` (mode 600). Postgres must
 * be running. The admin and the gateway are stopped while it runs and
 * started (and health-checked) again afterwards, whatever the outcome.
 */
export async function backupSelfHosted(
  to: string,
  caeloVersion: string,
  deps: BackupDeps,
): Promise<BackupResult> {
  const { caeloDir, runner, log } = deps;
  const at = (deps.now ?? (() => new Date()))();
  const ready = await runner.run(
    compose(caeloDir, "exec", "-T", "postgres", "pg_isready", "-U", "caelo"),
  );
  if (ready.exitCode !== 0) {
    return {
      ok: false,
      error: `Postgres is not running, so nothing was backed up. Start it with \`docker compose -f ${caeloDir}/docker-compose.yml up -d postgres\` and re-run.`,
    };
  }
  log("Stopping the admin and the gateway for a consistent snapshot …");
  const stop = await runner.run(compose(caeloDir, "stop", ...COMPOSE_APP_SERVICES));
  if (stop.exitCode !== 0) {
    return { ok: false, error: `Could not stop the Caelo services: ${tail(stop.stderr)}` };
  }
  const work = workDir(caeloDir, "backup", at);
  let result: BackupResult;
  try {
    result = await writeArchive(to, caeloVersion, work, deps);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  log("Starting the admin and the gateway again …");
  const started = await startAppServices(deps);
  if (!started.ok) {
    return {
      ok: false,
      error: `${result.ok ? `The backup was written to ${result.path}, but` : `${result.error}\nAlso,`} the services did not come back: ${started.error}`,
    };
  }
  return result;
}

/** The dumps, files.tar and manifest into `work`, then one .tar.gz at `to`. */
async function writeArchive(
  to: string,
  caeloVersion: string,
  work: string,
  deps: BackupDeps,
): Promise<BackupResult> {
  const { caeloDir, runner, log } = deps;
  log("Dumping the databases (pg_dump) …");
  const dumped = await dumpDatabases(caeloDir, runner, join(work, DB_DIR));
  if (!dumped.ok) return { ok: false, error: dumped.error };

  log("Archiving the published site and the uploaded media …");
  const files = await runner.run(
    compose(
      caeloDir,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "tar",
      "caelo-admin",
      "-C",
      "/",
      "-cf",
      "-",
      ...CONTENT_PATHS,
    ),
    { stdoutPath: join(work, FILES_TAR) },
  );
  if (files.exitCode !== 0) {
    return { ok: false, error: `Could not archive the site + media files: ${tail(files.stderr)}` };
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    caeloVersion,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  writeFileSync(join(work, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  log(`Writing ${to} …`);
  // COPYFILE_DISABLE: macOS's bsdtar would add `._*` AppleDouble members
  // for extended attributes, which a restore refuses as unexpected.
  const tar = await runner.run(["tar", "-czf", to, "-C", work, "."], {
    env: { COPYFILE_DISABLE: "1" },
  });
  if (tar.exitCode !== 0) {
    return { ok: false, error: `Could not write ${to}: ${tail(tar.stderr)}` };
  }
  chmodSync(to, 0o600);
  return { ok: true, path: to };
}

/** `up -d` the admin + gateway, then health-check both. */
async function startAppServices(
  deps: BackupDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { caeloDir, runner } = deps;
  const up = await runner.run(compose(caeloDir, "up", "-d", ...COMPOSE_APP_SERVICES));
  if (up.exitCode !== 0)
    return { ok: false, error: `docker compose up failed: ${tail(up.stderr)}` };
  for (const service of ["admin", "gateway"] as const) {
    const healthy = await waitHealthy(service, caeloDir, {
      runner,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.healthAttempts !== undefined ? { healthAttempts: deps.healthAttempts } : {}),
      ...(deps.healthIntervalMs !== undefined ? { healthIntervalMs: deps.healthIntervalMs } : {}),
    });
    if (!healthy.ok) return { ok: false, error: `the ${service} is not healthy: ${healthy.error}` };
  }
  return { ok: true };
}

export interface RestoreDeps extends BackupDeps {
  /** Brings roles, databases and grants in line with config.json (self-hosted-roles.ts). */
  readonly convergeRoles: () => Promise<ConvergeOutcome>;
  /**
   * Re-renders the Caddyfile from the (restored) domains table and reloads
   * Caddy, so the served hosts match the restored database.
   */
  readonly refreshCaddy: () => Promise<{ ok: true } | { ok: false; error: string }>;
}

export type RestoreResult =
  | { ok: true; manifest: BackupManifest }
  | { ok: false; error: string; installChanged: boolean };

/** Replace the install's databases and content files with the backup at `from`. */
export async function restoreSelfHosted(from: string, deps: RestoreDeps): Promise<RestoreResult> {
  const { caeloDir, runner, log } = deps;
  if (!existsSync(from)) return unchanged(`${from} does not exist.`);
  const work = workDir(caeloDir, "restore", (deps.now ?? (() => new Date()))());
  try {
    log(`Checking ${basename(from)} …`);
    const members = checkArchiveMembers(from);
    if (!members.ok) return unchanged(members.error);
    const untar = await runner.run(["tar", "-xzf", from, "-C", work]);
    if (untar.exitCode !== 0) {
      return unchanged(`${from} is not a readable backup archive: ${tail(untar.stderr)}`);
    }
    const checked = checkArchive(work);
    if (!checked.ok) return unchanged(checked.error);
    const files = checkFilesTar(join(work, FILES_TAR));
    if (!files.ok) return unchanged(files.error);

    log("Stopping the admin and the gateway …");
    const stop = await runner.run(compose(caeloDir, "stop", ...COMPOSE_APP_SERVICES));
    if (stop.exitCode !== 0) {
      return unchanged(`Could not stop the Caelo services: ${tail(stop.stderr)}`);
    }
    const pg = await runner.run(compose(caeloDir, "up", "-d", "--wait", "postgres"));
    if (pg.exitCode !== 0) {
      return changed(`Postgres did not become healthy: ${tail(pg.stderr)}`);
    }

    log("Replacing the databases …");
    const drop = await runner.run(
      compose(
        caeloDir,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "caelo",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "DROP DATABASE IF EXISTS cms_admin WITH (FORCE)",
        "-c",
        "DROP DATABASE IF EXISTS cms_public WITH (FORCE)",
      ),
    );
    if (drop.exitCode !== 0) return changed(`Could not drop the databases: ${tail(drop.stderr)}`);
    const created = await deps.convergeRoles();
    if (!created.ok) return changed(`Could not re-create the databases: ${created.error}`);
    for (const db of ["cms_admin", "cms_public"] as const) {
      const r = await runner.run(
        compose(
          caeloDir,
          "exec",
          "-T",
          "postgres",
          "pg_restore",
          "-U",
          "caelo",
          "-d",
          db,
          "--exit-on-error",
          "--single-transaction",
        ),
        { stdinPath: join(work, DB_DIR, DATABASE_DUMPS[db]) },
      );
      if (r.exitCode !== 0) return changed(`pg_restore of ${db} failed: ${tail(r.stderr)}`);
    }
    const granted = await deps.convergeRoles();
    if (!granted.ok) return changed(`Could not re-apply the role grants: ${granted.error}`);
    log("Applying the migrations of the running release …");
    const migrated = await runMigrations(caeloDir, runner);
    if (!migrated.ok) return changed(migrated.error);

    log("Replacing the published site and the uploaded media …");
    const dirs = CONTENT_PATHS.map((p) => `/${p}`).join(" ");
    const replaced = await runner.run(
      compose(
        caeloDir,
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "--entrypoint",
        "sh",
        "caelo-admin",
        "-c",
        `set -e; find ${dirs} -mindepth 1 -delete; tar -C / -xf -`,
      ),
      { stdinPath: join(work, FILES_TAR) },
    );
    if (replaced.exitCode !== 0) {
      return changed(`Could not restore the site + media files: ${tail(replaced.stderr)}`);
    }

    log("Starting everything …");
    const up = await runner.run(compose(caeloDir, "up", "-d", "--remove-orphans"));
    if (up.exitCode !== 0) return changed(`docker compose up failed: ${tail(up.stderr)}`);
    for (const service of ["admin", "gateway"] as const) {
      const healthy = await waitHealthy(service, caeloDir, {
        runner,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.healthAttempts !== undefined ? { healthAttempts: deps.healthAttempts } : {}),
        ...(deps.healthIntervalMs !== undefined ? { healthIntervalMs: deps.healthIntervalMs } : {}),
      });
      if (!healthy.ok)
        return changed(`The ${service} is not healthy after the restore: ${healthy.error}`);
    }
    const caddy = await deps.refreshCaddy();
    if (!caddy.ok)
      return changed(`Could not reload Caddy with the restored domains: ${caddy.error}`);
    return { ok: true, manifest: checked.manifest };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Whether an unpacked archive has every part a restore needs, in a format this CLI reads. */
export function checkArchive(
  dir: string,
): { ok: true; manifest: BackupManifest } | { ok: false; error: string } {
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) {
    return { ok: false, error: "The archive has no manifest.json — it is not a Caelo backup." };
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  } catch (e) {
    return { ok: false, error: `manifest.json is not JSON: ${(e as Error).message}` };
  }
  if (manifest.format !== BACKUP_FORMAT) {
    return {
      ok: false,
      error: `The backup has format ${manifest.format}; this provisioner restores format ${BACKUP_FORMAT}. Use the provisioner of Caelo ${manifest.caeloVersion}.`,
    };
  }
  for (const part of [
    join(DB_DIR, DATABASE_DUMPS.cms_admin),
    join(DB_DIR, DATABASE_DUMPS.cms_public),
    FILES_TAR,
  ]) {
    if (!existsSync(join(dir, part)) || statSync(join(dir, part)).size === 0) {
      return { ok: false, error: `The archive is incomplete: ${part} is missing or empty.` };
    }
  }
  return { ok: true, manifest };
}

/** The members a backup archive may hold — anything else is refused before extraction. */
const ARCHIVE_MEMBERS = new Set([
  "",
  MANIFEST,
  DB_DIR,
  ...Object.values(DATABASE_DUMPS).map((f) => `${DB_DIR}/${f}`),
  FILES_TAR,
]);

/**
 * Whether the .tar.gz at `path` holds only the members a backup writes, as
 * plain files and directories — checked before `tar -x` writes anything.
 */
export function checkArchiveMembers(path: string): { ok: true } | { ok: false; error: string } {
  let entries: TarEntry[];
  try {
    entries = listTarEntries(gunzipSync(readFileSync(path)));
  } catch (e) {
    return {
      ok: false,
      error: `${path} is not a readable backup archive (${(e as Error).message}).`,
    };
  }
  for (const e of entries) {
    const name = normalizeMemberName(e.name);
    if (escapesRoot(e.name) || !ARCHIVE_MEMBERS.has(name)) {
      return {
        ok: false,
        error: `The archive holds an unexpected member ${JSON.stringify(e.name)} — it is not a Caelo backup.`,
      };
    }
    if (e.type !== (name === "" || name === DB_DIR ? "directory" : "file")) {
      return {
        ok: false,
        error: `The archive member ${JSON.stringify(e.name)} is a ${e.type}, not what a Caelo backup writes.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Whether files.tar only writes below the site and media directories:
 * relative paths without `..`, files / directories / relative symlinks
 * inside the tree, and no member below a symlink (which would write
 * wherever the link points).
 */
export function checkFilesTar(path: string): { ok: true } | { ok: false; error: string } {
  let entries: TarEntry[];
  try {
    entries = listTarEntries(readFileSync(path));
  } catch (e) {
    return { ok: false, error: `files.tar is not readable (${(e as Error).message}).` };
  }
  const symlinks: string[] = [];
  const refuse = (e: TarEntry, why: string) => ({
    ok: false as const,
    error: `files.tar member ${JSON.stringify(e.name)} ${why} — the archive is not a Caelo backup.`,
  });
  for (const e of entries) {
    const name = normalizeMemberName(e.name);
    if (escapesRoot(e.name)) return refuse(e, "points outside the content directories");
    if (!CONTENT_PATHS.some((root) => name === root || name.startsWith(`${root}/`))) {
      return refuse(e, "is outside the site and media directories");
    }
    if (symlinks.some((link) => name.startsWith(`${link}/`)))
      return refuse(e, "lies below a symlink");
    if (e.type === "symlink") {
      const target = e.linkTarget ?? "";
      if (target === "" || escapesRoot(target)) return refuse(e, "links outside its directory");
      symlinks.push(name);
    } else if (e.type === "other") {
      return refuse(e, "is not a file, directory or symlink");
    }
  }
  return { ok: true };
}

/** A scratch dir under `.caelo/backups/` (mode 700) — same filesystem, never world-readable. */
function workDir(caeloDir: string, kind: "backup" | "restore", at: Date): string {
  const dir = join(caeloDir, "backups", `.${kind}-${at.toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function unchanged(error: string): RestoreResult {
  return {
    ok: false,
    error: `${error} Nothing on the install was changed.`,
    installChanged: false,
  };
}

function changed(error: string): RestoreResult {
  return { ok: false, error, installChanged: true };
}

function tail(s: string): string {
  return s.trim().split("\n").slice(-5).join("\n").slice(0, 800);
}
