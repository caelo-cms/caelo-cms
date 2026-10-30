// SPDX-License-Identifier: MPL-2.0

import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Every regular file below `dir`, as `/`-separated paths relative to it,
 * sorted. Directories are read one level at a time, so the walk holds
 * names only — never file contents.
 */
export async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(dir, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  await walk("");
  return out.sort();
}
