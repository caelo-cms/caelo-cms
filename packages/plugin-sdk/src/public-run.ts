// SPDX-License-Identifier: MPL-2.0

/**
 * #1340 (epic #763 E2-B) — what a public operation DOES, as data.
 *
 * No plugin code runs in the API gateway: every entry of `publicOperations`
 * carries a `run` declaration the host executes with core code. A run is
 * one of:
 *
 *   - `insert` — one row into a table the plugin owns (an inbox or its
 *     visitor state), its values taken from the validated input, the
 *     consented visitor id, constants or the clock; with checks against
 *     published data before it, a honeypot that answers like success and
 *     stores nothing (or a marked row), and drop patterns that answer like
 *     success and store nothing when a field looks like personal data;
 *   - `list` — rows of a published or visitor-state table, filtered by
 *     input, ordered and bounded, only the named columns;
 *   - `block` — a core building block the plugin activates and configures:
 *     visitor accounts and sessions, double opt-in, a signed unsubscribe
 *     link, a comment thread. The code is core's (CLAUDE.md §2: the visitor
 *     login core stays locked from AI regeneration); the plugin chooses.
 *
 * The host checks every declaration against the plugin's own schema at
 * load (`checkPublicRuns`): a table the plugin does not declare, a column a
 * table does not have, a table of another kind than the action needs, or a
 * block whose tables are missing is a manifest error, and Postgres grants
 * the visitor role exactly what the table kinds allow on top.
 */

import { z } from "zod";

const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
/** A field of the validated input: a top-level key, or `a.b` one level down. */
const inputField = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63})?$/);
/** Words a visitor never sees (the gateway logs them under the request id). */
const refusal = z.string().min(1).max(200);
const jsonScalar = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

/** Where one value of a run comes from. */
export const publicValueRef = z.discriminatedUnion("from", [
  z
    .object({
      from: z.literal("input"),
      field: inputField,
      /** Trim surrounding whitespace (strings only). */
      trim: z.boolean().optional(),
      /** An absent field leaves the column (or the filter) out instead of failing. */
      optional: z.boolean().optional(),
      /** The value an absent field stands for (a form submitted outside a page: ""). */
      orElse: jsonScalar.optional(),
      /** Each element of an array once, in first-seen order. */
      distinct: z.boolean().optional(),
    })
    .strict(),
  /** The consented visitor id, or null without consent (#677). */
  z.object({ from: z.literal("visitor"), key: z.literal("id") }).strict(),
  z
    .object({ from: z.literal("const"), value: z.union([jsonScalar, z.array(jsonScalar).max(32)]) })
    .strict(),
  /** The time of the request (ISO 8601). */
  z.object({ from: z.literal("now") }).strict(),
  /** The day of the request (UTC, `YYYY-MM-DD`). */
  z.object({ from: z.literal("today") }).strict(),
]);
export type PublicValueRef = z.infer<typeof publicValueRef>;

/** A table a check reads: the plugin's public schema, or its published admin data (`visitorProjection`). */
const tableSource = z.object({ table: identifier, of: z.enum(["schema", "adminSchema"]) }).strict();
export type PublicTableSource = z.infer<typeof tableSource>;

/** A condition the input must meet before an insert; a failed one refuses the visitor (422). */
export const publicCheck = z.discriminatedUnion("check", [
  /** The (string) field holds more than whitespace. */
  z.object({ check: z.literal("not-blank"), field: inputField, refusal }).strict(),
  /** The field equals `column` of the source's (first) row. */
  z
    .object({
      check: z.literal("equals-row"),
      field: inputField,
      source: tableSource,
      column: identifier,
      refusal,
    })
    .strict(),
  /** Every element of the (array) field is a value of `column` in the source. */
  z
    .object({
      check: z.literal("all-in"),
      field: inputField,
      source: tableSource,
      column: identifier,
      refusal,
    })
    .strict(),
  /**
   * The (object) field fits the field definition stored in the source row
   * whose `keyColumn` equals the input's `keyField`: no field the
   * definition lacks, every required one filled, an `email` field holding
   * an address (forms). The definition is `{ fields: [{ name, label, type?,
   * required? }] }` in `definitionColumn`.
   */
  z
    .object({
      check: z.literal("form-fields"),
      field: inputField,
      source: tableSource,
      keyColumn: identifier,
      keyField: inputField,
      definitionColumn: identifier,
      missing: refusal,
    })
    .strict(),
]);
export type PublicCheck = z.infer<typeof publicCheck>;

