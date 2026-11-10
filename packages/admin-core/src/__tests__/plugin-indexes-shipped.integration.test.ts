// SPDX-License-Identifier: MPL-2.0

/**
 * #1292 — every read a shipped plugin makes plans an index scan.
 *
 * Each shipped plugin's tables are provisioned from its own definition
 * (schema, adminSchema, indexes) under a throwaway slug, and every
 * filtered, ordered or ranged read shape its code issues (one row per
 * `list()` call site in packages/plugins/*, recorded from the suite) is
 * planned with `enable_seqscan = off`: the planner then takes any usable
 * index, so a Seq Scan on the plugin's table means no index serves the
 * read. The SQL is the one the storage operations run (`publicListSql` /
 * `privateListSql`), and each shape must also pass the host's read rule.
 *
 * The list is kept by hand, so it misses a read added later (#1536). The
 * plugins' unit tests therefore run every fake store through the SDK's
 * `indexCheckedQuery`, which applies the same rule to indexes derived
 * from the manifest; the last block here pins that derivation to what the
 * catalog holds after provisioning, so a unit test refuses exactly what
 * the host refuses.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import authPlugin from "@caelo-cms/plugin-auth";
import commentsPlugin from "@caelo-cms/plugin-comments";
import consentPlugin from "@caelo-cms/plugin-consent-manager";
import formsPlugin from "@caelo-cms/plugin-forms";
import {
  indexLeadColumns,
  listAccessOf,
  listIndexRefusal,
  parseListFilter,
  privateListSql,
  publicListSql,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import newsletterPlugin from "@caelo-cms/plugin-newsletter";
import ratingsPlugin from "@caelo-cms/plugin-ratings";
import { adminSchemaFromSpec, schemaFromSpec } from "@caelo-cms/plugin-sandbox";
import {
  declaredIndexLeads,
  type PluginQueryFilter,
  type PluginSchemaMap,
  type PluginTableKinds,
} from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, type TransactionRunner } from "@caelo-cms/query-api";
import { SQL as BunSQL } from "bun";
import { sql } from "drizzle-orm";

function requiredUrl(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} required`);
  return url;
}
const ADMIN_URL = requiredUrl("ADMIN_DATABASE_URL");
const PUBLIC_URL = requiredUrl("PUBLIC_ADMIN_DATABASE_URL");

const SYSTEM = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "t1292-shipped-indexes",
};

interface Shipped {
  readonly slug: string;
  readonly schema: PluginSchemaMap;
  readonly tableKinds?: PluginTableKinds;
  readonly adminSchema?: PluginSchemaMap;
  readonly indexes?: {
    readonly schema?: Parameters<typeof schemaFromSpec>[0]["indexes"];
    readonly adminSchema?: Parameters<typeof adminSchemaFromSpec>[0]["indexes"];
  };
}

const PLUGINS: Record<string, Shipped> = {
  auth: authPlugin,
  comments: commentsPlugin,
  "consent-manager": consentPlugin,
  forms: formsPlugin,
  "international-site": intlPlugin,
  newsletter: newsletterPlugin,
  ratings: ratingsPlugin,
  // The control: auth's tables without its index declaration.
  control: { slug: "control", schema: authPlugin.schema, tableKinds: authPlugin.tableKinds },
};

const U = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const T = "2026-11-01T00:00:00.000Z";

type Zone = "schema" | "adminSchema";
/** [plugin, zone, table, filter] — the filtered/ordered reads of each plugin's code. */
const READS: ReadonlyArray<readonly [string, Zone, string, PluginQueryFilter]> = [
  ["auth", "schema", "auth_config_proposals", { id: U }],
  ["auth", "schema", "auth_config_proposals", { status: "pending", orderBy: "created_at" }],
  ["auth", "schema", "password_reset_tokens", { orderBy: "expires_at", orderDir: "asc" }],
  ["auth", "schema", "password_reset_tokens", { token_hash: "h" }],
  ["auth", "schema", "email_verification_tokens", { token_hash: "h" }],
  ["auth", "schema", "email_verification_tokens", { public_user_id: U }],
  ["auth", "schema", "email_verification_tokens", { orderBy: "expires_at", orderDir: "asc" }],
  ["auth", "schema", "login_throttle", { email_hash: "h" }],
  ["auth", "schema", "login_throttle", { orderBy: "window_started_at", orderDir: "asc" }],
  ["auth", "schema", "public_users", { anyOf: { email: ["a@b.c", "A@b.c"] } }],
  ["auth", "schema", "public_users", { id: U }],
  ["auth", "schema", "visitor_sessions", { orderBy: "expires_at", orderDir: "asc" }],
  ["auth", "schema", "visitor_sessions", { token_hash: "h" }],
  ["auth", "schema", "visitor_sessions", { public_user_id: U }],
  ["comments", "schema", "comments", { id: U }],
  ["comments", "schema", "comments", { status: "pending", orderBy: "submitted_at" }],
  ["consent-manager", "schema", "consent_log", { orderBy: "created_at", orderDir: "asc" }],
  ["consent-manager", "schema", "consent_log", { since: T, orderBy: "created_at" }],
  ["consent-manager", "schema", "consent_log", { before: T, orderBy: "created_at" }],
  ["consent-manager", "adminSchema", "categories", { orderBy: "created_at" }],
  ["consent-manager", "adminSchema", "categories", { orderBy: "position", orderDir: "asc" }],
  ["consent-manager", "adminSchema", "module_guards", { orderBy: "created_at", since: T }],
  ["consent-manager", "adminSchema", "module_guards", { created_at: T }],
  ["consent-manager", "adminSchema", "module_guards", { anyOf: { module_id: [U] } }],
  ["consent-manager", "adminSchema", "module_guards", { status: "gated", category_key: "x" }],
  ["consent-manager", "adminSchema", "settings", { orderBy: "created_at" }],
  ["consent-manager", "adminSchema", "tags", { name: "x" }],
  ["consent-manager", "adminSchema", "tags", { category_key: "x", enabled: true }],
  ["forms", "schema", "form_submissions", { orderBy: "submitted_at" }],
  ["forms", "schema", "form_submissions", { form_slug: "x", orderBy: "submitted_at" }],
  ["forms", "schema", "form_submissions", { status: "new", orderBy: "submitted_at" }],
  ["forms", "schema", "form_submissions", { id: U }],
  ["forms", "schema", "forms", { slug: "x" }],
  ["international-site", "adminSchema", "chrome_variants", { orderBy: "id", orderDir: "asc" }],
  ["international-site", "adminSchema", "glossary", { locale_code: "de" }],
  ["international-site", "adminSchema", "glossary", { term: "x", locale_code: "de" }],
  ["international-site", "adminSchema", "neutral_terms", { locale_code: "de" }],
  ["international-site", "adminSchema", "neutral_terms", { anyOf: { locale_code: ["de", "*"] } }],
  [
    "international-site",
    "adminSchema",
    "list_item_visibility",
    { locale_code: "de", anyOf: { address: ["a"] }, orderBy: "id", orderDir: "asc" },
  ],
  [
    "international-site",
    "adminSchema",
    "list_value_translations",
    { locale_code: "de", anyOf: { address: ["a"] }, orderBy: "id", orderDir: "asc" },
  ],
  [
    "international-site",
    "adminSchema",
    "list_value_translations",
    { locale_code: "de", address: "a" },
  ],
  [
    "international-site",
    "adminSchema",
    "page_prop_translations",
    { locale_code: "de", anyOf: { page_id: [U] }, orderBy: "id", orderDir: "asc" },
  ],
  [
    "international-site",
    "adminSchema",
    "page_prop_translations",
    { locale_code: "de", page_id: U, field: "title" },
  ],
  [
    "international-site",
    "adminSchema",
    "page_variants",
    { anyOf: { group_id: [U] }, orderBy: "id" },
  ],
  [
    "international-site",
    "adminSchema",
    "page_variants",
    { anyOf: { page_id: [U] }, orderBy: "id" },
  ],
  ["international-site", "adminSchema", "page_variants", { group_id: U }],
  ["international-site", "adminSchema", "page_variants", { group_id: U, locale_code: "de" }],
  [
    "international-site",
    "adminSchema",
    "page_variants",
    { group_id: U, translation_status: "source" },
  ],
  [
    "international-site",
    "adminSchema",
    "page_variants",
    { locale_code: "de", orderBy: "id", orderDir: "asc" },
  ],
  ["international-site", "adminSchema", "page_variants", { page_id: U }],
  ["international-site", "adminSchema", "page_variants", { translation_status: "needs_update" }],
  [
    "international-site",
    "adminSchema",
    "page_variants",
    { translation_status: "up_to_date", orderBy: "id", orderDir: "asc", afterId: U },
  ],
  ["international-site", "adminSchema", "settings", { key: "x" }],
  ["international-site", "adminSchema", "style_guides", { locale_code: "de" }],
  [
    "international-site",
    "adminSchema",
    "term_translations",
    { locale_code: "de", anyOf: { list_id: [U] }, orderBy: "id", orderDir: "asc" },
  ],
  [
    "international-site",
    "adminSchema",
    "term_translations",
    { locale_code: "de", list_id: U, item_id: U },
  ],
  ["newsletter", "schema", "campaigns", { orderBy: "created_at" }],
  ["newsletter", "schema", "campaigns", { id: U }],
  ["newsletter", "schema", "sends", { status: "pending", orderBy: "created_at" }],
  ["newsletter", "schema", "subscribers", { email_hash: "h" }],
  ["newsletter", "schema", "subscribers", { confirm_token: "t" }],
  ["newsletter", "schema", "subscribers", { unsub_token: "t" }],
  ["newsletter", "schema", "subscribers", { id: U }],
  ["newsletter", "adminSchema", "send_progress", { orderBy: "created_at" }],
  ["newsletter", "adminSchema", "send_progress", { id: U }],
  ["newsletter", "adminSchema", "send_runs", { orderBy: "created_at" }],
  ["newsletter", "adminSchema", "send_runs", { campaign_id: U }],
  ["newsletter", "adminSchema", "send_runs", { campaign_id: U, orderBy: "created_at" }],
  ["newsletter", "adminSchema", "send_runs", { status: "approved", orderBy: "created_at" }],
  ["ratings", "schema", "rating_aggregates", { page_id: U, orderBy: "count" }],
  ["ratings", "schema", "rating_aggregates", { orderBy: "count" }],
  ["ratings", "schema", "ratings", { orderBy: "id", orderDir: "asc", afterId: U }],
];

