// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chooseImageDigests } from "./deployed-release.js";
import {
  decideInstallVersion,
  installRecordFromManifest,
  launcherRecordsRelease,
  OLDEST_INSTALLABLE_RELEASE,
  releaseToConfirm,
} from "./install-version.js";

const d = (c: string) => `sha256:${c.repeat(64)}`;

describe("decideInstallVersion (#1558)", () => {
  it("leaves the wizard's usual choice alone without --version", () => {
    expect(
      decideInstallVersion({ requested: undefined, deployed: false, recordedVersion: undefined }),
    ).toEqual({ kind: "none" });
  });

  it("installs the named release on an install that is not provisioned yet", () => {
    expect(
      decideInstallVersion({
        requested: "v0.12.5-rc.1",
        deployed: false,
        recordedVersion: "0.12.4",
      }),
    ).toEqual({ kind: "install", version: "0.12.5-rc.1" });
    expect(
      decideInstallVersion({ requested: "0.12.4", deployed: false, recordedVersion: undefined }),
    ).toEqual({ kind: "install", version: "0.12.4" });
  });

  it("keeps the release a provisioned install runs when it is the one named", () => {
    expect(
      decideInstallVersion({
        requested: "0.12.5-rc.1",
        deployed: true,
        recordedVersion: "0.12.5-rc.1",
      }),
    ).toEqual({ kind: "keep", version: "0.12.5-rc.1" });
  });

  it("never changes the release of a provisioned install: that is upgrade's job", () => {
    const r = decideInstallVersion({
      requested: "0.12.5",
      deployed: true,
      recordedVersion: "0.12.4",
    });
    expect(r.kind).toBe("refuse");
    const error = r.kind === "refuse" ? r.error : "";
    expect(error).toContain("already runs v0.12.4");
    expect(error).toContain("bunx @caelo-cms/provisioning@0.12.5 upgrade --version 0.12.5");
    const unknown = decideInstallVersion({
      requested: "0.12.5",
      deployed: true,
      recordedVersion: undefined,
    });
    expect(unknown.kind === "refuse" && unknown.error).toContain("already runs a release");
  });

  it("refuses a release from before the MCP-Auth-Proxy, which this installer deploys", () => {
    for (const requested of ["0.11.0", "0.11.9", "0.10.69"]) {
      const r = decideInstallVersion({ requested, deployed: false, recordedVersion: undefined });
      expect(r.kind).toBe("refuse");
      expect(r.kind === "refuse" && r.error).toContain(`v${OLDEST_INSTALLABLE_RELEASE} or later`);
    }
    expect(
      decideInstallVersion({
        requested: OLDEST_INSTALLABLE_RELEASE,
        deployed: false,
        recordedVersion: undefined,
      }).kind,
    ).toBe("install");
  });

  it("refuses anything that is not a release version", () => {
    for (const requested of ["latest", "rc", "0.12", "0.12.4; rm -rf /", ""]) {
      const r = decideInstallVersion({ requested, deployed: false, recordedVersion: undefined });
      expect(r.kind).toBe("refuse");
    }
  });
});

describe("installRecordFromManifest", () => {
  const digests = {
    admin: d("a"),
    gateway: d("b"),
    ops: d("c"),
    "mcp-auth-proxy": d("e"),
  };

  it("records the three images the stack deploys and the version", () => {
    expect(installRecordFromManifest({ version: "0.12.5-rc.1", digests })).toEqual({
      ok: true,
      digests: { admin: d("a"), gateway: d("b"), "mcp-auth-proxy": d("e") },
      version: "0.12.5-rc.1",
    });
  });

  it("refuses a release from before the MCP-Auth-Proxy", () => {
    const { "mcp-auth-proxy": _, ...old } = digests;
    const r = installRecordFromManifest({ version: "0.11.9", digests: old });
    expect(r.ok).toBe(false);
  });

  // Regression: the job-mode launcher recorded only admin + gateway, and the
  // job's release choice refuses a record without the MCP-Auth-Proxy since
  // #1328, so every Cloud Shell fresh install stopped at "Choosing the
  // release images".
  it("writes a record the install job's release choice accepts", async () => {
    const record = installRecordFromManifest({ version: "0.12.4", digests });
    if (!record.ok) throw new Error(record.error);
    const unused = async (): Promise<never> => {
      throw new Error("not reached");
    };
    const choice = await chooseImageDigests({
      recorded: record.digests,
      deployed: false,
      readLive: unused,
      resolveLatest: unused,
    });
    expect(choice).toEqual({ ok: true, source: "recorded", digests: record.digests });
    const before = await chooseImageDigests({
      recorded: { admin: d("a"), gateway: d("b") },
      deployed: false,
      readLive: unused,
      resolveLatest: unused,
    });
    expect(before.ok).toBe(false);
  });
});

