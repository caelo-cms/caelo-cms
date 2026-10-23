// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type InstallMetadata,
  installFlag,
  installStagingHost,
  recordableStagingHost,
  recordedImageDigests,
  resumedMetadata,
  selectInstall,
} from "./install-state.js";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;

const meta: InstallMetadata = {
  installId: "gcp-firebase-acme",
  provider: "gcp-firebase",
  projectId: "acme",
  domain: "acme.com",
  ownerEmail: "o@acme.com",
  region: "europe-west1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("recordedImageDigests", () => {
  it("is null for installs that predate the record", () => {
    expect(recordedImageDigests(meta)).toBeNull();
  });

  it("returns the recorded digests", () => {
    expect(recordedImageDigests({ ...meta, imageDigests: { admin: A, gateway: B } })).toEqual({
      admin: A,
      gateway: B,
    });
  });

  it("refuses a malformed record instead of deploying a guess", () => {
    expect(() =>
      recordedImageDigests({ ...meta, imageDigests: { admin: "latest", gateway: B } }),
    ).toThrow(/malformed/);
  });
});

describe("resumedMetadata", () => {
  it("keeps the recorded release on a non-interactive re-run", () => {
    const existing = { ...meta, imageDigests: { admin: A, gateway: B } };
    expect(
      resumedMetadata(existing, {
        domain: "acme.com",
        ownerEmail: "new@acme.com",
        projectId: null,
      }),
    ).toEqual({ ...existing, ownerEmail: "new@acme.com" });
  });

  it("takes an explicit project id over the stored one", () => {
    expect(
      resumedMetadata(meta, { domain: "acme.com", ownerEmail: "o@acme.com", projectId: "acme-2" })
        .projectId,
    ).toBe("acme-2");
  });
});

