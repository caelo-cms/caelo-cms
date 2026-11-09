// SPDX-License-Identifier: MPL-2.0

/**
 * #1292 — the read rule: which `list()` shapes an index can drive.
 * Pure; the catalog side is `plugin-indexes.integration.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { listAccessOfFilter } from "@caelo-cms/plugin-sdk";
import {
  type ListIndexAccess,
  listAccessOf,
  listIndexRefusal,
  readsByColumn,
} from "./index-coverage.js";
import { parseListFilter } from "./storage-ops.js";

const read = (
  access: Partial<ListIndexAccess>,
  leads: string[] = ["id", "status"],
  zone: "schema" | "adminSchema" = "schema",
  hashed: string[] = [],
) =>
  listIndexRefusal({
    label: "plugin_public_storage.list",
    zone,
    table: "entries",
    leads: { any: new Set([...leads, ...hashed]), ordered: new Set(leads) },
    access: { equals: [], anyOf: [], orderBy: null, createdAtRange: false, ...access },
  });

describe("listIndexRefusal", () => {
  it("allows a read with only a limit, and reads driven by an index's first column or id", () => {
    expect(read({})).toBeNull();
    expect(read({ equals: ["status"], orderBy: "created_at" })).toBeNull();
    expect(read({ anyOf: ["status"] })).toBeNull();
    expect(read({ equals: ["id"] })).toBeNull();
    expect(read({ orderBy: "id" })).toBeNull();
    // An indexed filter narrows; a second, unindexed one is fine.
    expect(read({ equals: ["status", "body"] })).toBeNull();
  });

  it("refuses a filter no index leads with, naming the index to declare", () => {
    const r = read({ equals: ["page_id"], orderBy: "created_at" });
    expect(r).toContain('no index covers this read of "entries" (it filters by page_id)');
    expect(r).toContain('indexes: { schema: { entries: [["page_id","created_at"]] } }');
  });

  it("does not let an indexed order column drive a filtered read", () => {
    // Paging by id while filtering would walk the whole primary key.
    expect(read({ anyOf: ["page_id"], orderBy: "id" })).toContain("filters by page_id");
    expect(read({ anyOf: ["page_id"], orderBy: "id" })).toContain('[["page_id","id"]]');
  });

  it("refuses an unfiltered order or since/before range on an unindexed column", () => {
    expect(read({ orderBy: "created_at" })).toContain("orders by created_at");
    expect(read({ createdAtRange: true, orderBy: "created_at" })).toContain('[["created_at"]]');
    expect(read({ createdAtRange: true }, ["id", "created_at"])).toBeNull();
  });

  it("names the private-storage key for adminSchema tables", () => {
    expect(read({ equals: ["group_id"] }, ["id"], "adminSchema")).toContain(
      "indexes: { adminSchema: { entries:",
    );
  });
});

describe("hash indexes", () => {
  it("drive equality and anyOf filters, never an order", () => {
    expect(read({ equals: ["email"] }, ["id"], "schema", ["email"])).toBeNull();
    expect(read({ anyOf: ["email"] }, ["id"], "schema", ["email"])).toBeNull();
    expect(read({ orderBy: "email" }, ["id"], "schema", ["email"])).toContain("orders by email");
  });

  it("do not drive an IS NULL filter (hash supports only =)", () => {
    const nullRead = { equals: ["email"], isNull: ["email"] };
    expect(read(nullRead, ["id"], "schema", ["email"])).toContain("filters by email");
    expect(read(nullRead, ["id", "email"])).toBeNull();
  });
});

describe("readsByColumn", () => {
  it("is false only for a limit-only read", () => {
    const none = { equals: [], anyOf: [], orderBy: null, createdAtRange: false };
    expect(readsByColumn(none)).toBe(false);
    expect(readsByColumn({ ...none, orderBy: "id" })).toBe(true);
    expect(readsByColumn({ ...none, createdAtRange: true })).toBe(true);
    expect(readsByColumn({ ...none, anyOf: ["x"] })).toBe(true);
  });
});

describe("listAccessOf and the SDK's listAccessOfFilter (#1536)", () => {
  // A plugin's unit tests apply the rule to the raw filter
  // (`indexCheckedQuery`); this host to the parsed one. They must agree.
  const columns = { status: "string", email: "string", page_id: "uuid", created_at: "timestamp" };
  const filters: Record<string, unknown>[] = [
    {},
    { limit: 5 },
    { status: "x" },
    { status: null, limit: 1 },
    { anyOf: { page_id: ["a"], email: ["b"] }, status: "x" },
    { orderBy: "created_at", orderDir: "asc" },
    { orderBy: "id", orderDir: "asc", afterId: "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b" },
    { since: "2026-01-01T00:00:00Z" },
    { before: "2026-01-01T00:00:00Z", orderBy: "created_at" },
  ];
  for (const filter of filters) {
    it(JSON.stringify(filter), () => {
      const plan = parseListFilter("probe.list", columns, filter);
      if (typeof plan === "string") throw new Error(plan);
      expect(listAccessOfFilter(filter)).toEqual(listAccessOf(plan));
    });
  }
});
