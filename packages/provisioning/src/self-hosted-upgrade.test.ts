// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseImages } from "./compose.js";
import {
  type CommandResult,
  type HostRunner,
  readRelease,
  recordRelease,
} from "./self-hosted-release.js";
import {
  composePath,
  legacyComposePath,
  type UpgradeLog,
  upgradeSelfHosted,
} from "./self-hosted-upgrade.js";

const OLD_DIGEST = { admin: `sha256:${"1".repeat(64)}`, gateway: `sha256:${"2".repeat(64)}` };
const OLD: ReleaseImages = {
  mode: "release",
  admin: `ghcr.io/caelo-cms/admin@${OLD_DIGEST.admin}`,
  gateway: `ghcr.io/caelo-cms/gateway@${OLD_DIGEST.gateway}`,
};
const NEW_DIGEST = { admin: `sha256:${"a".repeat(64)}`, gateway: `sha256:${"b".repeat(64)}` };
const NEW: ReleaseImages = {
  mode: "release",
  admin: `ghcr.io/caelo-cms/admin@${NEW_DIGEST.admin}`,
  gateway: `ghcr.io/caelo-cms/gateway@${NEW_DIGEST.gateway}`,
};

/** A stand-in for generateDockerCompose: just the two image lines. */
const render = (images: ReleaseImages) => `admin: ${images.admin}\ngateway: ${images.gateway}\n`;

/** GHCR fake: the anonymous token dance, then `digests` per repository. */
function registryServing(digests: { admin: string; gateway: string }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) return Response.json({ tag_name: "v0.11.0" });
    if (url.startsWith("https://ghcr.io/token")) return Response.json({ token: "t" });
    if (!new Headers(init?.headers).get("authorization")) {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
      });
    }
    const service = url.includes("/caelo-cms/admin/") ? "admin" : "gateway";
    return new Response(null, {
      status: 200,
      headers: { "docker-content-digest": digests[service] },
    });
  }) as typeof fetch;
}
const registry = registryServing(NEW_DIGEST);

type Rule = (argv: string) => Partial<CommandResult> | undefined;

/** Records every host command; `rules` decide the outcome (default: success). */
function fakeRunner(rules: Rule[] = []): HostRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(argv, opts) {
      const line = argv.join(" ");
      calls.push(line);
      const hit = rules.map((r) => r(line)).find((r) => r !== undefined);
      const result = { exitCode: 0, stdout: "", stderr: "", ...hit };
      if (opts?.stdoutPath && result.exitCode === 0) writeFileSync(opts.stdoutPath, "DUMP");
      return result;
    },
  };
}

/** A compact label per call, for asserting the order of the steps. */
function steps(calls: readonly string[]): string[] {
  return calls.map((c) => {
    if (c.startsWith("cosign verify"))
      return `verify ${c.includes("/admin@") ? "admin" : "gateway"}`;
    if (c.startsWith("cosign")) return "cosign-probe";
    if (c.includes("pg_isready")) return "pg_isready";
    if (c.includes("pg_dumpall")) return "dump globals";
    if (c.includes("pg_dump ")) return `dump ${c.split(" ").at(-1)}`;
    if (c.includes(" pull ")) return "pull";
    if (c.includes("migrate.ts")) return `migrate ${c.split(" ").at(-1)}`;
    if (c.includes(" up -d --no-deps caelo-admin caelo-gateway")) return "up both";
    if (c.includes(" up -d --no-deps ")) return `up ${c.split(" ").at(-1)}`;
    if (c.includes("/_caelo/health")) return "health admin";
    if (c.includes("/healthz")) return "health gateway";
    return c;
  });
}

