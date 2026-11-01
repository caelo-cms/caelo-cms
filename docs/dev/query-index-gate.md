# Query index gate

Two CI gates keep a query that filters on an unindexed column from reaching
`main` (issue #1293). Without them each new operation or plugin table can add
a full scan, and at the 50,000-page target (#1003) every one of those is
O(n) per call — and O(n²) per Stage when it runs once per page.

| Gate | What it checks | Where |
|---|---|---|
| **Plan gate** | Every query a Query API transaction runs during the integration tier: a filtered full scan fails unless a list entry explains it. | CI job `Query index gate (unindexed filters)`; `scripts/query-index-gate/` |
| **FK index lint** | Every foreign key of the migrated `cms_admin` and `cms_public` schemas has a non-partial index with the FK columns leading. | `scripts/query-index-gate/fk-index-lint.integration.test.ts` (runs in the main check and in the gate job) |

## How the plan gate works

1. **Op tag.** Every transaction the Database Adapter opens sets
   `application_name = 'caelo/<holder>'` LOCAL, in the same `set_config`
   statement as the caller's identity
   (`packages/query-api/src/statement-tag.ts`). The holder is the operation
   name — `plugin_storage.list` for a plugin's storage read — or the
   `withAdminTransaction` holder label. It costs no extra round trip, the
   statement text never changes (prepared statements are reused as before)
   and it reverts at COMMIT. Trigger statements an operation fires (the
   change journal, Postgres's FK checks) run under its tag. Test fixtures
   run SQL on the raw pools, outside any adapter transaction, so they carry
   no tag and the gate ignores them. In production the tag shows the running
   operation in `pg_stat_activity`.
2. **Plan log.** The job's Postgres (`postgres:17-alpine`, the same as the
   main check) runs with `enable_seqscan=off`, `auto_explain` logging the
   plan of every statement, nested ones included, and
   `log_line_prefix='@@%a@@ '`. With `enable_seqscan=off` the planner takes
   any index that can serve a predicate, even on a three-row test table, so
   a full scan that still filters means no index serves that filter.
3. **Stream filter.** The raw log of a run is about a gigabyte. The
   server's logging collector writes it into a FIFO that
   `seqscan-filter.ts` reads on the runner (the collector reassembles each
   message, so the plans of concurrent backends never interleave, which
   they do on a plain stderr pipe once a plan exceeds `PIPE_BUF`). The
   reader must keep up — a slow one backs up the collector and with it
   every backend (an awk version kept up locally but stretched the CI run
   past its timeout). The Bun filter reads ~270 MB/s, linear in the input,
   and keeps an entry's first 40 and last 400 lines (the statement's start
   and the plan). The filter keeps only
   tagged plans that contain a Seq Scan or an Index (Only) Scan with a
   `Filter` but no `Index Cond` (a whole index walked for its order), strips
   costs, durations and output lists, and drops repeats. Nothing else
   reaches disk or `docker logs`.
4. **Analyzer.** `analyze.ts` parses each full scan into a finding
   `(op, relation, normalised filter)`: constants and parameters become
   `?`, and AND terms are dropped when they are the relation's RLS policy
   (read from `pg_policies` after the run, `policies.sql`) or read a
   session setting (`current_setting(...)`, the branch identity). A scan
   with nothing left is an unfiltered read and is not gated; so is one
   whose filter is only the live-row / branch columns
   (`chat_branch_id IS NULL`, `deleted_at IS NULL`, their plugin
   `caelo_…` twins, `chat_branch_id IS NULL OR chat_branch_id = ?`) —
   those select nearly every row, so no index serves them; their cost is
   the domain size, which the rows-read gate measures.
   Postgres's own FK statements (`SELECT 1 FROM ONLY … FOR KEY SHARE`,
   `UPDATE ONLY … SET … = NULL`, `DELETE FROM ONLY …`) are classified `fk`;
   for core tables the FK lint owns those, for plugin tables (created at
   activation, not by migrations) the plan gate keeps them.
   A whole-index walk with a filter is listed as **advisory** and never
   fails the gate: on a near-empty test table the planner may walk an index
   for its order at the same cost as the lookup it takes on real data (an
   empty `media_assets` showed `WHERE id = $1` walking a partial index),
   so unlike a Seq Scan it proves nothing. Walks where another index leads
   with a filter column are dropped from the advisory list altogether
   (`indexes.sql`).
