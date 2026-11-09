// SPDX-License-Identifier: MPL-2.0

/**
 * #1536 — the read rule as a plugin's unit tests apply it: index leads
 * derived from the manifest, and a fake store that refuses what the host
 * refuses. (The rule itself: plugin-host `index-coverage.test.ts`; the
 * derivation against the catalog: admin-core
 * `plugin-indexes-shipped.integration.test.ts`.)
 */

import { describe, expect, it } from "bun:test";
import { declaredIndexLeads, indexCheckedQuery, listAccessOfFilter } from "./index-coverage.js";

const manifest = {
  schema: { entries: { slug: "string", status: "string", email: "string" } },
  adminSchema: {
    notes: { page_id: "ref:pages:cascade", locale_code: "string", address: "string" },
  },
  indexes: {
    schema: { entries: [["status", "slug"], { columns: ["email"], method: "hash" as const }] },
    adminSchema: { notes: [["locale_code", "address"]] },
  },
};

describe("declaredIndexLeads", () => {
  it("holds the primary key and each declared index's first column; a hash index never orders", () => {
    const leads = declaredIndexLeads({
      zone: "schema",
      columns: manifest.schema.entries,
      indexes: manifest.indexes,
      table: "entries",
    });
    expect([...leads.any].sort()).toEqual(["email", "id", "status"]);
    expect([...leads.ordered].sort()).toEqual(["id", "status"]);
  });

  it("adds the ref: columns and the branch column in private storage", () => {
    const leads = declaredIndexLeads({
      zone: "adminSchema",
      columns: manifest.adminSchema.notes,
      indexes: manifest.indexes,
      table: "notes",
    });
    expect([...leads.ordered].sort()).toEqual([
      "caelo_chat_branch_id",
      "id",
      "locale_code",
      "page_id",
    ]);
  });

  it("is the primary key alone for a table that declares nothing", () => {
    const leads = declaredIndexLeads({
      zone: "schema",
      columns: {},
      indexes: undefined,
      table: "x",
    });
    expect([...leads.any]).toEqual(["id"]);
  });
});

describe("listAccessOfFilter", () => {
  it("splits the column filters from the options", () => {
    expect(
      listAccessOfFilter({
        status: null,
        anyOf: { slug: ["a"] },
        orderBy: "created_at",
        orderDir: "asc",
        limit: 3,
        before: "2026-01-01T00:00:00Z",
      }),
    ).toEqual({
      equals: ["status"],
      isNull: ["status"],
      anyOf: ["slug"],
      orderBy: "created_at",
      createdAtRange: true,
    });
  });
});

describe("indexCheckedQuery", () => {
  const rows = [{ id: "r1" }];
  const inner = { list: async () => rows, insert: async () => ({ id: "r2" }) };

  it("answers a read an index drives and passes the other methods through", async () => {
    const q = indexCheckedQuery(manifest, "adminSchema", inner);
    expect(await q.list("notes", { locale_code: "de", anyOf: { address: ["a"] } })).toEqual(rows);
    expect(await q.list("notes", { page_id: "p" })).toEqual(rows);
    expect(await q.list("notes", { limit: 1 })).toEqual(rows);
    expect(await q.insert()).toEqual({ id: "r2" });
  });

  it("throws the host's refusal for a read no declared index drives (#1536)", async () => {
    const q = indexCheckedQuery(manifest, "adminSchema", inner);
    await expect(q.list("notes", { anyOf: { address: ["a"] } })).rejects.toThrow(
      'plugin_storage.list: no index covers this read of "notes" (it filters by address)',
    );
  });

  it("names the public zone's operation, and refuses an order a hash index cannot give", async () => {
    const q = indexCheckedQuery(manifest, "schema", inner);
    expect(await q.list("entries", { email: "a@b.c" })).toEqual(rows);
    await expect(q.list("entries", { orderBy: "email" })).rejects.toThrow(
      'plugin_public_storage.list: no index covers this read of "entries" (it orders by email)',
    );
  });

  it("refuses a table the zone does not declare", async () => {
    const q = indexCheckedQuery(manifest, "schema", inner);
    await expect(q.list("notes", {})).rejects.toThrow('table "notes" is not declared in schema');
  });
});
