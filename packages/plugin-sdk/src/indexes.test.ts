// SPDX-License-Identifier: MPL-2.0

/**
 * #1292 — the manifest's `indexes` declaration (what it accepts and
 * refuses, adversarial shapes included) and the one projection carrying it
 * into the signed manifest. (The read rule: plugin-host index-coverage.)
 */

import { describe, expect, it } from "bun:test";
import {
  manifestFromDefinition,
  normalizePluginIndexes,
  PLUGIN_INDEX_MAX_COLUMNS,
  PLUGIN_INDEXES_MAX_PER_TABLE,
  pluginManifest,
} from "./index.js";

const SCHEMA = {
  entries: {
    page_id: "string",
    status: "enum:new,done",
    body: "text",
    data: "jsonb",
    created_at: "timestamp",
  },
};
const ADMIN_SCHEMA = {
  variants: { page_id: "ref:pages:cascade", group_id: "uuid", locale_code: "string" },
};

function manifest(indexes: unknown) {
  return pluginManifest.safeParse({
    slug: "probe",
    version: "1.0.0",
    tier: 1,
    schema: SCHEMA,
    tableKinds: { entries: "inbox" },
    adminSchema: ADMIN_SCHEMA,
    requestedCapabilities: ["cms_admin_schema"],
    operations: ["noop"],
    indexes,
  });
}

function messages(r: ReturnType<typeof manifest>): string {
  return r.success ? "" : r.error.issues.map((i) => i.message).join("\n");
}

describe("pluginManifest — indexes", () => {
  it("accepts column lists, the object form and a unique public index", () => {
    const r = manifest({
      schema: {
        entries: [["page_id", "status"], { columns: ["status", "created_at"] }, ["status", "id"]],
      },
      adminSchema: { variants: [["group_id", "locale_code"]] },
    });
    expect(messages(r)).toBe("");
    expect(
      manifest({ schema: { entries: [{ columns: ["page_id"], unique: true }] } }).success,
    ).toBe(true);
  });

  it("refuses a table the zone does not declare", () => {
    expect(messages(manifest({ schema: { variants: [["group_id"]] } }))).toContain(
      'names table "variants", which schema does not declare',
    );
  });

  it("refuses an undeclared column", () => {
    expect(messages(manifest({ schema: { entries: [["author"]] } }))).toContain(
      'column "author" is not declared on schema.entries',
    );
  });

  it("refuses host-owned caelo_ columns", () => {
    expect(
      messages(manifest({ adminSchema: { variants: [["caelo_chat_branch_id", "group_id"]] } })),
    ).toContain("host-owned");
  });

  it("refuses a jsonb column, id as the first column and a repeated column", () => {
    expect(messages(manifest({ schema: { entries: [["data"]] } }))).toContain("jsonb");
    expect(messages(manifest({ schema: { entries: [["id", "status"]] } }))).toContain(
      "primary key",
    );
    expect(messages(manifest({ schema: { entries: [["status", "status"]] } }))).toContain(
      "appears twice",
    );
  });

  it("refuses the same index twice", () => {
    expect(
      messages(manifest({ schema: { entries: [["status"], { columns: ["status"] }] } })),
    ).toContain("declared twice");
  });

  it("accepts a one-column hash index and refuses a wide or unique one", () => {
    expect(manifest({ schema: { entries: [{ columns: ["body"], method: "hash" }] } }).success).toBe(
      true,
    );
    expect(
      messages(
        manifest({ schema: { entries: [{ columns: ["body", "status"], method: "hash" }] } }),
      ),
    ).toContain("hash index covers exactly one column");
    expect(
      messages(
        manifest({ schema: { entries: [{ columns: ["body"], method: "hash", unique: true }] } }),
      ),
    ).toContain("cannot be unique");
    expect(manifest({ schema: { entries: [{ columns: ["body"], method: "gin" }] } }).success).toBe(
      false,
    );
  });

  it("refuses unique indexes on private storage", () => {
    expect(
      messages(manifest({ adminSchema: { variants: [{ columns: ["group_id"], unique: true }] } })),
    ).toContain("only available in indexes.schema");
  });

  it("refuses an index the host already builds for a ref: column", () => {
    expect(messages(manifest({ adminSchema: { variants: [["page_id"]] } }))).toContain(
      "already indexes",
    );
    // As the first column of a wider index it is a different index.
    expect(manifest({ adminSchema: { variants: [["page_id", "locale_code"]] } }).success).toBe(
      true,
    );
  });

  it("bounds the declaration: columns per index, indexes per table, identifiers, unknown keys", () => {
    const wide = Array.from({ length: PLUGIN_INDEX_MAX_COLUMNS + 1 }, () => "status");
    expect(manifest({ schema: { entries: [wide] } }).success).toBe(false);
    const many = Array.from({ length: PLUGIN_INDEXES_MAX_PER_TABLE + 1 }, () => ["status"]);
    expect(manifest({ schema: { entries: many } }).success).toBe(false);
    expect(manifest({ schema: { entries: [[]] } }).success).toBe(false);
    expect(manifest({ schema: { entries: [['status"; DROP TABLE x; --']] } }).success).toBe(false);
    expect(manifest({ schema: { entries: [{ columns: ["status"], where: "1=1" }] } }).success).toBe(
      false,
    );
    expect(manifest({ other: {} }).success).toBe(false);
  });
});

describe("manifestFromDefinition — indexes", () => {
  it("carries the declaration into the signed manifest, and leaves an empty one out", () => {
    const base = {
      slug: "probe",
      version: "1.0.0",
      tier: 1 as const,
      schema: SCHEMA,
      tableKinds: { entries: "inbox" as const },
      operations: { noop: async () => null },
    };
    const indexes = { schema: { entries: [["status", "created_at"]] } };
    expect(manifestFromDefinition({ ...base, indexes }).indexes).toEqual(indexes);
    expect("indexes" in manifestFromDefinition({ ...base, indexes: {} })).toBe(false);
  });
});

describe("normalizePluginIndexes", () => {
  it("resolves the shorthand and keeps the column order", () => {
    expect(normalizePluginIndexes([["b", "a"], { columns: ["c"], unique: true }])).toEqual([
      { columns: ["b", "a"], unique: false, method: "btree" },
      { columns: ["c"], unique: true, method: "btree" },
    ]);
  });
});
