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
    expect(() => listTarEntries(header("a.txt", "0", { sizeField: 512 }))).toThrow(/truncated/);
  });

  it("rejects PAX global extended headers ('g')", () => {
    const g = member("PaxHeader", "g", paxLine("path=/etc/passwd"));
    expect(() => listTarEntries(concat(g, member("safe.txt", "0"), END))).toThrow(
      /pax global extended header/,
    );
  });

  it("refuses a member named by two pax headers — GNU tar keeps the last, bsdtar drops the second", () => {
    // Both tars extract `../../evil` here (the second header carries no
    // path); reading the first header's path would have checked `safe.txt`.
    const archive = concat(
      member("PaxHeader", "x", paxLine("path=srv/caelo/safe.txt")),
      member("PaxHeader", "x", paxLine("mtime=1")),
      member("../../evil", "0"),
      END,
    );
    expect(() => listTarEntries(archive)).toThrow(/several extension headers \(xx\)/);
  });

  it("refuses a GNU long name next to a pax path, and two long names", () => {
    // bsdtar extracts the `L` name (`../../evil`), GNU tar the pax path.
    const mixed = concat(
      member("././@LongLink", "L", "../../evil\0"),
      member("PaxHeader", "x", paxLine("path=srv/caelo/safe.txt")),
      member("x", "0"),
      END,
    );
    expect(() => listTarEntries(mixed)).toThrow(/several extension headers \(Lx\)/);
    const twice = concat(
      member("././@LongLink", "L", "../../evil\0"),
      member("././@LongLink", "L", "safe.txt\0"),
      member("x", "0"),
      END,
    );
    expect(() => listTarEntries(twice)).toThrow(/several extension headers \(LL\)/);
  });

  it("still reads a GNU long name together with a long link", () => {
    const archive = concat(
      member("././@LongLink", "K", "target\0"),
      member("././@LongLink", "L", `${"a".repeat(120)}\0`),
      member("short", "2", "", { link: "ignored" }),
      END,
    );
    expect(listTarEntries(archive)).toEqual([
      { name: "a".repeat(120), type: "symlink", linkTarget: "target" },
    ]);
  });

  it("refuses a header whose checksum does not match — GNU tar would skip it and read its body as headers", () => {
    const archive = concat(
      header("srv/caelo/safe.txt", "0", { sizeField: 512, badChecksum: true }),
      header("../../evil", "0"),
      END,
    );
    expect(() => listTarEntries(archive)).toThrow(/checksum mismatch/);
  });

  it("refuses a directory or symlink with a body — bsdtar reads the next block as a header", () => {
    for (const [name, type] of [
      ["srv/caelo/link", "2"],
      ["srv/caelo/dir/", "5"],
    ] as const) {
      const archive = concat(
        header(name, type, { sizeField: 512, link: "a" }),
        header("../../evil", "0"),
        END,
      );
      expect(() => listTarEntries(archive)).toThrow(/with a body/);
    }
  });

  it("walks a member's body by its pax size, so a member hidden behind the header size is seen", () => {
    // tar -x reads `safe.txt` as empty (pax size=0) and then extracts the
    // `../../evil` header that the ustar size field claims is file data.
    const archive = concat(
      member("PaxHeader", "x", paxLine("size=0")),
      header("safe.txt", "0", { sizeField: 512 }),
      member("../../evil", "0"),
      END,
    );
    expect(listTarEntries(archive).map((e) => e.name)).toEqual(["safe.txt", "../../evil"]);
  });

  it("rejects GNU sparse pax records and an unreadable pax size", () => {
    const sparse = member("PaxHeader", "x", paxLine("GNU.sparse.name=../../evil"));
    expect(() => listTarEntries(concat(sparse, member("safe.txt", "0")))).toThrow(/GNU sparse/);
    const badSize = member("PaxHeader", "x", paxLine("size=-1"));
    expect(() => listTarEntries(concat(badSize, member("safe.txt", "0")))).toThrow(
      /unreadable pax size/,
    );
  });
});

const END = new Uint8Array(1024);

/**
 * One ustar header block with a valid checksum (unless `badChecksum`).
 * `sizeField` is what the header claims, independent of any body after it.
 */
function header(
  name: string,
  typeflag: string,
  opts: { sizeField?: number; link?: string; badChecksum?: boolean } = {},
): Uint8Array {
  const enc = new TextEncoder();
  const h = new Uint8Array(512);
  h.set(enc.encode(name), 0);
  h.set(enc.encode(`${(opts.sizeField ?? 0).toString(8).padStart(11, "0")}\0`), 124);
  h[156] = typeflag.charCodeAt(0);
  if (opts.link) h.set(enc.encode(opts.link), 157);
  h.set(enc.encode("ustar\0"), 257);
  h.fill(0x20, 148, 156);
  const sum = h.reduce((n, b) => n + b, 0) + (opts.badChecksum ? 1 : 0);
  h.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return h;
}

/** A header plus its padded body. */
function member(name: string, typeflag: string, bodyText = "", opts: { link?: string } = {}) {
  const body = new TextEncoder().encode(bodyText);
  const out = new Uint8Array(512 + Math.ceil(body.length / 512) * 512);
  out.set(header(name, typeflag, { sizeField: body.length, link: opts.link }), 0);
  out.set(body, 512);
  return out;
}

/** One pax record; its leading length counts its own digits. */
function paxLine(kv: string): string {
  const base = ` ${kv}\n`;
  const len = String(base.length + 2).length + base.length;
  return `${len}${base}`;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

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
