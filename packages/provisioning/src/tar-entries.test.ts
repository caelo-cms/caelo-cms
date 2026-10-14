// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunHostRunner } from "./self-hosted-release.js";
import { escapesRoot, listTarEntries, normalizeMemberName } from "./tar-entries.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caelo-tar-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("listTarEntries", () => {
  it("reads files, directories, symlinks and long (>100 byte) names from the host's tar", async () => {
    const root = join(dir, "src");
    const long = `${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(30)}.txt`;
    mkdirSync(join(root, long, ".."), { recursive: true });
    writeFileSync(join(root, long), "x");
    writeFileSync(join(root, "ä-ü.txt"), "umlaut");
    symlinkSync("target", join(root, "link"));
    const out = join(dir, "a.tar");
    const r = await bunHostRunner.run(["tar", "-cf", out, "-C", root, "."], {
      env: { COPYFILE_DISABLE: "1" },
    });
    expect(r.exitCode).toBe(0);
    const entries = listTarEntries(readFileSync(out));
    const byName = new Map(entries.map((e) => [normalizeMemberName(e.name), e]));
    expect(byName.get(long)?.type).toBe("file");
    expect(byName.get("ä-ü.txt")?.type).toBe("file");
    expect(byName.get("d".repeat(60))?.type).toBe("directory");
    expect(byName.get("link")).toMatchObject({ type: "symlink", linkTarget: "target" });
  });

  it("refuses a truncated archive instead of skipping members", () => {
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode("a.txt"), 0);
    header.set(new TextEncoder().encode("00000001000\0"), 124); // 512 bytes of data, none present
    header[156] = "0".charCodeAt(0);
    expect(() => listTarEntries(header)).toThrow(/truncated/);
  });
});

describe("escapesRoot", () => {
  it("flags absolute and parent-relative member names", () => {
    expect(escapesRoot("/etc/passwd")).toBe(true);
    expect(escapesRoot("srv/caelo/../../app")).toBe(true);
    expect(escapesRoot("./srv/caelo/a..b")).toBe(false);
  });
});
