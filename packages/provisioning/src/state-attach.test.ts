// SPDX-License-Identifier: MPL-2.0

/**
 * `attach --project` (#696, state-attach.ts) against a fake bucket, and the
 * install-dir archive `state migrate` takes first (state-command.ts).
 */

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
import type { GcloudResult } from "./gcloud.js";
import { attachInstall } from "./state-attach.js";
import { gcsBackendRecord, hasLocalPulumiState } from "./state-backend.js";
import { backupInstallDir, migrationLock } from "./state-command.js";
import type { SyncGcloud } from "./state-store.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const GCS = gcsBackendRecord("acme-site", "europe-west1");
const META = {
  installId: "gcp-firebase-acme-site",
  provider: "gcp-firebase",
  projectId: "acme-site",
  domain: "acme.com",
  ownerEmail: "o@acme.com",
  region: "europe-west1",
  createdAt: "2026-01-01T00:00:00.000Z",
  stateBackend: GCS,
};

function bucket(objects: Record<string, string>): SyncGcloud {
  return (args) => {
    if (args[1] === "cat") {
      const v = objects[args[2] ?? ""];
      return v === undefined ? fail("matched no objects") : ok(v);
    }
    return fail(`unexpected ${args.join(" ")}`);
  };
}

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "caelo-attach-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const deps = (objects: Record<string, string>) => ({
  run: bucket(objects),
  rootFor: (id: string) => join(home, `.caelo-${id}`),
  hasLocalState: hasLocalPulumiState,
});
const url = (f: string) => `gs://acme-site-caelo-ops/install/${f}`;

describe("attachInstall", () => {
  it("mirrors install.json + progress.json from the bucket into a new install dir", () => {
    const r = attachInstall(
      "acme-site",
      deps({
        [url("install.json")]: JSON.stringify(META),
        [url("progress.json")]: JSON.stringify({ lastCompletedStep: "x", steps: {} }),
      }),
    );
    expect(r).toEqual({
      ok: true,
      installId: META.installId,
      domain: "acme.com",
      status: "attached",
    });
    const root = join(home, `.caelo-${META.installId}`);
    expect(JSON.parse(readFileSync(join(root, "install.json"), "utf8")).stateBackend).toEqual(GCS);
    expect(existsSync(join(root, "progress.json"))).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("re-attaching is a refresh", () => {
    const objects = { [url("install.json")]: JSON.stringify(META) };
    attachInstall("acme-site", deps(objects));
    expect(attachInstall("acme-site", deps(objects))).toMatchObject({
      ok: true,
      status: "refreshed",
    });
  });

  it("an empty bucket points at state migrate on the installing machine", () => {
    const r = attachInstall("acme-site", deps({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("state migrate");
  });

  it("refuses an install whose state went back to a machine", () => {
    const r = attachInstall(
      "acme-site",
      deps({ [url("install.json")]: JSON.stringify({ ...META, stateBackend: { kind: "local" } }) }),
    );
    expect(r.ok).toBe(false);
  });

  it("refuses a record for another project", () => {
    const r = attachInstall(
      "acme-site",
      deps({ [url("install.json")]: JSON.stringify({ ...META, projectId: "other" }) }),
    );
    expect(r.ok).toBe(false);
  });

  it("never hides this machine's un-migrated local state", () => {
    const root = join(home, `.caelo-${META.installId}`);
    mkdirSync(join(root, "state", ".pulumi", "stacks", "caelo-gcp-firebase"), { recursive: true });
    writeFileSync(join(root, "install.json"), JSON.stringify({ ...META, stateBackend: undefined }));
    const r = attachInstall("acme-site", deps({ [url("install.json")]: JSON.stringify(META) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("state migrate --install");
    expect(
      JSON.parse(readFileSync(join(root, "install.json"), "utf8")).stateBackend,
    ).toBeUndefined();
  });
});

describe("backupInstallDir", () => {
  for (const hasZstd of [true, false]) {
    it(`archives the install dir privately (${hasZstd ? "tar.zst" : "tar.gz fallback"})`, () => {
      if (hasZstd && Bun.spawnSync(["zstd", "--version"]).exitCode !== 0) return;
      const root = join(home, ".caelo-gcp-acme");
      mkdirSync(join(root, "secrets"), { recursive: true });
      writeFileSync(join(root, "secrets", "pulumi-passphrase"), "pp\n");
      const out = backupInstallDir("gcp-acme", {
        home,
        hasZstd,
        now: new Date("2026-10-13T10:00:00Z"),
      });
      expect(out).toBe(
        join(
          home,
          ".caelo-backups",
          `gcp-acme-2026-10-13T10-00-00-000Z.tar.${hasZstd ? "zst" : "gz"}`,
        ),
      );
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, ".caelo-backups")).mode & 0o777).toBe(0o700);
      const list = hasZstd
        ? Bun.spawnSync(["sh", "-c", `zstd -dc "${out}" | tar -tf -`])
        : Bun.spawnSync(["tar", "-tzf", out]);
      expect(new TextDecoder().decode(list.stdout)).toContain(
        ".caelo-gcp-acme/secrets/pulumi-passphrase",
      );
      expect(existsSync(out.replace(/\.zst$/, ""))).toBe(!hasZstd);
    });
  }
});

describe("migrationLock", () => {
  it("creates the lock only if absent and releases it", async () => {
    const objects = new Map<string, string>();
    const run: SyncGcloud = (args, input) => {
      const url = args[2] === "-" ? (args[3] ?? "") : (args[2] ?? "");
      if (args[1] === "cp") {
        if (args.includes("--if-generation-match=0") && objects.has(url)) {
          return fail(
            "HTTPError 412: At least one of the pre-conditions you specified did not hold.",
          );
        }
        objects.set(url, input ?? "");
        return ok();
      }
      if (args[1] === "cat")
        return objects.has(url) ? ok(objects.get(url)) : fail("matched no objects");
      if (args[1] === "rm") return objects.delete(url) ? ok() : fail("matched no objects");
      return fail("unexpected");
    };
    const release = migrationLock("acme-site-caelo-ops", run);
    expect(() => migrationLock("acme-site-caelo-ops", run)).toThrow(
      /gcloud storage rm gs:\/\/acme-site-caelo-ops\/install\/migrate.lock/,
    );
    await release();
    const again = migrationLock("acme-site-caelo-ops", run);
    await again();
    expect(objects.size).toBe(0);
  });
});
