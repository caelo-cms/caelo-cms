// SPDX-License-Identifier: MPL-2.0

/**
 * #1340 — the host runs public operations from their declarations, and the
 * manifest lint refuses a declaration that reaches beyond the plugin:
 *
 * - insert: values from input, visitor, constants and the clock; checks
 *   against published and published-admin data; a honeypot that stores
 *   nothing or a marked row; drop patterns for personal data;
 * - list: filter by input (optional), order, bound, only named columns;
 * - lint (adversarial): another plugin's table, an undeclared column, a
 *   private or admin table, a read that inserts, a block without its
 *   tables or capability, a public operation that is also code, reads and
 *   writes that do not cover the run.
 */

import { describe, expect, it } from "bun:test";
import {
  checkPublicSurface,
  definePlugin,
  isPublicOperationError,
  manifestFromDefinition,
  matchesDropPattern,
  type PluginContextTier1,
  type PublicOperationDef,
  pluginManifest,
  publicOperationManifestOf,
  z,
} from "@caelo-cms/plugin-sdk";
import { runDeclaredPublicOperation } from "./public-run-host.js";

type Row = Record<string, unknown>;

function fakeCtx(
  tables: Record<string, Row[]>,
  admin: Record<string, Row[]> = {},
  visitorId: string | null = null,
) {
  const inserted: { table: string; row: Row }[] = [];
  const lists: { table: string; filter: Row }[] = [];
  const q = (src: Record<string, Row[]>) => ({
    list: async (table: string, filter: Row = {}) => {
      lists.push({ table, filter });
      const rows = src[table] ?? [];
      return rows.filter((r) =>
        Object.entries(filter).every(
          ([k, v]) => ["limit", "orderBy", "orderDir"].includes(k) || r[k] === v,
        ),
      );
    },
    insert: async (table: string, row: Row) => {
      inserted.push({ table, row });
      return { id: `id-${inserted.length}` };
    },
  });
  const ctx = {
    query: q(tables),
    adminQuery: q(admin),
    visitor: { id: visitorId, publicUserId: null, ipHash: "", sessionToken: null },
    invocation: { origin: "visitor", actorId: "anonymous-visitor" },
  } as unknown as PluginContextTier1;
  return { ctx, inserted, lists };
}

const inboxOp: PublicOperationDef = {
  name: "send",
  kind: "write",
  input: z.object({}).passthrough(),
  writes: ["notes"],
  reads: ["settings"],
  run: {
    action: "insert",
    table: "notes",
    values: {
      text: { from: "input", field: "text", trim: true },
      page: { from: "input", field: "page", orElse: "" },
      who: { from: "visitor", key: "id" },
      kind: { from: "const", value: "note" },
      day: { from: "today" },
      tags: { from: "input", field: "tags", optional: true, distinct: true },
    },
    checks: [
      { check: "not-blank", field: "text", refusal: "text empty" },
      {
        check: "equals-row",
        field: "v",
        source: { table: "settings", of: "schema" },
        column: "version",
        refusal: "old version",
      },
      {
        check: "all-in",
        field: "cats",
        source: { table: "cats", of: "adminSchema" },
        column: "key",
        refusal: "unknown category",
      },
    ],
    honeypot: { field: "hp", store: "nothing", answer: { ok: true } },
    drop: { field: "text", patterns: ["email", "phone", "long-number"], answer: { ok: true } },
    answer: { ok: true, id: { from: "inserted-id" } },
  },
};

