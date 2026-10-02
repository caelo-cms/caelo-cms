// SPDX-License-Identifier: MPL-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncContents } from "./sync-contents.js";

const dirs: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sync-contents-"));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), body);
  }
  return root;
}
async function listing(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(`${childRel}/`, ...(await listing(root, childRel)));
    else out.push(childRel);
  }
  return out.sort();
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("syncContents", () => {
  it("removes a page that is gone, including its now-empty directory", async () => {
    // Regression: the empty-directory prune called rm() without
    // `recursive`, which always throws EISDIR — the first build after a
    // page disappeared failed the whole staging deploy.
    const dst = await tree({ "index.html": "old", "kontakt/index.html": "k" });
    const src = await tree({ "index.html": "new" });
    await syncContents(src, dst);
    expect(await listing(dst)).toEqual(["index.html"]);
    expect(await readFile(join(dst, "index.html"), "utf8")).toBe("new");
  });

  it("replaces a directory with a file and a file with a directory at the same path", async () => {
    const dst = await tree({ "a/index.html": "dir-form", b: "file-form" });
    const src = await tree({ a: "file-now", "b/index.html": "dir-now" });
    await syncContents(src, dst);
    expect(await listing(dst)).toEqual(["a", "b/", "b/index.html"]);
    expect(await readFile(join(dst, "a"), "utf8")).toBe("file-now");
  });

  it("keeps nested files and prunes only empty directories", async () => {
    const dst = await tree({ "x/y/z.html": "1", "x/keep.html": "2" });
    const src = await tree({ "x/keep.html": "3" });
    await syncContents(src, dst);
    expect(await listing(dst)).toEqual(["x/", "x/keep.html"]);
  });
});