5. **Verdict.** Every Seq Scan finding must match an `ALLOWED` or a `PENDING` entry
   of `allowlist.ts`, and every entry must match at least one finding —
   a stale entry fails too. The job summary and the `query-index-gate`
   artifact (`seq.log`, `findings.json`) carry the details.

## Reading a failure

A failing line names the relation, the operation and the filter, plus the
first line of the statement:

```
- `public.redirects` · op `pages.move_pages` · filter `(to_path = ?)`
  - statement: `SELECT id, from_path FROM redirects WHERE to_path = $1`
```

Then pick one:

- **Add an index** — the normal answer. A migration with
  `CREATE INDEX IF NOT EXISTS <table>_<cols>_idx ON <table> (<cols>)` whose
  leading columns are the filter's equality columns. A partial index only
  helps when the query carries its predicate literally (`WHERE deleted_at IS
  NULL`); the FK checks never do. For a plugin table, declare the index in
  the plugin's manifest (#1292).
- **Add an `ALLOWED` entry** — only when the scan is fine at any size: a
  singleton or fixed-size table (`site_defaults`, `deploy_targets`), a
  deliberate whole-table read of a small domain, a maintenance scan that
  runs once. Narrow it with `op` and `filter` and write the reason; the
  reason is reviewed like code.

A **stale entry** means the index exists now or the query is gone: delete the
entry. A `PENDING` entry is a `FIXME(issue #N)` for a known finding a tracked
issue fixes; the fixing PR deletes the entries it makes stale.

## Reading an FK lint failure

`cms_admin child(parent_id) -> parent` means deleting a `parent` row looks
the children up by `parent_id` without an index: a full scan of `child` per
deleted parent. Add a non-partial index with the FK columns leading (a
partial one counts only with exactly `WHERE <fk> IS NOT NULL`, which the
lookup's `<fk> = $1` implies), or an
`FK_EXEMPTIONS` entry in `fk-index-lint.ts` (FKs onto `actors` are exempt as
a class: no operation deletes an actor). A stale entry fails the lint the
same way.

## Running it locally

```sh
# Postgres 17 with auto_explain (Homebrew postgresql@17 ships it), on its own port.
initdb -D /tmp/gate-pg -U postgres --auth=trust
mkfifo -m 666 /tmp/gate-pg.fifo
bun scripts/query-index-gate/seqscan-filter.ts <> /tmp/gate-pg.fifo > /tmp/seq.log &
postgres -D /tmp/gate-pg -p 55493 -c listen_addresses=localhost \
  -c logging_collector=on -c log_directory=/tmp -c log_filename=gate-pg.fifo \
  -c log_rotation_age=0 -c log_rotation_size=0 \
  -c shared_preload_libraries=auto_explain -c auto_explain.log_min_duration=0 \
  -c auto_explain.log_nested_statements=on -c auto_explain.log_verbose=on \
  -c auto_explain.log_parameter_max_length=0 -c enable_seqscan=off \
  -c "log_line_prefix=@@%a@@ " &
# bootstrap.sh + `bun run db:migrate` against port 55493, then:
bun run test $(git ls-files '*.integration.test.ts')
psql -h localhost -p 55493 -U postgres -d postgres -c 'SELECT 1'   # flushes the last plan
for dump in policies indexes; do
  for db in cms_admin cms_public; do
    psql -h localhost -p 55493 -U postgres -d $db -At -F "$(printf '\t')" \
      -f scripts/query-index-gate/$dump.sql
  done > /tmp/$dump.tsv
done
bun scripts/query-index-gate/analyze.ts /tmp/seq.log \
  --policies /tmp/policies.tsv --indexes /tmp/indexes.tsv
```

One test file is enough to check a single change; stale entries are only
meaningful over the whole tier.

## Limits

- Only Query API transactions are gated. A worker that runs SQL on the raw
  pools is invisible to the gate (and should not exist: CLAUDE.md §2).
- An operation predicate written with `current_setting(...)` is dropped with
  the RLS terms.
- Only code paths the integration tier runs are checked.
- `enable_seqscan=off` is server-wide, so fixture SQL plans that way too.
  A fixture that bulk-deletes thousands of rows makes every FK check walk
  a whole index per deleted row (O(n²)) and can outlast the hook timeout;
  such fixture transactions say `SET LOCAL enable_seqscan = on` (the
  preload's reset and the list-resolve scale test do). A stalled gate run
  prints the sessions that were busy for more than 5 s (`activity.sql`).
- Production plan monitoring (`pg_stat_statements`) is out of scope.
