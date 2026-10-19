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

  it("rejects PAX global extended headers ('g') and merges consecutive 'x' headers", () => {
    const makeBlock = (name: string, typeflag: string, bodyText = ""): Uint8Array => {
      const body = new TextEncoder().encode(bodyText);
      const paddedLen = Math.ceil(body.length / 512) * 512;
      const out = new Uint8Array(512 + paddedLen);
      out.set(new TextEncoder().encode(name), 0);
      out.set(new TextEncoder().encode(`${body.length.toString(8).padStart(11, "0")}\0`), 124);
      out[156] = typeflag.charCodeAt(0);
      out.set(body, 512);
      return out;
    };
    const paxLine = (kv: string): string => {
      const base = ` ${kv}\n`;
      const len = String(base.length + 2).length + base.length;
      return `${len}${base}`;
    };

    const gBlock = makeBlock("PaxHeader", "g", paxLine("path=/etc/passwd"));
    expect(() => listTarEntries(gBlock)).toThrow(/pax global extended header/);

    const x1 = makeBlock("PaxHeader", "x", paxLine("path=../../etc/passwd"));
    const x2 = makeBlock("PaxHeader", "x", paxLine("mtime=1234567890"));
    const fileBlock = makeBlock("safe.txt", "0", "");
    const combined = new Uint8Array(x1.length + x2.length + fileBlock.length);
    combined.set(x1, 0);
    combined.set(x2, x1.length);
    combined.set(fileBlock, x1.length + x2.length);
    const entries = listTarEntries(combined);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("../../etc/passwd");
  });
});

describe("escapesRoot & normalizeMemberName", () => {
  it("flags absolute, parent-relative, and dot-segment member names", () => {
    expect(escapesRoot("/etc/passwd")).toBe(true);
    expect(escapesRoot("srv/caelo/../../app")).toBe(true);
    expect(escapesRoot(".//../etc/passwd")).toBe(true);
    expect(escapesRoot("a/./b")).toBe(true);
    expect(escapesRoot("./srv/caelo/a..b")).toBe(false);
    expect(normalizeMemberName(".//srv//caelo/")).toBe("srv/caelo");
  });
});