/** Short, so `plugin_<slug>_<table>_plugin_scope` stays within 63 bytes like the real slug's. */
const slugOf = (plugin: string) => `ix${Object.keys(PLUGINS).indexOf(plugin)}`;
const schemaOf = (plugin: string) => `plugin_${slugOf(plugin).replace(/-/g, "_")}`;
/** One stable fake plugin id per plugin (the RLS policies scope to it). */
const idOf = (plugin: string) =>
  `1292${Object.keys(PLUGINS).indexOf(plugin).toString(16).padStart(4, "0")}-0000-4000-8000-000000001292`;

let adapter: DatabaseAdapter;

async function dropSchemas(): Promise<void> {
  for (const url of [ADMIN_URL, PUBLIC_URL] as const) {
    const db = new BunSQL(url);
    try {
      await db.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        for (const plugin of Object.keys(PLUGINS)) {
          await tx.unsafe(`DROP SCHEMA IF EXISTS "${schemaOf(plugin)}" CASCADE`);
          await tx.unsafe(
            `DELETE FROM plugin_schema_provisions WHERE schema_name = '${schemaOf(plugin)}'`,
          );
        }
      });
    } finally {
      await db.end();
    }
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  await dropSchemas();
  for (const [plugin, def] of Object.entries(PLUGINS)) {
    const pluginId = idOf(plugin);
    if (Object.keys(def.schema).length > 0) {
      const emitted = schemaFromSpec({
        tableKinds: def.tableKinds,
        pluginId,
        slug: slugOf(plugin),
        schema: def.schema,
        indexes: def.indexes?.schema,
      });
      await adapter.provisionPluginPublicSchema({ pluginId, sql: emitted.sql });
    }
    if (def.adminSchema) {
      const emitted = adminSchemaFromSpec({
        pluginId,
        slug: slugOf(plugin),
        adminSchema: def.adminSchema,
        indexes: def.indexes?.adminSchema,
      });
      await adapter.provisionPluginAdminSchema({ pluginId, sql: emitted.sql });
    }
    for (const [zone, url] of [
      ["schema", PUBLIC_URL],
      ["adminSchema", ADMIN_URL],
    ] as const) {
      for (const [table, columns] of Object.entries(def[zone] ?? {})) {
        await seed(url, plugin, table, columns);
      }
    }
  }
});

