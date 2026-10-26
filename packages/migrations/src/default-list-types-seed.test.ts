// SPDX-License-Identifier: MPL-2.0

/**
 * Migration 0352 seeds the shipped list types as stored data. The seed's
 * JSON literal must be exactly `DEFAULT_LIST_TYPES` — the tests and the
 * editor's "reset to shipped" reasoning rely on the two being one source
 * (docs/lists.md §3). A drift here means the migration ships a different
 * type than the code documents.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkListTypeDef, DEFAULT_LIST_TYPES, listTypeDefSchema } from "@caelo-cms/shared";

const SEED = resolve(
  import.meta.dir,
  "..",
  "migrations",
  "cms_admin",
  "0352_seed_default_list_types.sql",
);

function seedJson(): unknown {
  const sql = readFileSync(SEED, "utf8");
  const m = /-- caelo:seed-json-begin\n\$seed\$\n([\s\S]*?)\n\$seed\$\n-- caelo:seed-json-end/.exec(
    sql,
  );
  if (!m?.[1]) throw new Error("0352: seed JSON markers not found");
  return JSON.parse(m[1]);
}

describe("migration 0352 — default list types seed", () => {
  it("seeds exactly DEFAULT_LIST_TYPES", () => {
    expect(seedJson()).toEqual(JSON.parse(JSON.stringify(DEFAULT_LIST_TYPES)));
  });

  it("every seeded type is a valid definition", () => {
    for (const def of seedJson() as unknown[]) {
      const parsed = listTypeDefSchema.parse(def);
      expect(checkListTypeDef(parsed)).toEqual([]);
    }
  });
});
