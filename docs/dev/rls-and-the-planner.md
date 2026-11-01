# Row-level security and the query planner

Every table in both databases has row-level security, FORCEd for owners too (CLAUDE.md §2). Postgres plans a query on such a table differently from one on a table without RLS. Two consequences shape how we write policies and indexes (#1297).

## 1. Write a setting test as `caelo_setting_is` / `caelo_setting_in`

Postgres keeps a policy's quals at the scan they protect. `process_security_barrier_quals` (`initsplan.c`) passes them on with `ojscope = qualscope`, so a policy term that references no column, like `current_setting('caelo.actor_kind', true) = 'system'`, is never marked *pseudoconstant*. In a WHERE clause the same term would become a one-time filter with selectivity 1.0. In a policy it stays a row filter and is estimated like one, and with no statistics on either side the estimators use their defaults:

| Policy term | Estimated share of rows |
|---|---|
| `current_setting(...) = 'x'` | 0.5 % (`DEFAULT_EQ_SEL`) |
| `current_setting(...) = ANY (ARRAY['a','b','c'])` | ~1.5 % |
| `(SELECT current_setting(...)) = 'x'` | 0.5 % (the InitPlan Param is still not a column) |
| `NULLIF(current_setting(...), '') IS NOT NULL` | 99.5 % (`DEFAULT_NOT_UNK_SEL`) |

At run time such a term has one value for the whole statement: every row passes or none does. An estimate of 0.5 % is therefore 200 times too low for every read the policy lets through. With that estimate an unfiltered `ORDER BY … LIMIT` on a plugin table looked as if it needed the whole table either way, so the planner chose a full scan plus a sort over reading the index in order. It also makes every core table guarded this way look 200 times smaller than it is when the planner picks join orders.

Migration 0475 adds two inlinable SQL functions to both databases:

```sql
caelo_setting_is('caelo.actor_kind', 'system')               -- setting = 'system'
caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai'])    -- setting = ANY (...)
```

Each returns `NULLIF(<comparison>, false) IS NOT NULL`. That has the same truth table as the bare comparison: a missing setting matches nothing, and the result is never NULL. The planner inlines the function and estimates the NullTest at 99.5 %. Neither function needs a superuser, so they work on Cloud SQL as well. Every core policy and every plugin-table policy (the `pluginScopePolicy` emitter in `plugin-sandbox/src/schema.ts`) uses them.

A comparison with a column, such as `plugin_id::text = current_setting('caelo.plugin_id', true)`, stays as it is. The planner estimates that one from the column's statistics.

`packages/migrations/src/rls-planner.integration.test.ts` fails when a policy in either database, in any schema, compares a setting with literals directly.

## 2. Substring search cannot be index-driven under RLS

The planner may run a user predicate before a table's policy quals only if the predicate is `LEAKPROOF` (`restriction_is_securely_promotable`, `restrictinfo.c`). An index condition always runs before every filter, so a predicate that is not leakproof can never become an index condition on an RLS table. That holds whatever the policy looks like and whatever the role is. Every Caelo session counts here, because RLS is FORCEd on every table.

| Operator | Leakproof | Under RLS |
|---|---|---|
| `=`, `<`, `>=` … on text, uuid, int | yes | index condition |
| `^@` / `starts_with` (prefix) | yes | index condition (SP-GiST `text_ops`; btree with C collation) |
| `LIKE`, `ILIKE`, `~`, `~*`, `strpos`, `lower()` | no | always a row filter |
| pg_trgm `%`, `<%`, array `@>` / `&&`, tsvector `@@` | no | always a row filter |

Only a superuser can mark a function `LEAKPROOF`, and Cloud SQL grants no superuser. So `ILIKE '%q%'` (redirects, media, content-instance and chat-title search) is a scan of the table's rows on every install, and a pg_trgm GIN or GiST index on an RLS table only adds cost to every write. Migration 0476 dropped the one that existed (`media_assets_alt_trgm_idx`), and the same test refuses new ones. A search that has to be index-driven needs an operator that is leakproof: exact or prefix matching, or equality on a precomputed token column.