/** Rows a seeded table holds: enough that an index beats a full scan on cost. */
const SEED_ROWS = 3000;

/**
 * A SQL expression filling a column of the given spec for row `i`.
 *
 * An enum's first value — the open state of a work queue in every shipped
 * plugin (`new`, `pending`, `approved`, `source`) — holds 2 % of the rows,
 * the others share the rest. With the plugin policy estimated as passing
 * every row (#1297), a uniform seed (a third of the rows `new`) makes
 * "read the order index and filter" the cheapest plan for a status read
 * with a LIMIT, which says nothing about whether the status index serves
 * the read when the open rows are few — the case the index exists for.
 */
function seedValue(spec: string): string {
  if (spec.startsWith("enum:")) {
    const values = spec.slice("enum:".length).split(",");
    const rest = values.slice(1);
    const array = (vs: string[]) => `(ARRAY[${vs.map((v) => `'${v}'`).join(", ")}])`;
    return rest.length === 0
      ? `'${values[0]}'`
      : `CASE WHEN i % 50 = 0 THEN '${values[0]}' ELSE ${array(rest)}[1 + i % ${rest.length}] END`;
  }
  if (spec.startsWith("ref:") || spec === "uuid") return "gen_random_uuid()";
  if (spec === "int") return "i";
  if (spec === "bool") return "(i % 2 = 0)";
  if (spec === "jsonb") return "'{}'::jsonb";
  if (spec === "timestamp" || spec === "timestamp_nullable")
    return "now() - i * interval '1 minute'";
  return "md5(i::text)";
}

