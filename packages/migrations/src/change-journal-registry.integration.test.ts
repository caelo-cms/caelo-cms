// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — no `cms_admin` table can fall outside the change journal
 * silently (docs/dev/state-and-changes.md, rule 2).
 *
 * Every table of the migrated database is either journaled — its four
 * journal triggers carry exactly the arguments the readable registry
 * (`packages/shared/src/change-journal.ts`) names — or exempt there with a
 * written reason. A new table that is neither fails this test, and so does
 * a registry entry that does not match the triggers the migrations attach.
 * Plugin schemas are covered too: every table of a `plugin_<slug>` schema
 * is journaled under `plugin_storage`, keyed on its plugin's id.
 */

import { describe, expect, it } from "bun:test";
import {
  isJournalKind,
  JOURNAL_EXEMPT_TABLES,
  JOURNALED_TABLES,
  type JournaledTable,
} from "@caelo-cms/shared";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

interface TriggerRow {
  schema: string;
  table: string;
  trigger: string;
  args: string[];
}

async function journalTriggers(): Promise<TriggerRow[]> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    // tgargs is a bytea of NUL-terminated strings: decoded here, because a
    // NUL cannot pass through a text value.
    const rows = (await sql`
      SELECT n.nspname AS schema, c.relname AS "table", t.tgname AS trigger,
             encode(t.tgargs, 'hex') AS hex
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE t.tgname LIKE 'caelo_journal_%' AND NOT t.tgisinternal
    `) as { schema: string; table: string; trigger: string; hex: string }[];
    return rows.map((r) => {
      const text = Buffer.from(r.hex, "hex").toString("utf8");
      return {
        schema: r.schema,
        table: r.table,
        trigger: r.trigger,
        args: text.split("\0").slice(0, -1),
      };
    });
  } finally {
    await sql.end();
  }
}

async function tablesOf(schemaPattern: string): Promise<{ schema: string; table: string }[]> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql`
      SELECT n.nspname AS schema, c.relname AS "table"
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname LIKE ${schemaPattern}
       ORDER BY 1, 2
    `) as { schema: string; table: string }[];
  } finally {
    await sql.end();
  }
}

/** The trigger arguments `caelo_journal_attach` passes for a registry entry. */
function expectedArgs(t: JournaledTable): string[] {
  return [
    t.kind,
    t.key,
    t.mode,
    t.pair.join(","),
    t.parent ?? "",
    t.branch ?? "",
    t.plugin ?? "",
    "",
  ];
}

const EVENTS = [
  "caelo_journal_insert",
  "caelo_journal_update",
  "caelo_journal_delete",
  "caelo_journal_truncate",
];

describe("#1267 — the change journal's registered table set", () => {
  it("every cms_admin table is journaled or exempt with a reason, never both, never neither", async () => {
    const tables = (await tablesOf("public")).map((t) => t.table);
    const unregistered = tables.filter(
      (t) => !(t in JOURNALED_TABLES) && !(t in JOURNAL_EXEMPT_TABLES),
    );
    // A new table must be added to packages/shared/src/change-journal.ts:
    // journaled (and attached in its migration with caelo_journal_attach)
    // or exempt with the reason nothing derives from it.
    expect(unregistered).toEqual([]);
    const both = tables.filter((t) => t in JOURNALED_TABLES && t in JOURNAL_EXEMPT_TABLES);
    expect(both).toEqual([]);
    const gone = [...Object.keys(JOURNALED_TABLES), ...Object.keys(JOURNAL_EXEMPT_TABLES)].filter(
      (t) => !tables.includes(t),
    );
    expect(gone).toEqual([]);
    for (const [t, reason] of Object.entries(JOURNAL_EXEMPT_TABLES)) {
      expect({ t, ok: reason.trim().length >= 10 }).toEqual({ t, ok: true });
    }
  });

  it("every journaled table carries exactly the registry's triggers, and no exempt table carries any", async () => {
    const triggers = (await journalTriggers()).filter((t) => t.schema === "public");
    for (const [table, spec] of Object.entries(JOURNALED_TABLES)) {
      expect(isJournalKind(spec.kind)).toBe(true);
      const mine = triggers.filter((t) => t.table === table);
      expect({ table, events: mine.map((t) => t.trigger).sort() }).toEqual({
        table,
        events: [...EVENTS].sort(),
      });
      for (const t of mine)
        expect({ table, args: t.args }).toEqual({ table, args: expectedArgs(spec) });
    }
    const onExempt = triggers.filter((t) => t.table in JOURNAL_EXEMPT_TABLES).map((t) => t.table);
    expect(onExempt).toEqual([]);
  });

  it("every plugin storage table is journaled under its plugin's id", async () => {
    const tables = await tablesOf("plugin\\_%");
    const triggers = (await journalTriggers()).filter((t) => t.schema.startsWith("plugin_"));
    for (const { schema, table } of tables) {
      const mine = triggers.filter((t) => t.schema === schema && t.table === table);
      expect({ schema, table, events: mine.length }).toEqual({ schema, table, events: 4 });
      for (const t of mine) {
        expect(t.args.slice(0, 6)).toEqual([
          "plugin_storage",
          "id",
          "row",
          "id",
          "",
          "caelo_chat_branch_id",
        ]);
        expect(t.args[7]).toMatch(/^[0-9a-f-]{36}$/);
      }
    }
  });
});