describe("launcherRecordsRelease", () => {
  const full = { admin: d("a"), gateway: d("b"), "mcp-auth-proxy": d("e") };

  it("never records once the first pulumi up succeeded", () => {
    for (const requested of [true, false]) {
      expect(launcherRecordsRelease({ deployed: true, requested, recorded: null })).toBe(false);
    }
  });

  it("records a named version, a first run, and over a record without the proxy", () => {
    expect(launcherRecordsRelease({ deployed: false, requested: true, recorded: full })).toBe(true);
    expect(launcherRecordsRelease({ deployed: false, requested: false, recorded: null })).toBe(
      true,
    );
    expect(
      launcherRecordsRelease({
        deployed: false,
        requested: false,
        recorded: { admin: d("a"), gateway: d("b") },
      }),
    ).toBe(true);
  });

  it("keeps a complete record when no version was named", () => {
    expect(launcherRecordsRelease({ deployed: false, requested: false, recorded: full })).toBe(
      false,
    );
  });
});

describe("releaseToConfirm (#1558 review)", () => {
  const full = { admin: d("a"), gateway: d("b"), "mcp-auth-proxy": d("e") };
  const none = { kind: "none" } as const;

  it("names the release --version installs, in either run mode", () => {
    for (const runMode of ["job", "local"] as const) {
      expect(
        releaseToConfirm({
          decision: { kind: "install", version: "0.12.5-rc.1" },
          runMode,
          cliVersion: "0.12.4",
          deployed: false,
          recorded: null,
        }),
      ).toBe("0.12.5-rc.1");
    }
  });

  it("names the CLI's own release when the job-mode launcher installs it", () => {
    // `bunx @caelo-cms/provisioning@0.12.5-rc.1` in Cloud Shell, no --version.
    expect(
      releaseToConfirm({
        decision: none,
        runMode: "job",
        cliVersion: "0.12.5-rc.1",
        deployed: false,
        recorded: null,
      }),
    ).toBe("0.12.5-rc.1");
  });

  it("names nothing when the run installs no new release", () => {
    const base = { decision: none, cliVersion: "0.12.5-rc.1" } as const;
    // Local mode without --version resolves `latest`, never a candidate.
    expect(
      releaseToConfirm({ ...base, runMode: "local", deployed: false, recorded: null }),
    ).toBeNull();
    // A provisioned install keeps what it runs; so does a complete record.
    expect(
      releaseToConfirm({ ...base, runMode: "job", deployed: true, recorded: null }),
    ).toBeNull();
    expect(
      releaseToConfirm({ ...base, runMode: "job", deployed: false, recorded: full }),
    ).toBeNull();
    expect(
      releaseToConfirm({
        decision: { kind: "keep", version: "0.12.5-rc.1" },
        runMode: "job",
        cliVersion: "0.12.5-rc.1",
        deployed: true,
        recorded: full,
      }),
    ).toBeNull();
  });
});