/**
 * Fill one table with distinct values and ANALYZE it, so the planner
 * costs each index by its real selectivity (on an empty table every
 * index costs the same and the choice says nothing). The throwaway copy
 * drops its ref: foreign keys (no core rows to point at; the automatic
 * index stays) and its user triggers (the change journal).
 */
async function seed(
  url: string,
  plugin: string,
  table: string,
  columns: Readonly<Record<string, string>>,
): Promise<void> {
  const fq = `"${schemaOf(plugin)}"."${table}"`;
  const cols = Object.entries(columns).filter(([name]) => name !== "id");
  const db = new BunSQL(url);
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${idOf(plugin)}', true)`);
      await tx.unsafe(`DO $seed$ DECLARE c text; BEGIN
        FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = '${fq}'::regclass AND contype = 'f' LOOP
          EXECUTE format('ALTER TABLE ${fq} DROP CONSTRAINT %I', c);
        END LOOP; END $seed$`);
      await tx.unsafe(`ALTER TABLE ${fq} DISABLE TRIGGER USER`);
      await tx.unsafe(
        `INSERT INTO ${fq} (${cols.map(([c]) => `"${c}"`).join(", ")})
         SELECT ${cols.map(([, spec]) => seedValue(spec)).join(", ")}
         FROM generate_series(1, ${SEED_ROWS}) AS i`,
      );
      await tx.unsafe(`ANALYZE ${fq}`);
    });
  } finally {
    await db.end();
  }
}

afterAll(async () => {
  await dropSchemas();
  await adapter.close();
});

interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Index Name"?: string;
  readonly "Index Cond"?: string;
  readonly Plans?: readonly PlanNode[];
}

/** The scans of the plugin table, e.g. `Index Scan using … [cond]`. */
function summarize(root: PlanNode, table: string): string {
  return nodesOf(root)
    .filter((n) => n["Relation Name"] === table || n["Node Type"] === "Bitmap Index Scan")
    .map(
      (n) =>
        `${n["Node Type"]}${n["Index Name"] ? ` using ${n["Index Name"]}` : ""}${n["Index Cond"] ? ` [${n["Index Cond"]}]` : ""}`,
    )
    .join(" ← ");
}

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

const mentions = (cond: string, column: string) =>
  new RegExp(`(^|[^a-z0-9_])${column}([^a-z0-9_]|$)`).test(cond);

/**
 * What is wrong with the plan for this read, or null. A filtered or
 * ranged read must reach the table through an index condition on a
 * column that drives it — a full index scan with the filter applied row
 * by row is a table scan in another form. An unfiltered ordered read
 * must come out of an index in order: no Sort.
 */
