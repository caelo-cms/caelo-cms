// SPDX-License-Identifier: MPL-2.0

/**
 * recordRolledDigests (#860): a CLI upgrade whose records could not be
 * written used to exit 0 with a warning, leaving install.json naming the
 * previous release. It now reports failure (the command exits non-zero)
 * with the exact fix, and never skips one record because another failed.
 */

import { describe, expect, it } from "bun:test";
import type { ImageDigests } from "../install-state.js";
import { type RecordRolledDeps, recordRolledDigests } from "./record-rolled.js";

const DIGESTS: ImageDigests = {
  admin: `sha256:${"a".repeat(64)}`,
  gateway: `sha256:${"b".repeat(64)}`,
};

function deps(overrides: Partial<RecordRolledDeps> = {}) {
  const lines: { level: string; message: string }[] = [];
  const calls: string[] = [];
  const d: RecordRolledDeps = {
    recordInstall: (_digests, version) => {
      calls.push(`install ${version}`);
    },
    pinStack: async () => {
      calls.push("stack");
      return { removedOverrides: [] };
    },
    stackRecovery: () => "  pulumi config set …",
    installJsonLocation: "gs://acme-caelo-ops/install/install.json",
    log: {
      info: (message) => lines.push({ level: "info", message }),
      warn: (message) => lines.push({ level: "warn", message }),
      error: (message) => lines.push({ level: "error", message }),
    },
    ...overrides,
  };
  return { d, lines, calls };
}

describe("recordRolledDigests", () => {
  it("records install.json and the stack config", async () => {
    const { d, calls, lines } = deps();
    expect(await recordRolledDigests(DIGESTS, "0.10.53", d)).toBe(true);
    expect(calls).toEqual(["install 0.10.53", "stack"]);
    expect(lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("regression #860: a failed install.json write fails the upgrade, with the exact fix", async () => {
    const { d, calls, lines } = deps({
      recordInstall: () => {
        throw new Error("Could not write gs://acme-caelo-ops/install/install.json: 403");
      },
    });
    expect(await recordRolledDigests(DIGESTS, "0.10.53", d)).toBe(false);
    const error = lines.find((l) => l.level === "error")?.message ?? "";
    expect(error).toContain("gs://acme-caelo-ops/install/install.json");
    expect(error).toContain(DIGESTS.admin);
    expect(error).toContain('"releaseVersion": "0.10.53"');
    // The stack config is still pinned.
    expect(calls).toEqual(["stack"]);
  });

  it("a failed stack-config pin fails the upgrade too, with the commands to run", async () => {
    const { d, lines } = deps({
      pinStack: async () => {
        throw new Error("passphrase missing");
      },
    });
    expect(await recordRolledDigests(DIGESTS, "0.10.53", d)).toBe(false);
    expect(lines.find((l) => l.level === "error")?.message).toContain("pulumi config set");
  });

  it("an unknown release version is recorded as none, with a warning, not a failure", async () => {
    const { d, calls, lines } = deps();
    expect(await recordRolledDigests(DIGESTS, null, d)).toBe(true);
    expect(calls).toEqual(["install null", "stack"]);
    expect(lines.some((l) => l.level === "warn")).toBe(true);
  });
});
