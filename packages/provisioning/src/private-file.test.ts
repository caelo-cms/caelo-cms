// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tightenPrivateTree, writePrivateFile } from "./private-file.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caelo-private-file-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (path: string) => statSync(path).mode & 0o777;

describe("writePrivateFile", () => {
  it("creates the file owner-only and replaces a world-readable file with an owner-only one", () => {
    const fresh = join(dir, "fresh.json");
    writePrivateFile(fresh, "{}");
    expect(mode(fresh)).toBe(0o600);

    const legacy = join(dir, "legacy.json");
    writeFileSync(legacy, "{}", { mode: 0o644 });
    chmodSync(legacy, 0o644);
    writePrivateFile(legacy, '{"secret":"x"}');
    expect(mode(legacy)).toBe(0o600);
    expect(readFileSync(legacy, "utf8")).toBe('{"secret":"x"}');
    expect(readdirSync(dir).sort()).toEqual(["fresh.json", "legacy.json"]);
  });

  it("never writes the new secret into the old world-readable inode", () => {
    // A local user who opened the 0644 file before the rewrite keeps that
    // descriptor; a write-then-chmod would let it read the new secret.
    const legacy = join(dir, "internal-secret.json");
    writeFileSync(legacy, "old");
    chmodSync(legacy, 0o644);
    const fd = openSync(legacy, "r");
    try {
      writePrivateFile(legacy, "new-secret");
      const buf = Buffer.alloc(64);
      const n = readSync(fd, buf, 0, buf.length, 0);
      expect(buf.subarray(0, n).toString()).toBe("old");
    } finally {
      closeSync(fd);
    }
  });
});

describe("tightenPrivateTree", () => {
  it("takes group/other access off an older install's directory and secrets, skipping missing ones", () => {
    const install = join(dir, ".caelo");
    mkdirSync(join(install, "bootstrap"), { recursive: true });
    chmodSync(install, 0o755);
    chmodSync(join(install, "bootstrap"), 0o755);
    writeFileSync(join(install, "config.json"), "{}");
    chmodSync(join(install, "config.json"), 0o644);
    writeFileSync(join(install, "Caddyfile"), "");
    chmodSync(join(install, "Caddyfile"), 0o644);

    tightenPrivateTree(install, ["bootstrap", "backups"], ["config.json", "internal-secret.json"]);

    expect(mode(install)).toBe(0o700);
    expect(mode(join(install, "bootstrap"))).toBe(0o700);
    expect(mode(join(install, "config.json"))).toBe(0o600);
    // Not a secret: the Caddy container reads it through its bind mount.
    expect(mode(join(install, "Caddyfile"))).toBe(0o644);
  });
});
