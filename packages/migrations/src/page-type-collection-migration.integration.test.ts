// SPDX-License-Identifier: MPL-2.0

/**
 * Migration 0450 — every page type's definition gets `collection`
 * (maintainer decision 2026-10-30), live rows and page_type snapshots
 * alike, replayed against a fixture inside one rolled-back transaction
 * (the page-type-confirmed migration test's pattern).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const MIGRATION = readFileSync(
  join(import.meta.dir, "..", "migrations", "cms_admin", "0450_page_type_collection.sql"),
  "utf8",
);

const PRE_0450 = `
CREATE TABLE page_types (slug text PRIMARY KEY, definition jsonb NOT NULL);
CREATE TABLE page_type_snapshots (id serial PRIMARY KEY, state jsonb NOT NULL);
`;

const def = (slug: string, extra = "") =>
  `{"slug":"${slug}","name":"${slug}","purpose":"p","properties":[]${extra}}`;

const FIXTURE = `
INSERT INTO page_types (slug, definition) VALUES
  ('home', '${def("home")}'),
  ('content', '${def("content")}'),
  ('landing', '${def("landing")}'),
  ('blog', '${def("blog")}'),
  ('doc', '${def("doc")}'),
  ('product', '${def("product")}'),
  ('events', '${def("events", ',"properties":[{"name":"starts","label":"Starts","type":"date"}]')}'),
  ('topics', '${def("topics", ',"vocabularies":[{"list":"00000000-0000-0000-0000-000000000001","cardinality":"many"}]')}'),
  ('kept', '${def("kept", ',"collection":true')}');
INSERT INTO page_type_snapshots (state) VALUES
  ('{"version":2,"definition":${def("blog")}}'),
  ('{"version":1,"definition":${def("content")}}');
`;

describe("migration 0450 (page type collection)", () => {
  it("backfills collection on live types and snapshots", async () => {
    const sql = new SQL(ADMIN_URL as string);
    const conn = await sql.reserve();
    try {
      await conn`BEGIN`;
      await conn.unsafe("CREATE SCHEMA t0450_mig");
      await conn.unsafe("SET LOCAL search_path = t0450_mig, public");
      await conn.unsafe(PRE_0450);
      await conn.unsafe(FIXTURE);
      await conn.unsafe(MIGRATION);

      const rows = (await conn`
        SELECT slug, definition->'collection' AS c FROM page_types ORDER BY slug
      `) as { slug: string; c: boolean }[];
      expect(Object.fromEntries(rows.map((r) => [r.slug, r.c]))).toEqual({
        blog: true,
        content: false,
        doc: true,
        events: true,
        home: false,
        kept: true,
        landing: false,
        product: true,
        topics: true,
      });
      const snaps = (await conn`
        SELECT state->'definition'->>'slug' AS slug, state->'definition'->'collection' AS c,
               state->'version' AS v
        FROM page_type_snapshots ORDER BY id
      `) as { slug: string; c: boolean; v: number }[];
      expect(snaps).toEqual([
        { slug: "blog", c: true, v: 2 },
        { slug: "content", c: false, v: 1 },
      ]);
    } finally {
      await conn`ROLLBACK`;
      conn.release();
      await sql.end();
    }
  });
});