/** The answer of a run: constants, and the inserted row's id. */
const answerValue = z.union([jsonScalar, z.object({ from: z.literal("inserted-id") }).strict()]);
export const publicAnswer = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  answerValue,
);
export type PublicAnswer = z.infer<typeof publicAnswer>;

/**
 * Patterns of personal data a field must not carry into an inbox; a match
 * answers like success and stores nothing (site-search queries).
 */
export const PUBLIC_DROP_PATTERNS = ["email", "phone", "long-number"] as const;
export type PublicDropPattern = (typeof PUBLIC_DROP_PATTERNS)[number];

/** The core building blocks a plugin may activate (see packages/plugin-host/src/public-blocks/). */
export const PUBLIC_BLOCKS = [
  "visitor-auth.signup",
  "visitor-auth.verify-email",
  "visitor-auth.login",
  "visitor-auth.logout",
  "visitor-auth.me",
  "visitor-auth.request-password-reset",
  "visitor-auth.reset-password",
  "double-opt-in.subscribe",
  "double-opt-in.confirm",
  "mail.unsubscribe",
  "comment-thread.read",
] as const;
export type PublicBlock = (typeof PUBLIC_BLOCKS)[number];

/** What one public operation does. */
export const publicRun = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("insert"),
      table: identifier,
      values: z.record(identifier, publicValueRef),
      checks: z.array(publicCheck).max(8).optional(),
      /**
       * The honeypot field bots fill: when it holds anything, the visitor
       * gets `answer` and `store: "nothing"` stores nothing, `"marked"`
       * stores the row with `values` overriding the run's.
       */
      honeypot: z
        .object({
          field: inputField,
          store: z.enum(["nothing", "marked"]),
          values: z.record(identifier, publicValueRef).optional(),
          answer: publicAnswer,
        })
        .strict()
        .optional(),
      /**
       * Store only while `column` of the source's (first) row equals
       * `equals` — a switch the Owner sets in published data (search
       * counting on or off). Otherwise the visitor gets `answer` and
       * nothing is stored; no refusal tells a visitor the switch is off.
       */
      onlyIf: z
        .object({
          source: tableSource,
          column: identifier,
          equals: jsonScalar,
          answer: publicAnswer,
        })
        .strict()
        .optional(),
      /** Any of these fields looking like personal data answers `answer` and stores nothing. */
      drop: z
        .object({
          fields: z.array(inputField).min(1).max(8),
          patterns: z.array(z.enum(PUBLIC_DROP_PATTERNS)).min(1).max(PUBLIC_DROP_PATTERNS.length),
          answer: publicAnswer,
        })
        .strict()
        .optional(),
      answer: publicAnswer,
    })
    .strict(),
  z
    .object({
      action: z.literal("list"),
      table: identifier,
      /**
       * `schema` (default): a published or visitor-state table of the
       * plugin's public schema. `adminSchema`: the columns of an admin
       * table the plugin publishes (`visitorProjection`), read-only.
       */
      of: z.enum(["schema", "adminSchema"]).optional(),
      where: z.record(identifier, publicValueRef).optional(),
      orderBy: identifier.optional(),
      orderDir: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(1).max(1000),
      columns: z.array(identifier).min(1).max(32),
      /** The answer's key the rows go under (`{ [as]: rows }`). */
      as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("block"),
      block: z.enum(PUBLIC_BLOCKS),
      /** The block's settings (see its contract); validated by the block. */
      options: z.record(z.string(), z.union([jsonScalar, z.array(jsonScalar).max(32)])).optional(),
    })
    .strict(),
]);
export type PublicRun = z.infer<typeof publicRun>;

type Column = string;

