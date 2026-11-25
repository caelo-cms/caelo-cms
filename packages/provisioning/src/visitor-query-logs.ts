// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1649) — visitors' search queries stay out of the install's
 * logs. A declared collection operation (search, suggest, read) answers a
 * GET whose query string carries what the visitor typed:
 * `/api/plugin/<slug>/<op>?q=…&lang=…`. The gateway itself never logs it
 * (its `gateway_request_log` row has the operation, not the query), but
 * Google Cloud writes a request log entry for every request a Cloud Run
 * service, the load balancer or Firebase Hosting serves, with the full URL
 * in `httpRequest.requestUrl`. A visitor's query is personal data the
 * install has no use for in its logs.
 *
 * So every Google Cloud install excludes those entries from every sink the
 * install routes logs through: `_Default` (the project's own log bucket)
 * and, on `gcp`, the edge log sink to BigQuery (the stack declares the same
 * exclusion there). A sink exclusion drops the entry before it is stored,
 * so nothing is kept anywhere. The rest of the request's record stays: the
 * gateway's own request log row (operation, status, duration).
 *
 * The filter matches by method and URL shape only, never by service or
 * resource type: whichever Google service logged the request (Cloud Run,
 * the load balancer, Firebase Hosting's optional Cloud Logging
 * integration), an entry with such a URL is dropped. Only collection
 * operations are GETs under `/api/plugin/` (plugin operations are POSTs),
 * so no other request disappears from the logs.
 *
 * Pure module: the stacks import it from `dist/`; collections-setup.ts
 * applies it with gcloud on install and converge.
 */

/**
 * The Cloud Logging query of the exclusion. `=~` is an RE2 match anywhere in
 * the value; `[?]` is a literal question mark without an escape the query
 * language would read first. A route without a query string (the uncached
 * `/release` lookup) carries nothing of the visitor's and stays logged.
 */
export const VISITOR_QUERY_LOG_FILTER =
  'httpRequest.requestMethod="GET" AND httpRequest.requestUrl=~"/api/plugin/[a-z][a-z0-9-]*/[a-z_][a-z0-9_]*[?]"';

/** The exclusion's description, as the Cloud Console shows it. */
export const VISITOR_QUERY_LOG_DESCRIPTION =
  "Caelo: visitors' search queries (GET /api/plugin/<slug>/<op>?...) are not stored (epic #1644)";

/** The sink every Google Cloud project routes its logs through by default. */
export const DEFAULT_LOG_SINK = "_Default";