function planProblem(root: PlanNode, table: string, filter: PluginQueryFilter): string | null {
  const nodes = nodesOf(root);
  const describe = nodes
    .map(
      (n) =>
        `${n["Node Type"]}${n["Index Name"] ? `(${n["Index Name"]})` : ""}${n["Index Cond"] ? `[${n["Index Cond"]}]` : ""}`,
    )
    .join(" > ");
  if (nodes.some((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === table)) {
    return `Seq Scan: ${describe}`;
  }
  const reserved = new Set(["limit", "orderBy", "orderDir", "since", "before", "afterId", "anyOf"]);
  const filtered = [
    ...Object.keys(filter).filter((k) => !reserved.has(k)),
    ...Object.keys((filter.anyOf as Record<string, unknown> | undefined) ?? {}),
  ];
  const ranged = filter.since !== undefined || filter.before !== undefined;
  const driving = filtered.length > 0 ? filtered : ranged ? ["created_at"] : [];
  if (driving.length > 0) {
    const conds = nodes.flatMap((n) => (n["Index Cond"] ? [n["Index Cond"]] : []));
    return conds.some((c) => driving.some((d) => mentions(c, d)))
      ? null
      : `no index condition on ${driving.join("/")}: ${describe}`;
  }
  return nodes.some((n) => n["Node Type"] === "Sort")
    ? `sorts instead of reading an index in order: ${describe}`
    : null;
}

/**
 * The host's verdict on the read (from the table's indexes in the
 * catalog) and the scans of its plan with sequential scans disabled.
 */
async function plan(
  plugin: string,
  zone: Zone,
  table: string,
  filter: PluginQueryFilter,
): Promise<{ refusal: string | null; problem: string | null; summary: string }> {
  const def = PLUGINS[plugin] as Shipped;
  const columns = (zone === "schema" ? def.schema : def.adminSchema)?.[table];
  if (!columns) throw new Error(`${plugin}: no ${zone}.${table}`);
  const parsed = parseListFilter("probe.list", columns, filter);
  if (typeof parsed === "string") throw new Error(parsed);
  const t = { schema: schemaOf(plugin), table, columns };
  const query = zone === "schema" ? publicListSql(t, parsed) : privateListSql(t, parsed, []);
  const inTx = <T>(fn: (tx: TransactionRunner) => Promise<T>): Promise<T> =>
    zone === "schema"
      ? adapter.withPublicTransaction(SYSTEM, fn)
      : adapter.withAdminTransaction(SYSTEM, fn);
  return inTx(async (tx) => {
    const refusal = listIndexRefusal({
      label: "probe.list",
      zone,
      table,
      leads: await indexLeadColumns(tx, t.schema, table),
      access: listAccessOf(parsed),
    });
    await tx.execute(sql.raw("SET LOCAL enable_seqscan = off"));
    // Sorting stays enabled: an unfiltered ordered read must come out of
    // its index in order on cost alone. That needs the plugin policy to be
    // estimated as passing the rows (#1297, `caelo_setting_is`); the plain
    // `current_setting(...) = …` comparison was estimated at 0.5 % of them
    // and made the planner prefer a full scan + top-N sort.
    await tx.execute(sql`SELECT set_config('caelo.plugin_id', ${idOf(plugin)}, true)`);
    const rows = (await tx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`)) as unknown as Array<
      Record<string, unknown>
    >;
    const raw = rows[0]?.["QUERY PLAN"];
    const parsedPlan = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{
      Plan: PlanNode;
    }>;
    const root = parsedPlan[0]?.Plan;
    if (!root) throw new Error(`no plan for ${table}`);
    return { refusal, problem: planProblem(root, table, filter), summary: summarize(root, table) };
  });
}

describe("#1292 — shipped plugins' reads use an index", () => {
  it("covers every shipped plugin", () => {
    expect(new Set(READS.map(([p]) => p))).toEqual(
      new Set(Object.keys(PLUGINS).filter((p) => p !== "control")),
    );
  });

  for (const [plugin, def] of Object.entries(PLUGINS)) {
    for (const zone of ["schema", "adminSchema"] as const) {
      for (const [table, columns] of Object.entries(def[zone] ?? {})) {
        it(`#1536 ${plugin} ${zone}.${table}: the manifest's index leads are the catalog's`, async () => {
          const inTx = <T>(fn: (tx: TransactionRunner) => Promise<T>): Promise<T> =>
            zone === "schema"
              ? adapter.withPublicTransaction(SYSTEM, fn)
              : adapter.withAdminTransaction(SYSTEM, fn);
          const catalog = await inTx((tx) => indexLeadColumns(tx, schemaOf(plugin), table));
          const declared = declaredIndexLeads({
            zone,
            columns,
            indexes: def.indexes as Parameters<typeof declaredIndexLeads>[0]["indexes"],
            table,
          });
          const sorted = (s: ReadonlySet<string>) => [...s].sort();
          expect(sorted(declared.any)).toEqual(sorted(catalog.any));
          expect(sorted(declared.ordered)).toEqual(sorted(catalog.ordered));
        });
      }
    }
  }

  it("control: without the declaration the host refuses the read and the plan scans the table", async () => {
    const found = await plan("control", "schema", "public_users", { email: "a@b.c" });
    expect(found.refusal).toContain('no index covers this read of "public_users"');
    expect(found.problem).toMatch(/^(Seq Scan|no index condition on email)/);
  });

  for (const [plugin, zone, table, filter] of READS) {
    it(`${plugin} ${zone}.${table} ${JSON.stringify(filter)}`, async () => {
      const found = await plan(plugin, zone, table, filter);
      if (process.env.CAELO_PRINT_PLANS) {
        console.log(`${plugin} ${zone}.${table} ${JSON.stringify(filter)} → ${found.summary}`);
      }
      expect(found.refusal).toBeNull();
      expect(found.problem).toBeNull();
    });
  }
});