/** A block's tables: kind and the columns it reads and writes, and its options. */
export interface PublicBlockContract {
  /** Tables by name; a name in angle brackets is taken from that option (`<table>`). */
  readonly tables: Readonly<
    Record<
      string,
      {
        readonly kind: "visitor-state" | "published" | "inbox";
        readonly columns: readonly Column[];
        readonly writes: boolean;
        /** Columns the block filters by: the plugin's `indexes` must lead with each (#1292). */
        readonly filters?: readonly Column[];
      }
    >
  >;
  /** Options the block takes, each a table or column name. */
  readonly options: Readonly<Record<string, "table" | "column" | "template" | "hours">>;
  /** Mail templates it queues, by option name or fixed name. */
  readonly templates: readonly string[];
  /** Capabilities the plugin must hold (the context handles it needs). */
  readonly capabilities: readonly ("email" | "cms_admin")[];
}

const AUTH_TABLES = {
  auth_config: {
    kind: "published",
    columns: ["signup_open", "password_min_length"],
    writes: false,
  },
  public_users: {
    kind: "visitor-state",
    columns: ["email", "email_key", "password_hash", "email_verified_at", "last_login_at"],
    writes: true,
    filters: ["email"],
  },
  visitor_sessions: {
    kind: "visitor-state",
    columns: ["public_user_id", "token_hash", "expires_at"],
    writes: true,
    filters: ["token_hash", "public_user_id"],
  },
  password_reset_tokens: {
    kind: "visitor-state",
    columns: ["public_user_id", "token_hash", "expires_at", "used_at"],
    writes: true,
    filters: ["token_hash"],
  },
  email_verification_tokens: {
    kind: "visitor-state",
    columns: ["public_user_id", "token_hash", "password_hash", "expires_at", "used_at"],
    writes: true,
    filters: ["token_hash", "public_user_id"],
  },
  login_throttle: {
    kind: "visitor-state",
    columns: ["email_hash", "failures", "window_started_at"],
    writes: true,
    filters: ["email_hash"],
  },
} as const;

/**
 * One `visitor-auth` block: the auth tables it reads (`r`) and writes
 * (`w`), each the minimal set the #1334 review approved per operation.
 */
function authBlock(
  tables: Readonly<Record<keyof typeof AUTH_TABLES, "r" | "w" | undefined>>,
): PublicBlockContract {
  const out: Record<string, PublicBlockContract["tables"][string]> = {};
  for (const [t, mode] of Object.entries(tables) as [
    keyof typeof AUTH_TABLES,
    "r" | "w" | undefined,
  ][]) {
    if (mode) out[t] = { ...AUTH_TABLES[t], writes: mode === "w" };
  }
  return { tables: out, options: {}, templates: [], capabilities: ["email"] };
}

const NONE = {
  auth_config: undefined,
  public_users: undefined,
  visitor_sessions: undefined,
  password_reset_tokens: undefined,
  email_verification_tokens: undefined,
  login_throttle: undefined,
} as const;

const OPT_IN_TABLE = {
  "<table>": {
    kind: "visitor-state",
    columns: [
      "email",
      "email_hash",
      "confirm_token",
      "confirm_expires_at",
      "confirmed_at",
      "unsub_token",
    ],
    writes: true,
    filters: ["email_hash", "confirm_token"],
  },
} as const;

/** The contract of every block: what the plugin must declare for it. */
export const PUBLIC_BLOCK_CONTRACTS: Readonly<Record<PublicBlock, PublicBlockContract>> = {
  "visitor-auth.signup": {
    ...authBlock({ ...NONE, auth_config: "r", public_users: "w", email_verification_tokens: "w" }),
    templates: ["verify_email", "signup_existing_account"],
  },
  "visitor-auth.verify-email": authBlock({
    ...NONE,
    email_verification_tokens: "w",
    public_users: "w",
  }),
  "visitor-auth.login": authBlock({
    ...NONE,
    login_throttle: "w",
    public_users: "w",
    visitor_sessions: "w",
  }),
  "visitor-auth.logout": authBlock({ ...NONE, visitor_sessions: "w" }),
  "visitor-auth.me": authBlock({ ...NONE, visitor_sessions: "r", public_users: "r" }),
  "visitor-auth.request-password-reset": {
    ...authBlock({ ...NONE, public_users: "r", password_reset_tokens: "w" }),
    templates: ["password_reset"],
  },
  "visitor-auth.reset-password": authBlock({
    ...NONE,
    auth_config: "r",
    public_users: "w",
    password_reset_tokens: "w",
    visitor_sessions: "w",
  }),
  "double-opt-in.subscribe": {
    tables: OPT_IN_TABLE,
    options: { table: "table", template: "template", hours: "hours" },
    templates: ["<template>"],
    capabilities: ["email"],
  },
  "double-opt-in.confirm": {
    tables: OPT_IN_TABLE,
    options: { table: "table" },
    templates: [],
    capabilities: [],
  },
  "mail.unsubscribe": {
    tables: { "<table>": { kind: "visitor-state", columns: ["<column>"], writes: true } },
    options: { table: "table", column: "column" },
    templates: [],
    capabilities: [],
  },
  "comment-thread.read": { tables: {}, options: {}, templates: [], capabilities: ["cms_admin"] },
};