describe("recordLaunchRelease (#1558 review: under the launch lock)", () => {
  // installRoot() resolves ~ through os.homedir(), which reads HOME once at
  // process start: each case runs in a child bun process with its own HOME
  // (as install-state.test.ts does), its ops bucket a directory there.
  const PROJECT = "acme-site";
  const INSTALL_ID = "gcp-acme-site";
  const meta = {
    installId: INSTALL_ID,
    provider: "gcp",
    projectId: PROJECT,
    domain: "acme.example",
    ownerEmail: "owner@acme.example",
    region: "europe-west1",
    createdAt: "2026-11-10T00:00:00.000Z",
    stateBackend: {
      kind: "gcs",
      bucket: `${PROJECT}-caelo-ops`,
      kmsKey: `projects/${PROJECT}/locations/europe-west1/keyRings/caelo/cryptoKeys/pulumi-state`,
    },
  };
  const rc = {
    digests: { admin: d("1"), gateway: d("2"), "mcp-auth-proxy": d("3") },
    version: "0.12.5-rc.1",
  };
  const other = { admin: d("a"), gateway: d("b"), "mcp-auth-proxy": d("e") };
  const fresh = { lastCompletedStep: null, steps: {} };
  const provisioned = {
    lastCompletedStep: `pulumi-up-${PROJECT}`,
    steps: { [`pulumi-up-${PROJECT}`]: {} },
  };

  /**
   * Run `steps` (JS; `m` is install-state, `v` install-version, `put(file,
   * value)` writes the bucket) in a child process whose HOME holds the
   * install's local mirror and whose gcloud is the bucket directory.
   */
  function inChild(
    start: { readonly install: unknown; readonly progress: unknown },
    steps: string,
  ): { readonly out: unknown; readonly install: Record<string, unknown> } {
    const home = mkdtempSync(join(tmpdir(), "caelo-launch-"));
    try {
      const mirror = join(home, `.caelo-${INSTALL_ID}`);
      const objects = join(home, "bucket");
      mkdirSync(mirror, { recursive: true });
      mkdirSync(objects);
      writeFileSync(join(mirror, "install.json"), JSON.stringify(meta));
      writeFileSync(join(objects, "install.json"), JSON.stringify(start.install));
      writeFileSync(join(objects, "progress.json"), JSON.stringify(start.progress));
      const script = `
        const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
        const m = await import(${JSON.stringify(resolve(import.meta.dir, "install-state.ts"))});
        const v = await import(${JSON.stringify(resolve(import.meta.dir, "install-version.ts"))});
        const objects = ${JSON.stringify(objects)};
        const at = (url) => objects + "/" + url.split("/").pop();
        const put = (file, value) => writeFileSync(objects + "/" + file, JSON.stringify(value));
        m.setStateStoreGcloud((args, input) => {
          const [, verb, a, b] = args;
          if (verb === "cat") {
            return existsSync(at(a))
              ? { ok: true, stdout: readFileSync(at(a), "utf8"), stderr: "", exitCode: 0 }
              : { ok: false, stdout: "", stderr: "One or more URLs matched no objects.", exitCode: 1 };
          }
          if (verb === "cp" && a === "-") {
            writeFileSync(at(b), input ?? "");
            return { ok: true, stdout: "", stderr: "", exitCode: 0 };
          }
          throw new Error("unexpected gcloud " + args.join(" "));
        });
        const ID = ${JSON.stringify(INSTALL_ID)};
        const PROJECT = ${JSON.stringify(PROJECT)};
        const RC = ${JSON.stringify(rc)};
        ${steps}`;
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, HOME: home },
        stderr: "pipe",
      });
      expect(new TextDecoder().decode(child.stderr)).toBe("");
      expect(child.exitCode).toBe(0);
      return {
        out: JSON.parse(new TextDecoder().decode(child.stdout)),
        install: JSON.parse(readFileSync(join(objects, "install.json"), "utf8")),
      };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("records the named release on an install that is not provisioned yet", () => {
    const r = inChild(
      { install: meta, progress: fresh },
      `console.log(JSON.stringify(v.recordLaunchRelease(ID, PROJECT, "0.12.5-rc.1", RC)));`,
    );
    expect(r.out).toEqual({ ok: true });
    expect(r.install.imageDigests).toEqual(rc.digests);
    expect(r.install.releaseVersion).toBe("0.12.5-rc.1");
  }, 30_000);

  it("decides from the bucket as it is now, not from this process's first read", () => {
    // The launcher read the install while it was new; then another
    // launcher's job provisioned it with 0.12.4 before this one got the lock.
    const r = inChild(
      { install: meta, progress: fresh },
      `const before = [m.readMetadata(ID).releaseVersion ?? null, m.isStepDone(ID, "pulumi-up-" + PROJECT)];
       put("install.json", ${JSON.stringify({ ...meta, imageDigests: other, releaseVersion: "0.12.4" })});
       put("progress.json", ${JSON.stringify(provisioned)});
       console.log(JSON.stringify({ before, result: v.recordLaunchRelease(ID, PROJECT, "0.12.5-rc.1", RC) }));`,
    );
    const out = r.out as { before: unknown; result: { ok: boolean; error?: string } };
    expect(out.before).toEqual([null, false]);
    expect(out.result.ok).toBe(false);
    expect(out.result.error).toContain("already runs v0.12.4");
    expect(r.install.releaseVersion).toBe("0.12.4");
    expect(r.install.imageDigests).toEqual(other);
  }, 30_000);

  it("keeps another launcher's complete record when no version was named", () => {
    const r = inChild(
      { install: { ...meta, imageDigests: other, releaseVersion: "0.12.4" }, progress: fresh },
      `console.log(JSON.stringify(v.recordLaunchRelease(ID, PROJECT, undefined, RC)));`,
    );
    expect(r.out).toEqual({ ok: true });
    expect(r.install.imageDigests).toEqual(other);
  }, 30_000);
});
