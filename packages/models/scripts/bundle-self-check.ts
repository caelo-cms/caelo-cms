// SPDX-License-Identifier: MPL-2.0

/**
 * `bun packages/models/scripts/bundle-self-check.ts <chunks dir>` — the
 * admin image's embedder self-check, run by the image's boot smoke (the
 * `admin-prod-image` job in .github/workflows/ci.yml).
 *
 * It embeds a probe query with every catalog model on both runtimes, taken
 * from the BUILT admin server (`apps/admin/build/server/chunks`), not from
 * this package's source: the admin runs its bundle, and how the bundle
 * reaches ONNX Runtime decides whether the runtime finds its WebAssembly
 * build and its native binding (apps/admin/vite.config.ts `ssr.external`).
 * Checking the source would pass while the bundle fails, which is how
 * 0.12.11 shipped an admin whose semantic queries could not load
 * `ort-wasm-simd-threaded.mjs`.
 *
 * Prints the report as one JSON line and exits non-zero when anything
 * failed, including when no chunk exports an embedder (the build moved it:
 * update this check, never skip it).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EmbedderFactory } from "../src/self-check.js";
import { checkEmbedders } from "../src/self-check.js";

/** The chunk exporting `name`, and the name it exports it under. */
function findExport(dir: string, name: string): { file: string; exported: string } {
  const pattern = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b(?:\\s+as\\s+([\\w$]+))?[^}]*\\}`);
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .flatMap((f) => {
      const m = pattern.exec(readFileSync(join(dir, f), "utf8"));
      return m ? [{ file: join(dir, f), exported: m[1] ?? name }] : [];
    });
  const [hit, ...more] = hits;
  if (!hit) throw new Error(`no chunk in ${dir} exports ${name}`);
  if (more.length > 0)
    throw new Error(
      `${hits.length} chunks in ${dir} export ${name}: ${hits.map((h) => h.file).join(", ")}`,
    );
  return hit;
}

/**
 * The runtime's factory. The chunk is imported inside the factory, so a
 * runtime whose bundle cannot load fails its own check and the other
 * runtime is still checked.
 */
function factoryOf(dir: string, name: string): EmbedderFactory {
  const { file, exported } = findExport(dir, name);
  return async (model) => {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const create = mod[exported];
    if (typeof create !== "function") throw new Error(`${file} exports no function ${exported}`);
    // One thread: the check proves loading and agreement, not speed.
    return create(model, { threads: 1 });
  };
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? "apps/admin/build/server/chunks");
  try {
    const report = await checkEmbedders({
      wasm: factoryOf(dir, "createWasmEmbedder"),
      native: factoryOf(dir, "createNativeEmbedder"),
    });
    console.log(JSON.stringify(report));
    process.exit(report.ok ? 0 : 1);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: (e as Error).message }));
    process.exit(1);
  }
}
