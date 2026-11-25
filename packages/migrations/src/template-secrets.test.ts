// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1689 — a value a migration draws at random is the template's in
 * every copy unless the template copy draws it again. Every migration that
 * draws one must say which per-install secret it seeds (template-secrets.ts
 * `INSTALL_SECRETS`, which the copy redraws) or why the value is no secret.
 * A plain `DEFAULT gen_random_uuid()` id column needs neither: a copy keeps
 * row ids, and an id signs nothing.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INSTALL_SECRETS } from "./template-secrets.js";

const DIR = resolve(import.meta.dir, "..", "migrations");

/** Migrations whose random values are not secrets, and why. */
const NOT_SECRETS: Readonly<Record<string, string>> = {
  "0093_p_v0_12_0_content_instances.sql": "ids of the content instances it backfills",
  "0198_p_issue_375_design_preview.sql":
    "one shared variant-set id for the drafts from before #375",
  "0353_list_fields_from_text_link_lists.sql": "ids of list items it converts",
  "0421_repair_jsonb_double_encoding.sql": "ids of list items it repairs",
};

/** A value drawn at random, other than a bare `DEFAULT gen_random_uuid()` column default. */
function drawsRandom(sql: string): boolean {
  const code = sql.replace(/--[^\n]*/g, "");
  const draws =
    code.match(/gen_random_uuid\(\)|gen_random_bytes\s*\(|\brandom\(\)|uuid_generate_v4\(\)/g) ??
    [];
  const bareDefaults = code.match(/DEFAULT\s+gen_random_uuid\(\)(?!\s*(?:::|\|\|))/gi)?.length ?? 0;
  return draws.length > bareDefaults;
}

describe("values migrations draw at random (#1689)", () => {
  const files = ["cms_admin", "cms_public"].flatMap((db) =>
    readdirSync(resolve(DIR, db))
      .filter((f) => f.endsWith(".sql"))
      .map((file) => ({ file, sql: readFileSync(resolve(DIR, db, file), "utf8") })),
  );

  it("finds a draw in the shapes migrations write (self-test)", () => {
    expect(drawsRandom("id uuid PRIMARY KEY DEFAULT gen_random_uuid(),")).toBe(false);
    expect(drawsRandom("key text DEFAULT replace(gen_random_uuid()::text, '-', '')")).toBe(true);
    expect(drawsRandom("SET k = encode(gen_random_bytes(32), 'hex')")).toBe(true);
    expect(drawsRandom("-- gen_random_bytes(32)")).toBe(false);
  });

  it("every migration that draws one seeds a listed per-install secret or explains why not", () => {
    const seeding = new Set(INSTALL_SECRETS.map((s) => s.migration));
    const unexplained = files
      .filter(({ sql }) => drawsRandom(sql))
      .map(({ file }) => file)
      .filter((file) => !seeding.has(file) && NOT_SECRETS[file] === undefined);
    expect(unexplained).toEqual([]);
  });

  it("every listed secret is a column its migration writes, and every exemption still draws", () => {
    for (const s of INSTALL_SECRETS) {
      const file = files.find((f) => f.file === s.migration);
      expect({ secret: s.column, file: file?.file }).toEqual({
        secret: s.column,
        file: s.migration,
      });
      expect(file?.sql).toContain(s.column);
      expect(drawsRandom(file?.sql ?? "")).toBe(true);
    }
    for (const file of Object.keys(NOT_SECRETS)) {
      expect({ file, draws: drawsRandom(files.find((f) => f.file === file)?.sql ?? "") }).toEqual({
        file,
        draws: true,
      });
    }
  });
});
