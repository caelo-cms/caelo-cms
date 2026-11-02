// SPDX-License-Identifier: MPL-2.0

/**
 * #1292 — the index DDL both schema emitters write: declared indexes,
 * the automatic ones of private storage, deterministic length-safe names,
 * and the drop of indexes a new version no longer declares. Pure; the
 * database side is `plugin-host/src/plugin-indexes.integration.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import {
  adminSchemaFromSpec,
  PLUGIN_INDEX_PREFIX,
  PRIVATE_LIVE_ROW_PREDICATE,
  pluginIndexName,
  schemaFromSpec,
} from "./index.js";

const PID = "11111111-1111-4111-8111-111111111111";

describe("pluginIndexName", () => {
  it("is deterministic, prefixed and within Postgres' 63-byte limit", () => {
    const a = pluginIndexName("entries", ["status", "created_at"], false, "");
    expect(a).toBe(pluginIndexName("entries", ["status", "created_at"], false, ""));
    expect(a.startsWith(`${PLUGIN_INDEX_PREFIX}entries_status_created_at_`)).toBe(true);
    const long = pluginIndexName(
      "t".repeat(60),
      ["c".repeat(60), "d".repeat(60), "e".repeat(60), "f".repeat(60)],
      false,
      "",
    );
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9_]+_[0-9a-f]{8}$/);
  });

  it("changes with every part of the definition, so a changed index is rebuilt", () => {
    const base = pluginIndexName("t", ["a", "b"], false, "");
    expect(pluginIndexName("t", ["b", "a"], false, "")).not.toBe(base);
    expect(pluginIndexName("t", ["a", "b"], true, "")).not.toBe(base);
    expect(pluginIndexName("t", ["a", "b"], false, PRIVATE_LIVE_ROW_PREDICATE)).not.toBe(base);
    // Two long definitions sharing the readable prefix still get two names.
    const long = "x".repeat(60);
    expect(pluginIndexName("t", [long, "a"], false, "")).not.toBe(
      pluginIndexName("t", [long, "b"], false, ""),
    );
  });
});

describe("schemaFromSpec — indexes", () => {
  const schema = { entries: { status: "string", created_at: "timestamp" } };

  it("emits declared (and unique) indexes on the whole table, and no host index", () => {
    const { sql } = schemaFromSpec({
      tableKinds: Object.fromEntries(Object.keys(schema).map((t) => [t, "visitor-state" as const])),
      pluginId: PID,
      slug: "probe",
      schema,
      indexes: { entries: [["status", "created_at"], { columns: ["created_at"], unique: true }] },
    });
    const name = pluginIndexName("entries", ["status", "created_at"], false, "");
    expect(sql).toContain(
      `CREATE INDEX IF NOT EXISTS "${name}" ON "plugin_probe"."entries" ("status", "created_at");`,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "caelo_ix_entries_created_at_[0-9a-f]{8}"/,
    );
    expect(sql).not.toContain("caelo_chat_branch_id");
  });

  it("drops the table's caelo_ix_ indexes it does not emit — all of them when none is declared", () => {
    const { sql } = schemaFromSpec({
      tableKinds: Object.fromEntries(Object.keys(schema).map((t) => [t, "visitor-state" as const])),
      pluginId: PID,
      slug: "probe",
      schema,
      indexes: undefined,
    });
    expect(sql).toContain("starts_with(indexname, 'caelo_ix_')");
    expect(sql).toContain("indexname <> ALL (ARRAY[]::text[])");
    expect(sql).toContain("EXECUTE format('DROP INDEX %I.%I', 'plugin_probe', ix);");
  });

  it("refuses indexes on an undeclared table or column, a jsonb or caelo_ column", () => {
    const emit = (indexes: Record<string, string[][]>) =>
      schemaFromSpec({
        tableKinds: { entries: "visitor-state" },
        pluginId: PID,
        slug: "probe",
        schema: { entries: { status: "string", data: "jsonb" } },
        indexes,
      });
    expect(() => emit({ other: [["status"]] })).toThrow('names table "other"');
    expect(() => emit({ entries: [["missing"]] })).toThrow('cannot index "missing"');
    expect(() => emit({ entries: [["data"]] })).toThrow('cannot index "data"');
    expect(() => emit({ entries: [["caelo_deleted_at"]] })).toThrow("cannot index");
  });
});

describe("adminSchemaFromSpec — indexes", () => {
  const adminSchema = {
    variants: { page_id: "ref:pages:cascade", group_id: "uuid", locale_code: "string" },
  };

  it("makes declared indexes partial on the live main-line rows the host reads", () => {
    const { sql } = adminSchemaFromSpec({
      pluginId: PID,
      slug: "probe",
      adminSchema,
      indexes: { variants: [["group_id", "locale_code"]] },
    });
    const name = pluginIndexName(
      "variants",
      ["group_id", "locale_code"],
      false,
      PRIVATE_LIVE_ROW_PREDICATE,
    );
    expect(sql).toContain(
      `CREATE INDEX IF NOT EXISTS "${name}" ON "plugin_probe"."variants" ("group_id", "locale_code") WHERE ${PRIVATE_LIVE_ROW_PREDICATE};`,
    );
  });

  it("indexes every ref: column and the branch column without a declaration", () => {
    const { sql } = adminSchemaFromSpec({
      pluginId: PID,
      slug: "probe",
      adminSchema,
      indexes: undefined,
    });
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "caelo_ix_variants_page_id_[0-9a-f]{8}" ON "plugin_probe"\."variants" \("page_id"\);/,
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "caelo_ix_variants_caelo_chat_branch_id_[0-9a-f]{8}" ON "plugin_probe"\."variants" \("caelo_chat_branch_id"\) WHERE "caelo_chat_branch_id" IS NOT NULL;/,
    );
  });

  it("refuses a unique private-storage index", () => {
    expect(() =>
      adminSchemaFromSpec({
        pluginId: PID,
        slug: "probe",
        adminSchema,
        indexes: { variants: [{ columns: ["group_id"], unique: true }] },
      }),
    ).toThrow("cms_public only");
  });
});
