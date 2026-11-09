# Plugin table indexes (#1292)

A plugin's tables (`schema` in cms_public, `adminSchema` in cms_admin) get a primary key from the host and only the indexes the manifest asks for. Every read a plugin makes goes through `ctx.query.list` / `ctx.adminQuery.list` (the `plugin_storage.*` / `plugin_public_storage.*` operations), and the host refuses a read no index can drive, so no plugin read turns into a full table scan as the site grows (#1003: 50k pages × languages; the visitor path takes untrusted traffic, where a scan per request is a DoS amplifier, #635).

## Declaring indexes

```ts
export default definePlugin({
  slug: "reviews",
  version: "1.1.0",
  tier: 2,
  schema: {
    reviews: { page_id: "uuid", status: "enum:pending,approved", stars: "int", created_at: "timestamp" },
  },
  indexes: {
    schema: {
      // list("reviews", { page_id, status: "approved", orderBy: "created_at" })
      // list("reviews", { status: "pending", orderBy: "created_at", orderDir: "desc" })
      reviews: [["page_id", "status", "created_at"], ["status", "created_at"]],
    },
    // adminSchema: { <table>: [[...]] } for private storage.
  },
  operations: { /* ... */ },
});
```

- `indexes.schema` indexes `schema` tables, `indexes.adminSchema` indexes `adminSchema` tables.
- An index is a column list (`["status", "created_at"]`) or `{ columns, unique?: true, method?: "btree" | "hash" }`. At most 4 columns per index and 16 indexes per table.
- Columns must be declared on the table. Refused: `caelo_` (host) columns, `jsonb` columns, `id` as the first column (it is the primary key; `["status", "id"]` is fine), a column twice, the same index twice, a single-column index on a `ref:` column (the host builds that one).
- `unique` exists only in `schema` (cms_public). A private-storage row can change on a chat branch (as a snapshot, not as the row), where no index sees it until publish; check uniqueness in the operation instead.
- Indexed values go into a btree, which holds at most ~2.7 KB per entry — a longer stored value fails the index build (and with it the plugin's load). Bound the length of a text column you index, or, for an equality-only lookup on a value of unbounded length, declare `{ columns: [col], method: "hash" }`: a hash index stores the value's hash, serves `=` and `anyOf`, never an order, and covers exactly one column (not unique). The auth plugin indexes `public_users.email` that way, because stored emails predate its length bound.

The validator checks the declaration with the rest of the manifest (`checkPluginIndexes`, `packages/plugin-sdk/src/indexes.ts`); the emitter re-checks before writing DDL.

## Indexes the host builds itself

| Index | Zone | Why |
|---|---|---|
| primary key on `id` | both | lookups and `orderBy: "id"` / `afterId` keyset paging |
| each `ref:` column | private | a core delete cascades by it (`ON DELETE CASCADE`), and reads by it are covered |
| `caelo_chat_branch_id` (partial, `IS NOT NULL`) | private | a chat's publish and discard select the chat's rows by it |

Declared private-storage indexes are partial on `caelo_chat_branch_id IS NULL AND caelo_deleted_at IS NULL` — exactly the main-line filter every host read of private storage carries (`privateList`, `docs/branch-aware-plugin-storage.md`). A chat's own state comes from `plugin_row_snapshots` (the overlay), so branch reads use the same index for the main-line half.

## Which reads are refused

A `list()` is refused unless an index can drive it:

- **Filtered** (`{ column: value }`, `anyOf`): one of the filter columns must be the first column of a declared or automatic index, or `id`. Ordering by an indexed column does not count — `orderBy: "id"` with an unindexed filter would walk the whole primary key and test every row.
- **Unfiltered but ordered or ranged** (`orderBy`, `since` / `before`): one of those columns must lead a btree index (a hash index cannot return rows in order). `since` and `before` range over `created_at`, so a table paged by time declares `["created_at"]` (or `[filter column, "created_at"]`). `orderBy: "id"` is always covered.
- **Only a `limit`**: allowed; it stops after `limit` rows.

Put the filter columns first and the order column last (`["status", "created_at"]`): one index then serves the filter and the order. The refusal names the index to declare:

```
plugin_public_storage.list: no index covers this read of "reviews" (it filters by page_id). Declare one in the plugin's manifest — indexes: { schema: { reviews: [["page_id","created_at"]] } } — and ship it as a new version. …
```

`id`-only reads and writes (`update`, `delete`, `compareAndSwap`) go by the primary key and need nothing.

The rule itself lives in the SDK (`packages/plugin-sdk/src/index-coverage.ts`), so the host and a plugin's tests apply the same code. The host check reads the table's indexes from the database catalog (`packages/plugin-host/src/index-coverage.ts`), not from the caller: the storage operations are reachable from plugin code (`ctx.cms.call`), so an index list passed in could claim indexes that do not exist. The catalog holds exactly what the emitters built from the manifest. A read with only a `limit` skips the catalog lookup.

## Testing a plugin's reads

A unit test that fakes the store with `{ list: async () => rows }` answers every read, including the ones the host refuses. Wrap the fake in `indexCheckedQuery` from the SDK instead: it derives the table's indexes from the manifest the way the emitters build them (`declaredIndexLeads`: `id`, every declared index, and in private storage the `ref:` columns and the branch column), and a read none of them drives throws the host's refusal.

```ts
import { indexCheckedQuery } from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";

const adminQuery = indexCheckedQuery(plugin, "adminSchema", {
  list: async (table, filter) => rows.filter(/* … */),
});
```

international-site 0.12.2 shipped a read by `address` alone on a table indexed `["locale_code", "address"]` (#1536). Its unit test reached the read through a bare fake, so CI passed, and on the first install with a translated plugin text every Stage's audit errored. For the shipped plugins three tests now keep that from recurring:

- `scripts/plugin-test-stores-index-checked.test.ts` parses every test in `packages/plugins/*`. It fails on an object literal that defines `list` (as a property, a method or a shorthand) and is not handed to `indexCheckedQuery`, and on an assignment to `<handle>.list`, which would replace a checked `list` later.
- `packages/admin-core/src/__tests__/plugin-indexes-shipped.integration.test.ts` provisions every shipped plugin and checks that `declaredIndexLeads` matches what the catalog holds for each table, so the unit-tier check refuses exactly what the host refuses. It also plans each listed read shape with sequential scans off.
- The integration tests that run two plugins together (for example `consent-category-translation.integration.test.ts`, which calls `audit_findings` with a plugin text in the store) reach the reads only another plugin's data triggers.

A read that no test reaches is still unchecked. Each new read gets a unit test through a checked fake.

## Fixing a refused read

First check whether the read can carry the column the declared index leads with. The #1536 read wanted one language at a time anyway, so it now runs once per language with `locale_code` set. That changes code and leaves the manifest alone. A release-signed plugin's approval is bound to its manifest digest (`approved_manifest_digest`, #1332), so such a fix reaches installs with the next release and the Owner does not have to approve again. Declare a new index only when the read's shape needs one. That changes the manifest, and with it the digest, so the plugin stops on the next release until the Owner approves it.

## Names, evolution, existing installs

Index names are `caelo_ix_<table>_<columns>_<8 hex>`: the readable part is cut to fit Postgres' 63-byte limit, and the hash covers the whole definition (table, columns, uniqueness, predicate), so names are deterministic, two long definitions never truncate into one name, and a changed definition gets a new name.

Both emitters (`schemaFromSpec` / `adminSchemaFromSpec`, `packages/plugin-sandbox/src/schema.ts`) emit `CREATE INDEX IF NOT EXISTS` for every index of a table and then drop each `caelo_ix_` index of the table they did not emit — like #1146 drops undeclared columns. The emitters run on every load of a plugin — at every admin boot for a release-shipped plugin, on activation and every load for an installed one — and provisioning applies their DDL whenever it differs from the digest recorded for the schema (`plugin_schema_provisions`, `packages/query-api/src/plugin-schema-provision.ts`). So an existing install gets a version's indexes the first time that version loads, and loses the ones it stopped declaring; nothing else has to run, and no migration is involved. The build takes a `SHARE` lock on the table while it runs (it is inside the provisioning transaction, so not `CONCURRENTLY`), which holds the plugin's writes for that time on a large table — once, on the first load of the version.

`indexes` is part of the manifest, so changing it changes the artifact digest: a shipped plugin is re-signed with the release, an installed plugin's new version is a new artifact the Owner approves (CLAUDE.md §2, one plugin model). A version that does not declare what its reads need fails those reads with the message above — in its own tests, before it ships.
