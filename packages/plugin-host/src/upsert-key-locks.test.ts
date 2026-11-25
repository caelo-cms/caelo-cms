// SPDX-License-Identifier: MPL-2.0

/**
 * #1659 — the locks a Stage takes for the upserted keys it lands: one per
 * key while a table has few, one for the whole table above that, so a
 * Stage of thousands of keys never fills the server's shared lock table.
 */

import { describe, expect, it } from "bun:test";
import {
  planStageLocks,
  STAGE_KEY_LOCKS_PER_TABLE,
  type StagedKey,
  type UpsertTableRef,
} from "./upsert-key-locks.js";

const PLUGIN = "11111111-1111-4111-8111-111111111111";
const entries: UpsertTableRef = { pluginId: PLUGIN, schema: "plugin_t", table: "entries" };
const terms: UpsertTableRef = { pluginId: PLUGIN, schema: "plugin_t", table: "terms" };

const keysOf = (table: UpsertTableRef, n: number): StagedKey[] =>
  Array.from({ length: n }, (_, i) => ({ table, key: { lang: "de", address: `a-${i}` } }));

describe("planStageLocks (#1659)", () => {
  it("locks each key under the table's shared lock while the table has few", () => {
    const plan = planStageLocks(keysOf(entries, 3));
    expect(plan.map((l) => l.mode)).toEqual(["shared", "exclusive", "exclusive", "exclusive"]);
    expect(JSON.parse(plan[0]?.name as string)).toEqual([PLUGIN, "plugin_t", "entries"]);
  });

  it("locks the table alone, exclusive, above the bound", () => {
    const atBound = planStageLocks(keysOf(entries, STAGE_KEY_LOCKS_PER_TABLE));
    expect(atBound).toHaveLength(STAGE_KEY_LOCKS_PER_TABLE + 1);
    const plan = planStageLocks(keysOf(entries, 5000));
    expect(plan).toEqual([
      { name: JSON.stringify([PLUGIN, "plugin_t", "entries"]), mode: "exclusive" },
    ]);
  });

  it("takes every table lock before any key lock, each group in one order", () => {
    const plan = planStageLocks([
      ...keysOf(terms, 2),
      ...keysOf(entries, STAGE_KEY_LOCKS_PER_TABLE + 1),
    ]);
    const names = plan.map((l) => JSON.parse(l.name) as unknown[]);
    // entries (many keys) is locked whole; terms keeps its two key locks.
    expect(plan.map((l) => l.mode)).toEqual(["exclusive", "shared", "exclusive", "exclusive"]);
    expect(names.slice(0, 2).map((n) => n[2])).toEqual(["entries", "terms"]);
    expect(names.slice(2).every((n) => n.length === 4 && n[2] === "terms")).toBe(true);
    const keyNames = plan.slice(2).map((l) => l.name);
    expect(keyNames).toEqual([...keyNames].sort());
  });

  it("names one lock for one key, however often and in whatever column order it comes", () => {
    const plan = planStageLocks([
      { table: entries, key: { lang: "de", address: "a" } },
      { table: entries, key: { address: "a", lang: "de" } },
    ]);
    expect(plan).toHaveLength(2);
  });
});
