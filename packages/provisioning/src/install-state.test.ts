// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type InstallMetadata, recordedImageDigests, resumedMetadata } from "./install-state.js";

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
  });
});