let dir: string;
let messages: string[];
const log: UpgradeLog = {
  step: (m) => messages.push(`step ${m}`),
  info: (m) => messages.push(`info ${m}`),
  warn: (m) => messages.push(`warn ${m}`),
  error: (m) => messages.push(`error ${m}`),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caelo-sh-upgrade-"));
  messages = [];
  recordRelease(
    dir,
    { version: "0.10.0", images: OLD },
    { from: null, to: "0.10.0", outcome: "installed" },
  );
  writeFileSync(composePath(dir), render(OLD));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(runner: HostRunner) {
  return {
    caeloDir: dir,
    runner,
    renderCompose: render,
    log,
    fetchImpl: registry,
    sleep: async () => {},
    healthAttempts: 3,
    healthIntervalMs: 0,
    now: () => new Date("2026-10-13T12:00:00Z"),
  };
}

describe("upgradeSelfHosted", () => {
  it("verifies, backs up, pulls, migrates, then rolls admin before gateway", async () => {
    const runner = fakeRunner();
    const r = await upgradeSelfHosted({}, deps(runner));
    expect(r).toEqual({ ok: true, status: "upgraded", version: "0.11.0" });
    expect(steps(runner.calls)).toEqual([
      "cosign-probe",
      "verify admin",
      "verify gateway",
      "pg_isready",
      "dump globals",
      "dump cms_admin",
      "dump cms_public",
      "pull",
      "migrate admin",
      "migrate public",
      "up caelo-admin",
      "health admin",
      "up caelo-gateway",
      "health gateway",
    ]);
    // The migrations run the NEW admin image: the Compose file already names it.
    expect(readFileSync(composePath(dir), "utf8")).toBe(render(NEW));
    const release = readRelease(dir);
    expect(release?.version).toBe("0.11.0");
    expect(release?.images).toEqual({ admin: NEW.admin, gateway: NEW.gateway });
    expect(release?.history.at(-1)).toMatchObject({
      from: "0.10.0",
      to: "0.11.0",
      outcome: "upgraded",
    });
  });

  it("writes the backup into a private dir before touching anything", async () => {
    await upgradeSelfHosted({ version: "v0.11.0" }, deps(fakeRunner()));
    const backup = join(dir, "backups", "pre-upgrade-2026-10-13T12-00-00-000Z");
    expect(statSync(backup).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(backup, "cms_admin.dump"), "utf8")).toBe("DUMP");
    expect(statSync(join(backup, "cms_public.dump")).mode & 0o777).toBe(0o600);
  });

  it("is a no-op when the install already runs the target digests", async () => {
    recordRelease(
      dir,
      { version: "0.11.0", images: NEW },
      { from: "0.10.0", to: "0.11.0", outcome: "upgraded" },
    );
    writeFileSync(composePath(dir), render(NEW));
    const runner = fakeRunner();
    const r = await upgradeSelfHosted({ version: "0.11.0" }, deps(runner));
    expect(r).toEqual({ ok: true, status: "already-current", version: "0.11.0" });
    // No backup, pull or migration — only converging + proving health.
    expect(steps(runner.calls)).toEqual([
      "cosign-probe",
      "verify admin",
      "verify gateway",
      "up both",
      "health admin",
      "health gateway",
    ]);
  });

  it("reports an unhealthy install that is already on the target", async () => {
    recordRelease(
      dir,
      { version: "0.11.0", images: NEW },
      { from: "0.10.0", to: "0.11.0", outcome: "upgraded" },
    );
    writeFileSync(composePath(dir), render(NEW));
    const runner = fakeRunner([(c) => (c.includes("/healthz") ? { exitCode: 1 } : undefined)]);
    const r = await upgradeSelfHosted({ version: "0.11.0" }, deps(runner));
    expect(r).toMatchObject({ ok: false, stage: "converge", previousRunning: false });
  });

  it("re-runs the full flow when a stopped run left the Compose file on other digests", async () => {
    // release.json says 0.10.0 (OLD); an interrupted upgrade left NEW in the file.
    writeFileSync(composePath(dir), render(NEW));
    const runner = fakeRunner();
    const r = await upgradeSelfHosted(
      { version: "0.10.0" },
      {
        ...deps(runner),
        fetchImpl: registryServing({ admin: OLD_DIGEST.admin, gateway: OLD_DIGEST.gateway }),
      },
    );
    expect(r).toEqual({ ok: true, status: "upgraded", version: "0.10.0" });
    expect(steps(runner.calls)).toContain("migrate admin");
    expect(readFileSync(composePath(dir), "utf8")).toBe(render(OLD));
  });

  it("refuses to touch the host when a signature does not verify", async () => {
    const runner = fakeRunner([
      (c) =>
        c.startsWith("cosign verify") && c.includes("/gateway@") ? { exitCode: 1 } : undefined,
    ]);
    const r = await upgradeSelfHosted({ version: "0.11.0" }, deps(runner));
    expect(r).toMatchObject({ ok: false, stage: "verify", previousRunning: true });
    expect(runner.calls.some((c) => c.startsWith("docker"))).toBe(false);
    expect(readFileSync(composePath(dir), "utf8")).toBe(render(OLD));
  });

  it("aborts before pulling when the backup fails", async () => {
    const runner = fakeRunner([
      (c) =>
        c.includes("pg_dump ") && c.endsWith("cms_admin")
          ? { exitCode: 1, stderr: "disk full" }
          : undefined,
    ]);
    const r = await upgradeSelfHosted({ version: "0.11.0" }, deps(runner));
    expect(r).toMatchObject({ ok: false, stage: "backup", previousRunning: true });
    if (!r.ok) expect(r.error).toContain("disk full");
    expect(steps(runner.calls)).not.toContain("pull");
    expect(readFileSync(composePath(dir), "utf8")).toBe(render(OLD));
    expect(readRelease(dir)?.version).toBe("0.10.0");
  });

  it("does not start when Postgres is down (no backup possible)", async () => {
    const runner = fakeRunner([(c) => (c.includes("pg_isready") ? { exitCode: 1 } : undefined)]);
    const r = await upgradeSelfHosted({ version: "0.11.0" }, deps(runner));
    expect(r).toMatchObject({ ok: false, stage: "backup" });
    expect(steps(runner.calls)).not.toContain("dump cms_admin");
  });

  it("restores the Compose file and restarts nothing when a migration fails", async () => {
    const runner = fakeRunner([
      (c) =>
        c.includes("migrate.ts public") ? { exitCode: 1, stderr: "relation exists" } : undefined,
    ]);
    const r = await upgradeSelfHosted({ version: "0.11.0" }, deps(runner));
    expect(r).toMatchObject({ ok: false, stage: "migrate", previousRunning: true });
    expect(steps(runner.calls).some((s) => s.startsWith("up "))).toBe(false);
    expect(readFileSync(composePath(dir), "utf8")).toBe(render(OLD));
  });

  it("rolls back to the previous images when the gateway fails its health check", async () => {
    let compose = "";
    const runner = fakeRunner([
      (c) => {
        if (c.includes(" up -d ")) compose = readFileSync(composePath(dir), "utf8");
        return undefined;
      },
      // Unhealthy only on the new image: healthy again once rolled back.
      (c) => (c.includes("/healthz") && compose === render(NEW) ? { exitCode: 1 } : undefined),
    ]);
    const r = await upgradeSelfHosted({ version: "0.11.0" }, deps(runner));
    expect(r).toMatchObject({ ok: false, stage: "roll-gateway", previousRunning: true });
    const s = steps(runner.calls);
    expect(s.slice(s.indexOf("up caelo-gateway"))).toEqual([
      "up caelo-gateway",
      "health gateway",
      "health gateway",
      "health gateway",
      "up both",
      "health admin",
      "health gateway",
    ]);
    expect(readFileSync(composePath(dir), "utf8")).toBe(render(OLD));
    const release = readRelease(dir);
    expect(release?.version).toBe("0.10.0");
    expect(release?.images.admin).toBe(OLD.admin);
    expect(release?.history.at(-1)).toMatchObject({ to: "0.11.0", outcome: "rolled-back" });
  });

  it("reports a failed rollback loudly", async () => {
    const runner = fakeRunner([
      (c) => (c.includes("/_caelo/health") ? { exitCode: 1 } : undefined),
    ]);
    const r = await upgradeSelfHosted({ version: "0.11.0" }, deps(runner));
    expect(r).toMatchObject({ ok: false, stage: "roll-admin", previousRunning: false });
    if (!r.ok) expect(r.error).toContain("ROLLBACK FAILED");
  });

  it("moves an install from before #696 (no release.json) onto the release images", async () => {
    rmSync(join(dir, "release.json"));
    const legacy = "caelo-admin:\n  image: oven/bun:1.3\n  volumes: [../..:/app]\n";
    writeFileSync(composePath(dir), legacy);
    const failing = fakeRunner([(c) => (c.includes("/healthz") ? { exitCode: 1 } : undefined)]);
    const failed = await upgradeSelfHosted({ version: "0.11.0" }, deps(failing));
    expect(failed.ok).toBe(false);
    // Rollback restores the legacy file byte for byte.
    expect(readFileSync(composePath(dir), "utf8")).toBe(legacy);

    const r = await upgradeSelfHosted({ version: "0.11.0" }, deps(fakeRunner()));
    expect(r).toEqual({ ok: true, status: "upgraded", version: "0.11.0" });
    expect(readRelease(dir)?.history.at(-1)).toMatchObject({ from: null, to: "0.11.0" });
  });

  it("keeps the legacy Compose file for rollback across a stopped first upgrade", async () => {
    rmSync(join(dir, "release.json"));
    const legacy = "legacy: true\n";
    writeFileSync(composePath(dir), legacy);
    // A first run that stopped after writing the release images into the file.
    const stopped = fakeRunner([(c) => (c.includes(" pull ") ? { exitCode: 1 } : undefined)]);
    await upgradeSelfHosted({ version: "0.11.0" }, deps(stopped));
    expect(readFileSync(legacyComposePath(dir), "utf8")).toBe(legacy);
    writeFileSync(composePath(dir), render(NEW));

    const failing = fakeRunner([(c) => (c.includes("/healthz") ? { exitCode: 1 } : undefined)]);
    await upgradeSelfHosted({ version: "0.11.0" }, deps(failing));
    expect(readFileSync(composePath(dir), "utf8")).toBe(legacy);
  });

  it("copies a legacy install's media from the checkout into .caelo/media", async () => {
    const root = mkdtempSync(join(tmpdir(), "caelo-sh-repo-"));
    try {
      const caeloDir = join(root, ".caelo");
      mkdirSync(join(root, "apps", "admin", "data", "media", "a"), { recursive: true });
      writeFileSync(join(root, "apps", "admin", "data", "media", "a", "logo.png"), "PNG");
      mkdirSync(caeloDir);
      writeFileSync(composePath(caeloDir), "legacy: true\n");
      const r = await upgradeSelfHosted({ version: "0.11.0" }, { ...deps(fakeRunner()), caeloDir });
      expect(r.ok).toBe(true);
      expect(readFileSync(join(caeloDir, "media", "a", "logo.png"), "utf8")).toBe("PNG");
      // The originals stay where they were.
      expect(existsSync(join(root, "apps", "admin", "data", "media", "a", "logo.png"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