describe("insert runs", () => {
  const data = { settings: [{ version: 3 }] };
  const admin = { cats: [{ key: "a" }, { key: "b" }] };

  it("stores the resolved row and answers with the inserted id", async () => {
    const f = fakeCtx(data, admin, "vis-1");
    const r = await runDeclaredPublicOperation(inboxOp, f.ctx, {
      text: "  hello  ",
      v: 3,
      cats: ["a"],
      tags: ["x", "x", "y"],
    });
    expect(r).toEqual({ ok: true, id: "id-1" });
    const row = f.inserted[0]?.row as Row;
    expect(row).toMatchObject({
      text: "hello",
      page: "",
      who: "vis-1",
      kind: "note",
      tags: ["x", "y"],
    });
    expect(String(row.day)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("leaves an optional absent field out", async () => {
    const f = fakeCtx(data, admin);
    await runDeclaredPublicOperation(inboxOp, f.ctx, { text: "hi", v: 3, cats: [] });
    expect(Object.keys(f.inserted[0]?.row ?? {})).not.toContain("tags");
  });

  it("refuses failed checks as the visitor's refusal, storing nothing", async () => {
    for (const [args, words] of [
      [{ text: "   ", v: 3, cats: [] }, "text empty"],
      [{ text: "hi", v: 2, cats: [] }, "old version"],
      [{ text: "hi", v: 3, cats: ["zzz"] }, "unknown category"],
    ] as const) {
      const f = fakeCtx(data, admin);
      const e = await runDeclaredPublicOperation(inboxOp, f.ctx, args).catch((x) => x as Error);
      expect(isPublicOperationError(e)).toBe(true);
      expect((e as Error).message).toBe(words);
      expect(f.inserted).toEqual([]);
    }
  });

  it("answers a filled honeypot like success and stores nothing", async () => {
    const f = fakeCtx(data, admin);
    expect(
      await runDeclaredPublicOperation(inboxOp, f.ctx, { text: "hi", v: 3, cats: [], hp: "bot" }),
    ).toEqual({ ok: true });
    expect(f.inserted).toEqual([]);
  });

  it("drops text that looks like personal data, answering like success", async () => {
    for (const text of [
      "mail me at jane@example.com",
      "+49 30 1234567",
      "order 4711083",
      "4111 1111 1111 1111",
    ]) {
      const f = fakeCtx(data, admin);
      expect(await runDeclaredPublicOperation(inboxOp, f.ctx, { text, v: 3, cats: [] })).toEqual({
        ok: true,
      });
      expect(f.inserted).toEqual([]);
    }
  });
});

describe("drop patterns", () => {
  it("keep ordinary queries", () => {
    for (const q of [
      "preise 2024 2025",
      "iphone 15 pro 256",
      "Öffnungszeiten Berlin",
      "seo agentur",
    ])
      expect(matchesDropPattern(q, ["email", "phone", "long-number"])).toBe(false);
  });
  it("catch addresses, phone numbers, long numbers and card groups", () => {
    expect(matchesDropPattern("a.b@c.de", ["email"])).toBe(true);
    expect(matchesDropPattern("0171 2345678", ["phone"])).toBe(true);
    expect(matchesDropPattern("(030) 123 45 67", ["phone"])).toBe(true);
    expect(matchesDropPattern("kd-nr 123456", ["long-number"])).toBe(true);
    expect(matchesDropPattern("DE89 3704 0044 0532 0130 00", ["long-number"])).toBe(true);
  });
});

describe("list runs", () => {
  const op: PublicOperationDef = {
    name: "rows",
    kind: "read",
    input: z.object({}).passthrough(),
    reads: ["published_rows"],
    run: {
      action: "list",
      table: "published_rows",
      where: { page_id: { from: "input", field: "pageId", optional: true } },
      orderBy: "n",
      orderDir: "desc",
      limit: 50,
      columns: ["page_id", "n"],
      as: "rows",
    },
  };
  it("filters by present input, bounds, orders and returns only the named columns", async () => {
    const f = fakeCtx({ published_rows: [{ id: "1", page_id: "p", n: 2, secret: "x" }] });
    expect(await runDeclaredPublicOperation(op, f.ctx, { pageId: "p" })).toEqual({
      rows: [{ page_id: "p", n: 2 }],
    });
    expect(f.lists[0]?.filter).toEqual({ page_id: "p", limit: 50, orderBy: "n", orderDir: "desc" });
    await runDeclaredPublicOperation(op, f.ctx, {});
    expect(f.lists[1]?.filter).toEqual({ limit: 50, orderBy: "n", orderDir: "desc" });
  });
});

/** The manifest lint's messages for one declaration of a plugin. */
function lint(
  publicOperations: PublicOperationDef[],
  extra: Record<string, unknown> = {},
): string[] {
  const def = definePlugin({
    slug: "lint-probe",
    version: "1.0.0",
    tier: 1,
    schema: {
      notes: { id: "uuid", text: "text" },
      settings: { id: "uuid", version: "int" },
      secrets: { id: "uuid", value: "text" },
    },
    tableKinds: { notes: "inbox", settings: "published", secrets: "private" },
    operations: { admin_only: async () => ({}) },
    publicOperations,
    ...extra,
  } as never);
  try {
    const r = pluginManifest.safeParse(manifestFromDefinition(def));
    return r.success ? [] : r.error.issues.map((i) => i.message);
  } catch (e) {
    // The projection parses the manifest itself and throws its issues.
    return ((e as z.ZodError).issues ?? [{ message: String(e) }]).map((i) => i.message);
  }
}

const insert = (
  table: string,
  values: Record<string, unknown>,
  more: Partial<PublicOperationDef> = {},
): PublicOperationDef => ({
  name: "probe",
  kind: "write",
  input: z.object({ text: z.string().max(10) }).strict(),
  writes: [table],
  run: { action: "insert", table, values: values as never, answer: { ok: true } },
  ...more,
});

describe("the lint refuses declarations beyond the plugin (adversarial)", () => {
  it("accepts a well-formed one", () => {
    expect(lint([insert("notes", { text: { from: "input", field: "text" } })])).toEqual([]);
  });
  it("another plugin's table, or a core table", () => {
    for (const table of ["plugin_comments_comments", "pages", "users"])
      expect(lint([insert(table, { text: { from: "input", field: "text" } })]).join(" ")).toContain(
        "not a table of this plugin's schema",
      );
  });
  it("a column the table does not declare", () => {
    expect(
      lint([insert("notes", { visitor_ip: { from: "input", field: "text" } })]).join(" "),
    ).toContain('column "visitor_ip"');
  });
  it("a private or published table as an insert target", () => {
    expect(
      lint([insert("secrets", { value: { from: "input", field: "text" } })]).join(" "),
    ).toContain("private table");
    expect(
      lint([insert("settings", { version: { from: "const", value: 1 } })]).join(" "),
    ).toContain("published table");
  });
  it("a check reading an admin table the plugin does not publish", () => {
    const op = insert("notes", { text: { from: "input", field: "text" } });
    const run = {
      ...(op.run as object),
      checks: [
        {
          check: "all-in",
          field: "text",
          source: { table: "users", of: "adminSchema" },
          column: "email",
          refusal: "x",
        },
      ],
    };
    expect(lint([{ ...op, run: run as never }]).join(" ")).toContain(
      "visitorProjection does not publish",
    );
  });
  it("a read that inserts, and reads/writes that do not cover the run", () => {
    expect(
      lint([
        insert("notes", { text: { from: "input", field: "text" } }, { kind: "read", writes: [] }),
      ]).join(" "),
    ).toContain('kind "write"');
    expect(
      lint([insert("notes", { text: { from: "input", field: "text" } }, { writes: [] })]).join(" "),
    ).toContain("list it in writes");
  });
  it("a block whose tables, capability or mail template the plugin lacks", () => {
    const op: PublicOperationDef = {
      name: "login",
      kind: "write",
      input: z.object({}).strict(),
      writes: ["login_throttle", "public_users", "visitor_sessions"],
      run: { action: "block", block: "visitor-auth.login" },
    };
    const messages = lint([op]).join(" ");
    expect(messages).toContain('"login_throttle", which is not a table of this plugin\'s schema');
    expect(messages).toContain('needs the "email" capability');
  });
  it("a public operation that is also a code operation", () => {
    const op = {
      ...insert("notes", { text: { from: "input", field: "text" } }),
      name: "admin_only",
    };
    expect(lint([op]).join(" ")).toContain("is also a code operation");
  });
  it("an unknown block or action never parses", () => {
    const bad = { ...insert("notes", {}), run: { action: "block", block: "run-shell" } } as never;
    expect(lint([bad]).length).toBeGreaterThan(0);
    const bad2 = { ...insert("notes", {}), run: { action: "sql", sql: "DROP TABLE x" } } as never;
    expect(() => publicOperationManifestOf(bad2)).not.toThrow();
    expect(lint([bad2]).length).toBeGreaterThan(0);
  });
});

describe("checkPublicSurface over a manifest without a run", () => {
  it("is refused by the manifest schema (no undeclared public operation)", () => {
    const m = manifestFromDefinition(
      definePlugin({
        slug: "no-run",
        version: "1.0.0",
        tier: 1,
        schema: { notes: { id: "uuid", text: "text" } },
        tableKinds: { notes: "inbox" },
        operations: {},
      }),
    );
    const withoutRun = {
      ...m,
      publicOperations: [
        {
          name: "x",
          kind: "write",
          captcha: "required",
          inputJsonSchema: {},
          reads: [],
          writes: ["notes"],
        },
      ],
    };
    expect(pluginManifest.safeParse(withoutRun).success).toBe(false);
    expect(typeof checkPublicSurface).toBe("function");
  });
});