/** The tables a block reaches, with its options' names filled in. */
export function blockTables(
  block: PublicBlock,
  options: Readonly<Record<string, unknown>> | undefined,
): { table: string; kind: string; columns: string[]; writes: boolean; filters: string[] }[] {
  const c = PUBLIC_BLOCK_CONTRACTS[block];
  const name = (n: string) => (n.startsWith("<") ? String(options?.[n.slice(1, -1)] ?? "") : n);
  return Object.entries(c.tables).map(([t, spec]) => ({
    table: name(t),
    kind: spec.kind,
    columns: spec.columns.map(name),
    writes: spec.writes,
    filters: (spec.filters ?? []).map(name),
  }));
}

/** The tables a run reads and writes (for `reads`/`writes` and the grants). */
export function runTables(run: PublicRun): { reads: Set<string>; writes: Set<string> } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  if (run.action === "insert") {
    writes.add(run.table);
    for (const c of run.checks ?? [])
      if ("source" in c && c.source.of === "schema") reads.add(c.source.table);
    if (run.onlyIf?.source.of === "schema") reads.add(run.onlyIf.source.table);
  } else if (run.action === "list") {
    if ((run.of ?? "schema") === "schema") reads.add(run.table);
  } else {
    for (const t of blockTables(run.block, run.options)) {
      reads.add(t.table);
      if (t.writes) writes.add(t.table);
    }
  }
  return { reads, writes };
}

const VISITOR_READABLE = new Set(["published", "visitor-state"]);
const VISITOR_WRITABLE = new Set(["inbox", "visitor-state"]);

/**
 * Lints one public operation's run against the plugin's declarations;
 * `issue` receives a path below the operation and a message.
 */
