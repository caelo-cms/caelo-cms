// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * #1579 — importing font-service must not load the WOFF2 toolchain.
 * fontverter loads wawoff2, whose Emscripten output sets up two 16 MiB
 * WebAssembly memories as it loads (~65 MB of heap); every process that
 * imports this package (the admin through plugin-host, its build
 * subprocess, the static generator) paid that before any font was
 * converted.
 *
 * The heap is read in a probe process of its own, never in the test runner,
 * which keeps earlier files' modules resident (docs/dev/build-memory.md).
 * The probe imports the package, lets the event loop run until two
 * readings agree, then imports fontverter itself and settles again. Had the
 * package loaded the toolchain already, that second import would add
 * nothing; so the growth it causes is what the package no longer carries.
 */
const PROBE = `
import { heapStats } from "bun:jsc";
const [entry, fontverter] = process.argv.slice(2);
async function settled() {
  let last = -1;
  for (let turn = 0; turn < 200; turn += 1) {
    Bun.gc(true);
    const now = heapStats().heapSize;
    if (turn > 0 && Math.abs(now - last) < 64 * 1024) return now;
    last = now;
    await Bun.sleep(25);
  }
  return last;
}
await import(entry);
const withPackage = await settled();
await import(fontverter);
const withToolchain = await settled();
console.log(JSON.stringify({ withPackage, withToolchain }));
`;

const MB = 2 ** 20;
let dir: string;
let probe: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "caelo-font-load-"));
  probe = join(dir, "probe.ts");
  await writeFile(probe, PROBE);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("font-service at import", () => {
  it("leaves the WOFF2 toolchain unloaded until a delivery is derived", async () => {
    const entry = resolve(import.meta.dir, "index.ts");
    const fontverter = createRequire(import.meta.path).resolve("fontverter");
    const run = Bun.spawn(["bun", "run", probe, entry, fontverter], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(err.trim() === "" || code === 0 ? code : err).toBe(0);
    const seen = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as {
      withPackage: number;
      withToolchain: number;
    };
    // wawoff2's two memories alone are 32 MiB; measured +65 MB on a laptop.
    expect(seen.withToolchain - seen.withPackage).toBeGreaterThan(30 * MB);
  }, 60_000);
});
