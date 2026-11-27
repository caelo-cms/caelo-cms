// SPDX-License-Identifier: MPL-2.0

/**
 * Writes the format-2 release this directory holds (#1780): run it from a
 * checkout of the engine before segment format 3 (commit cb4dc0bf8 or
 * older), with the directory to write into:
 *
 *   bun <old checkout>/…/make.ts <old checkout>/packages/collection-index/src <out dir>
 *
 * format2.test.ts reads it with today's engine: a live release built
 * before an upgrade must keep answering until the next Stage rebuilds it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [engineDir, outDir] = process.argv.slice(2) as [string, string];
const engine = await import(join(engineDir, "index.ts"));
mkdirSync(outDir, { recursive: true });
const docs = [
  ["preise", "Preise und Rabatte", "Was die Logfile-Analyse kostet: Preise pro Monat."],
  ["versand", "Versand", "Wir liefern in die Schweiz und nach Österreich."],
  ["kontakt", "Kontakt", "So erreichen Sie unser Team."],
  ["crawler", "Crawler", "Der Crawler prüft große Websites jede Nacht."],
].map(([id, title, text]) => ({
  id: id as string,
  lang: "de",
  values: {
    title: title as string,
    url: `/${id}`,
    sections: [{ anchor: "a", heading: title as string, text: text as string }],
  },
}));
const embed = async (texts: readonly string[]) =>
  texts.map((t) =>
    Float32Array.from({ length: 16 }, (_v, j) => ((t.charCodeAt(j % t.length) * (j + 1)) % 17) - 8),
  );
const built = await engine.buildRelease(docs, {
  schema: {
    fields: {
      title: { kind: "text" },
      url: { kind: "keyword" },
      sections: { kind: "passages", vector: true },
    },
  },
  sink: (name: string, data: Uint8Array) => writeFileSync(join(outDir, name), data),
  embed,
  vectorModel: { id: "fake-16", dims: 16 },
});
console.log(built.file);