export function checkPublicRun(
  op: {
    readonly name: string;
    readonly kind: "read" | "write";
    readonly run: PublicRun;
    readonly reads: readonly string[];
    readonly writes: readonly string[];
  },
  m: {
    readonly schema: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly adminSchema?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly tableKinds?: Readonly<Record<string, string>>;
    readonly visitorProjection?: Readonly<Record<string, readonly string[]>>;
    readonly requestedCapabilities?: readonly string[];
    readonly mailTemplates?: Readonly<Record<string, unknown>>;
    readonly indexes?: { readonly schema?: Readonly<Record<string, readonly unknown[]>> };
  },
  issue: (path: (string | number)[], message: string) => void,
): void {
  const kinds = m.tableKinds ?? {};
  const hasColumn = (table: string, column: string) =>
    column === "id" || Object.hasOwn(m.schema[table] ?? {}, column);
  const ownTable = (
    path: (string | number)[],
    table: string,
    need: ReadonlySet<string>,
    verb: string,
  ): boolean => {
    if (!Object.hasOwn(m.schema, table)) {
      issue(path, `"${op.name}" ${verb} "${table}", which is not a table of this plugin's schema`);
      return false;
    }
    const kind = kinds[table];
    if (kind !== undefined && !need.has(kind)) {
      issue(
        path,
        `"${op.name}" cannot ${verb} the ${kind} table "${table}": visitors read only published and visitor-state tables and write only inbox and visitor-state tables`,
      );
      return false;
    }
    return true;
  };
  const columns = (path: (string | number)[], table: string, cols: Iterable<string>) => {
    for (const c of cols)
      if (!hasColumn(table, c))
        issue(path, `"${op.name}" names column "${c}", which table "${table}" does not declare`);
  };
  const run = op.run;
  if (run.action === "insert") {
    if (op.kind !== "write") issue(["kind"], `"${op.name}" inserts, so it is kind "write"`);
    if (Object.keys(run.values).length === 0)
      issue(["run", "values"], `"${op.name}" inserts a row: give it at least one column value`);
    if (ownTable(["run", "table"], run.table, VISITOR_WRITABLE, "write")) {
      columns(["run", "values"], run.table, Object.keys(run.values));
      columns(["run", "honeypot", "values"], run.table, Object.keys(run.honeypot?.values ?? {}));
    }
    const sourced: { path: (string | number)[]; source: PublicTableSource; cols: string[] }[] = [];
    if (run.onlyIf)
      sourced.push({
        path: ["run", "onlyIf", "source"],
        source: run.onlyIf.source,
        cols: [run.onlyIf.column],
      });
    for (const s of sourced) {
      if (s.source.of === "schema") {
        if (ownTable(s.path, s.source.table, VISITOR_READABLE, "read"))
          columns(s.path, s.source.table, s.cols);
      } else {
        const projected = m.visitorProjection?.[s.source.table];
        if (!projected)
          issue(
            s.path,
            `"${op.name}" reads admin table "${s.source.table}", which visitorProjection does not publish`,
          );
        else
          for (const col of s.cols)
            if (!projected.includes(col))
              issue(
                s.path,
                `"${op.name}" reads "${s.source.table}.${col}", which visitorProjection does not publish`,
              );
      }
    }
    for (const [i, c] of (run.checks ?? []).entries()) {
      if (!("source" in c)) continue;
      const path = ["run", "checks", i, "source"];
      if (c.source.of === "schema") {
        if (ownTable(path, c.source.table, VISITOR_READABLE, "read")) {
          const cols = c.check === "form-fields" ? [c.keyColumn, c.definitionColumn] : [c.column];
          columns(path, c.source.table, cols);
        }
      } else {
        const projected = m.visitorProjection?.[c.source.table];
        const cols = c.check === "form-fields" ? [c.keyColumn, c.definitionColumn] : [c.column];
        if (!projected)
          issue(
            path,
            `"${op.name}" reads admin table "${c.source.table}", which visitorProjection does not publish`,
          );
        else
          for (const col of cols)
            if (!projected.includes(col))
              issue(
                path,
                `"${op.name}" reads "${c.source.table}.${col}", which visitorProjection does not publish`,
              );
      }
    }
  } else if (run.action === "list" && run.of === "adminSchema") {
    if (op.kind !== "read") issue(["kind"], `"${op.name}" only lists, so it is kind "read"`);
    const projected = m.visitorProjection?.[run.table];
    const wanted = [
      ...run.columns,
      ...Object.keys(run.where ?? {}),
      ...(run.orderBy ? [run.orderBy] : []),
    ];
    if (!projected)
      issue(
        ["run", "table"],
        `"${op.name}" lists admin table "${run.table}", which visitorProjection does not publish`,
      );
    else
      for (const c of wanted)
        if (c !== "id" && !projected.includes(c))
          issue(
            ["run", "columns"],
            `"${op.name}" names "${run.table}.${c}", which visitorProjection does not publish`,
          );
  } else if (run.action === "list") {
    if (op.kind !== "read") issue(["kind"], `"${op.name}" only lists, so it is kind "read"`);
    if (ownTable(["run", "table"], run.table, VISITOR_READABLE, "read")) {
      columns(["run", "columns"], run.table, run.columns);
      columns(["run", "where"], run.table, Object.keys(run.where ?? {}));
      if (run.orderBy) columns(["run", "orderBy"], run.table, [run.orderBy]);
    }
  } else {
    const contract = PUBLIC_BLOCK_CONTRACTS[run.block];
    for (const [key, kind] of Object.entries(contract.options)) {
      const v = run.options?.[key];
      if (
        kind === "hours"
          ? typeof v !== "number" || v < 1 || v > 24 * 30
          : typeof v !== "string" || v.length === 0
      )
        issue(["run", "options", key], `block "${run.block}" needs option "${key}" (${kind})`);
    }
    for (const key of Object.keys(run.options ?? {}))
      if (!(key in contract.options))
        issue(["run", "options", key], `block "${run.block}" takes no option "${key}"`);
    for (const t of blockTables(run.block, run.options)) {
      if (!t.table) continue;
      if (
        ownTable(
          ["run", "block"],
          t.table,
          t.kind === "published" ? new Set(["published"]) : new Set([t.kind]),
          t.writes ? "write" : "read",
        )
      ) {
        columns(["run", "block"], t.table, t.columns);
        const leading = new Set(
          (m.indexes?.schema?.[t.table] ?? []).map((e) =>
            Array.isArray(e) ? e[0] : (e as { columns?: string[] }).columns?.[0],
          ),
        );
        for (const f of t.filters)
          if (!leading.has(f))
            issue(
              ["run", "block"],
              `block "${run.block}" reads "${t.table}" by "${f}": declare indexes: { schema: { ${t.table}: [["${f}"]] } }`,
            );
      }
    }
    for (const cap of contract.capabilities)
      if (!(m.requestedCapabilities ?? []).includes(cap))
        issue(["run", "block"], `block "${run.block}" needs the "${cap}" capability`);
    for (const tpl of contract.templates) {
      const name = tpl.startsWith("<") ? String(run.options?.[tpl.slice(1, -1)] ?? "") : tpl;
      if (name && !Object.hasOwn(m.mailTemplates ?? {}, name))
        issue(
          ["run", "block"],
          `block "${run.block}" mails template "${name}", which mailTemplates does not declare`,
        );
    }
  }
  // The declared reads/writes are what the grants and the snapshot show:
  // they must cover what the run touches.
  const used = runTables(run);
  for (const t of used.writes)
    if (!op.writes.includes(t)) issue(["writes"], `"${op.name}" writes "${t}": list it in writes`);
  for (const t of used.reads)
    if (!op.reads.includes(t) && !op.writes.includes(t))
      issue(["reads"], `"${op.name}" reads "${t}": list it in reads`);
}

