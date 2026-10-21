// SPDX-License-Identifier: MPL-2.0

/**
 * #770 — the self-hosted internal secret the Compose file hands the admin:
 * an existing one is kept as it is, a missing one is created once (and
 * reported), a malformed one fails loudly instead of being replaced.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureInternalSecret,
  internalSecretPath,
  readInternalSecret,
  writeInternalSecret,
} from "./self-hosted-internal-secret.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caelo-internal-secret-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ensureInternalSecret", () => {
  it("keeps the secret `init` wrote and reports nothing", () => {
    writeInternalSecret(dir, "a".repeat(96));
    const reported: string[] = [];
    const secret = ensureInternalSecret(dir, {
      randomSecret: () => "b".repeat(96),
      report: (l) => reported.push(l),
    });
    expect(secret).toBe("a".repeat(96));
    expect(reported).toEqual([]);
  });

  it("creates a missing one once, private to the owner, and says so", () => {
    const reported: string[] = [];
    const deps = { randomSecret: () => "c".repeat(96), report: (l: string) => reported.push(l) };
    expect(ensureInternalSecret(dir, deps)).toBe("c".repeat(96));
    expect(ensureInternalSecret(dir, { ...deps, randomSecret: () => "d".repeat(96) })).toBe(
      "c".repeat(96),
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(internalSecretPath(dir));
    expect(statSync(internalSecretPath(dir)).mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(internalSecretPath(dir), "utf8"))).toEqual({
      secret: "c".repeat(96),
    });
  });

  it("refuses a malformed or short file rather than replacing it", () => {
    writeFileSync(internalSecretPath(dir), "{not json");
    expect(() => readInternalSecret(dir)).toThrow("not valid JSON");
    writeFileSync(internalSecretPath(dir), JSON.stringify({ secret: "short" }));
    expect(() =>
      ensureInternalSecret(dir, { randomSecret: () => "e".repeat(96), report: () => {} }),
    ).toThrow("at least 32");
  });
});
