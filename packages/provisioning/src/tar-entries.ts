// SPDX-License-Identifier: MPL-2.0

/**
 * Read the member list of a tar archive WITHOUT extracting it, so a restore
 * can refuse an archive before `tar -x` writes anything (PR #755 review: an
 * absolute or `../` member, or a member written through a symlink, would
 * otherwise land outside the target directory).
 *
 * Parses ustar headers plus the two extensions GNU tar and bsdtar emit for
 * long names: GNU `L`/`K` records and pax `x`/`g` records (`path=`,
 * `linkpath=`). Anything it cannot read is an error, never a skipped member.
 */

const BLOCK = 512;

export type TarEntryType = "file" | "directory" | "symlink" | "other";

export interface TarEntry {
  readonly name: string;
  readonly type: TarEntryType;
  /** The link target, for symlinks. */
  readonly linkTarget?: string;
}

/** Every member of an (uncompressed) tar archive, in archive order. */
export function listTarEntries(tar: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let paxPath: string | null = null;
  let paxLink: string | null = null;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const size = octal(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    if (body.length < size) throw new Error("truncated tar archive");
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === "L") {
      longName = cString(body);
      continue;
    }
    if (typeflag === "K") {
      longLink = cString(body);
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      const pax = paxRecords(body);
      if (typeflag === "x") {
        paxPath = pax.path ?? null;
        paxLink = pax.linkpath ?? null;
      }
      continue;
    }
    const prefix = cString(header.subarray(345, 500));
    const shortName = cString(header.subarray(0, 100));
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    const link = paxLink ?? longLink ?? cString(header.subarray(157, 257));
    longName = longLink = paxPath = paxLink = null;
    const type: TarEntryType =
      typeflag === "0" || typeflag === "\0" || typeflag === "7"
        ? "file"
        : typeflag === "5"
          ? "directory"
          : typeflag === "2"
            ? "symlink"
            : "other";
    entries.push(type === "symlink" ? { name, type, linkTarget: link } : { name, type });
  }
  return entries;
}

/** `./a/b/` → `a/b`; the archive root (`./`) → "". */
export function normalizeMemberName(name: string): string {
  return name.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

/** Whether a member name could write outside the extraction directory. */
export function escapesRoot(name: string): boolean {
  return name.startsWith("/") || name.split("/").some((part) => part === "..");
}

function octal(field: Uint8Array): number {
  const text = cString(field).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`unreadable tar header size ${JSON.stringify(text)}`);
  return Number.parseInt(text, 8);
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** pax records: `<len> <key>=<value>\n`, repeated; `<len>` counts bytes. */
function paxRecords(body: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  let i = 0;
  while (i < body.length && body[i] !== 0) {
    const space = body.indexOf(0x20, i);
    if (space === -1) throw new Error("unreadable pax header");
    const len = Number.parseInt(decode(body.subarray(i, space)), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > body.length) {
      throw new Error("unreadable pax header");
    }
    const record = decode(body.subarray(space + 1, i + len - 1));
    const eq = record.indexOf("=");
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}