/**
 * Whether the part after an `@` (up to the next `@`) is a domain: a dot with
 * at least one character on each side. The first dot past the first
 * character decides: if it is the last character, no dot qualifies.
 */
function hasDomainDot(domain: string): boolean {
  const dot = domain.indexOf(".", 1);
  return dot !== -1 && dot < domain.length - 1;
}

/**
 * Whether `value` is an e-mail address as a form field takes it: one `@`,
 * something before it, a domain with a dot after it, no whitespace. Written
 * with indexOf, linear in the length: the regex `^[^\s@]+@[^\s@]+\.[^\s@]+$`
 * backtracks polynomially on visitor input like `a@a.a.a.a…` (CodeQL).
 */
export function isEmailAddress(value: string): boolean {
  if (/\s/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  return hasDomainDot(value.slice(at + 1));
}

/**
 * Whether `text` contains something shaped like an e-mail address anywhere
 * (`[^\s@]+@[^\s@]+\.[^\s@]+`), in linear time: within each run without
 * whitespace, an `@` with a character before it and a domain after it.
 */
function containsEmailAddress(text: string): boolean {
  for (const token of text.split(/\s+/)) {
    const parts = token.split("@");
    for (let i = 0; i + 1 < parts.length; i++) {
      if ((parts[i] as string).length > 0 && hasDomainDot(parts[i + 1] as string)) return true;
    }
  }
  return false;
}
/**
 * A phone number starts like one (`+49`, a national `0…`, an area code in
 * brackets) and carries at least seven digits; two years side by side
 * ("2024 2025") do not.
 */
const PHONE = /(?:\+\d|\b0\d|\(\d{2,5}\))[\d\s()./-]{5,}\d/;
/** Six digits in a row (an order, customer or card number), separators `.-/` inside ignored. */
const LONG_NUMBER = /\d{6,}/;
/** Card and IBAN groups: four groups of four digits apart by spaces. */
const DIGIT_GROUPS = /\b\d{4}(?: \d{4}){3}\b/;

/** Whether `text` looks like one of the patterns (an address, a phone number, a long digit run). */
export function matchesDropPattern(text: string, patterns: readonly PublicDropPattern[]): boolean {
  for (const p of patterns) {
    if (p === "email" && containsEmailAddress(text)) return true;
    if (p === "phone") {
      const m = PHONE.exec(text);
      if (m && m[0].replace(/\D/g, "").length >= 7) return true;
    }
    if (p === "long-number") {
      if (LONG_NUMBER.test(text.replace(/(?<=\d)[./-](?=\d)/g, ""))) return true;
      if (DIGIT_GROUPS.test(text)) return true;
    }
  }
  return false;
}
