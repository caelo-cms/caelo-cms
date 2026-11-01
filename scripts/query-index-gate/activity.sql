-- SPDX-License-Identifier: MPL-2.0
--
-- Issue #1293 — the query index gate job samples this every 20 s during the
-- integration run and prints it when the run fails: the sessions busy for
-- more than 5 s and what they wait on, so a stalled run says what stalled it.
SELECT now()::time(0) || ' | ' || pid || ' | ' || coalesce(application_name, '') || ' | ' ||
       coalesce(state, '') || ' | ' || coalesce(wait_event_type, '') || ':' ||
       coalesce(wait_event, '') || ' | xact ' || coalesce((now() - xact_start)::interval(0)::text, '') ||
       ' | ' || left(regexp_replace(query, '\s+', ' ', 'g'), 200)
FROM pg_stat_activity
WHERE state <> 'idle'
  AND pid <> pg_backend_pid()
  AND backend_type = 'client backend'
  AND now() - coalesce(query_start, now()) > interval '5 seconds';