describe("recordImageDigests (regression C4)", () => {
  it("records the rolled digests in install.json, keeping the rest of the metadata", () => {
    // installRoot() resolves ~ via os.homedir(), which reads HOME once at
    // process start — run the write in a child process with its own HOME.
    const home = mkdtempSync(join(tmpdir(), "caelo-install-state-"));
    try {
      const dir = join(home, `.caelo-${meta.installId}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "install.json"), JSON.stringify(meta));
      const module = resolve(import.meta.dir, "install-state.ts");
      const child = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `const m = await import(${JSON.stringify(module)}); m.recordImageDigests(${JSON.stringify(meta.installId)}, { admin: ${JSON.stringify(A)}, gateway: ${JSON.stringify(B)} });`,
        ],
        { env: { ...process.env, HOME: home }, stderr: "pipe" },
      );
      expect(new TextDecoder().decode(child.stderr)).toBe("");
      expect(child.exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(dir, "install.json"), "utf8"));
      expect(written).toEqual({ ...meta, imageDigests: { admin: A, gateway: B } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    // A fresh bun process (own HOME) cold-starts and transpiles the module
    // graph; on a loaded runner that alone can pass the 5s default.
  }, 30_000);
});

describe("recordImageDigests and the release version (#696)", () => {
  it("keeps the version for unchanged digests, drops it for unknown new ones, sets a given one", () => {
    const home = mkdtempSync(join(tmpdir(), "caelo-install-state-"));
    try {
      const dir = join(home, `.caelo-${meta.installId}`);
      mkdirSync(dir, { recursive: true });
      const start = { ...meta, imageDigests: { admin: A, gateway: B }, releaseVersion: "0.10.45" };
      writeFileSync(join(dir, "install.json"), JSON.stringify(start));
      const module = resolve(import.meta.dir, "install-state.ts");
      const C = `sha256:${"c".repeat(64)}`;
      const script = `
        const m = await import(${JSON.stringify(module)});
        const id = ${JSON.stringify(meta.installId)};
        const out = [];
        m.recordImageDigests(id, { admin: ${JSON.stringify(A)}, gateway: ${JSON.stringify(B)} });
        out.push(m.readMetadata(id).releaseVersion ?? null);
        m.recordImageDigests(id, { admin: ${JSON.stringify(C)}, gateway: ${JSON.stringify(B)} });
        out.push(m.readMetadata(id).releaseVersion ?? null);
        m.recordImageDigests(id, { admin: ${JSON.stringify(C)}, gateway: ${JSON.stringify(B)} }, "0.11.0");
        out.push(m.readMetadata(id).releaseVersion ?? null);
        console.log(JSON.stringify(out));`;
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, HOME: home },
        stderr: "pipe",
      });
      expect(new TextDecoder().decode(child.stderr)).toBe("");
      expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual([
        "0.10.45",
        null,
        "0.11.0",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("#1025: records the platform forms, keeps them for unchanged digests, drops them for new ones", () => {
    const home = mkdtempSync(join(tmpdir(), "caelo-install-state-"));
    try {
      const dir = join(home, `.caelo-${meta.installId}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "install.json"), JSON.stringify(meta));
      const module = resolve(import.meta.dir, "install-state.ts");
      const C = `sha256:${"c".repeat(64)}`;
      const P = { admin: `sha256:${"1".repeat(64)}`, gateway: `sha256:${"2".repeat(64)}` };
      const ab = `{ admin: ${JSON.stringify(A)}, gateway: ${JSON.stringify(B)} }`;
      const script = `
        const m = await import(${JSON.stringify(module)});
        const id = ${JSON.stringify(meta.installId)};
        const out = [];
        m.recordImageDigests(id, ${ab}, "0.11.0", ${JSON.stringify(P)});
        out.push(m.readMetadata(id).platformDigests ?? null);
        m.recordImageDigests(id, ${ab});
        out.push(m.readMetadata(id).platformDigests ?? null);
        m.recordImageDigests(id, { admin: ${JSON.stringify(C)}, gateway: ${JSON.stringify(B)} });
        out.push(m.readMetadata(id).platformDigests ?? null);
        console.log(JSON.stringify(out));`;
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, HOME: home },
        stderr: "pipe",
      });
      expect(new TextDecoder().decode(child.stderr)).toBe("");
      expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual([P, P, null]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("selectInstall", () => {
  const a = { ...meta, installId: "gcp-firebase-caelo-cms-com", domain: "caelo-cms.com" };
  const b = { ...meta, installId: "gcp-firebase-searchviu-com", domain: "searchviu.com" };
  const c = { ...meta, installId: "gcp-firebase-viu-one", domain: "viu.one" };

  it("acts on the only install without a flag", () => {
    expect(selectInstall([a], undefined)).toEqual({ ok: true, meta: a });
  });

  it("refuses to guess among several installs and lists them", () => {
    // Regression: upgrade used to take the first ~/.caelo-* directory it found.
    const r = selectInstall([a, b, c], undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("Several Caelo installs");
    for (const m of [a, b, c]) expect(r.message).toContain(m.installId);
    expect(r.message).toContain("--install");
  });

  it("picks the install named by id or by domain", () => {
    expect(selectInstall([a, b, c], b.installId)).toEqual({ ok: true, meta: b });
    expect(selectInstall([a, b, c], "searchviu.com")).toEqual({ ok: true, meta: b });
  });

  it("names the installs that exist when the flag matches none", () => {
    const r = selectInstall([a, b], "viu.one");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('No install "viu.one"');
    expect(r.message).toContain(a.installId);
  });

  it("reports an empty machine", () => {
    expect(selectInstall([], undefined)).toEqual({
      ok: false,
      message: "No Caelo install found on this machine.",
    });
  });
});

describe("installFlag", () => {
  it("reads --install, --install=, and the --install-id alias", () => {
    expect(installFlag(["bun", "cli", "upgrade", "--install", "viu.one"])).toBe("viu.one");
    expect(installFlag(["bun", "cli", "upgrade", "--install=viu.one"])).toBe("viu.one");
    expect(installFlag(["bun", "cli", "upgrade", "--install-id", "x"])).toBe("x");
    expect(installFlag(["bun", "cli", "upgrade", "--version", "0.10.35"])).toBeUndefined();
  });

  it("refuses a flag without a value instead of acting on a default", () => {
    expect(() => installFlag(["bun", "cli", "upgrade", "--install"])).toThrow(/needs a value/);
    expect(() => installFlag(["bun", "cli", "upgrade", "--install", "--yes"])).toThrow(
      /needs a value/,
    );
    expect(() => installFlag(["bun", "cli", "upgrade", "--install="])).toThrow(/needs a value/);
  });
});

describe("installStagingHost (#650)", () => {
  it("is the recorded setting, else staging.<domain>", () => {
    expect(installStagingHost({ domain: "acme.com" })).toBe("staging.acme.com");
    expect(installStagingHost({ domain: "acme.com", stagingDomain: "preview.other.de" })).toBe(
      "preview.other.de",
    );
  });
});

describe("recordableStagingHost", () => {
  it("passes a bare lower-case host name through unchanged", () => {
    for (const host of ["staging.acme.com", "stg.acme.co.uk", "a-b.c1.example.de", "x.io"]) {
      expect(recordableStagingHost(host)).toBe(host);
    }
  });

  it("refuses anything that is not a bare host name", () => {
    for (const host of [
      "",
      "localhost",
      "https://staging.acme.com",
      "staging.acme.com/",
      "staging.acme.com:8443",
      "Staging.Acme.com",
      " staging.acme.com",
      "staging.acme.com\n",
      "staging..acme.com",
      ".acme.com",
      "staging.acme.com.",
      "-staging.acme.com",
      "staging-.acme.com",
      "staging.acme.123",
      "user@staging.acme.com",
      "staging.acme.com?x=1",
      `${"a".repeat(64)}.acme.com`,
    ]) {
      expect(recordableStagingHost(host)).toBeNull();
    }
  });

  it("refuses a host longer than DNS allows", () => {
    const label = "a".repeat(63);
    const long = `${label}.${label}.${label}.${label}.com`;
    expect(long.length).toBeGreaterThan(253);
    expect(recordableStagingHost(long)).toBeNull();
  });
});
