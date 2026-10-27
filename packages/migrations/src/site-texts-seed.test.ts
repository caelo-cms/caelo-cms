// SPDX-License-Identifier: MPL-2.0

/**
 * Migration 0358 seeds the `site-texts` list type (#1142). The JSON
 * literal between its markers must be exactly `SITE_TEXTS_TYPE` — the
 * resolver and the tests share that object, so the two cannot drift.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkListTypeDef, listTypeDefSchema, SITE_TEXTS_TYPE } from "@caelo-cms/shared";

const SEED = resolve(
  import.meta.dir,
  "..",
  "migrations",
  "cms_admin",
  "0358_breadcrumbs_short_title_site_texts.sql",
);

function seedJson(): unknown {
  const sql = readFileSync(SEED, "utf8");
  const m = /-- caelo:seed-json-begin\n\$seed\$\n([\s\S]*?)\n\$seed\$\n-- caelo:seed-json-end/.exec(
    sql,
  );
  if (!m?.[1]) throw new Error("0358: seed JSON markers not found");
  return JSON.parse(m[1]);
}

describe("migration 0358 — site texts list type seed", () => {
  it("seeds exactly SITE_TEXTS_TYPE", () => {
    expect(seedJson()).toEqual(JSON.parse(JSON.stringify(SITE_TEXTS_TYPE)));
  });

  // Codex review on #1168: with international-site active every text
  // field is translated unless it opts out. A translated key would make
  // `{{site_text.<key>}}` miss the entry in that language; the key is code.
  it("only the text is translated, never the lookup key", () => {
    const fields = (seedJson() as typeof SITE_TEXTS_TYPE).nodes.text?.fields ?? [];
    expect(fields.find((f) => f.name === "key")?.ext).toEqual({
      "international-site": { translate: false },
    });
    expect(fields.find((f) => f.name === "text")?.ext).toBeUndefined();
  });

  it("the seeded type is a valid definition", () => {
    const parsed = listTypeDefSchema.parse(seedJson());
    expect(checkListTypeDef(parsed)).toEqual([]);
  });
});
