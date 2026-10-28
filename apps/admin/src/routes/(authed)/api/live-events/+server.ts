// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1215 — wait for a live-refresh topic. An editor tab calls this only
 * while it waits on work that is in progress and no chat stream of its own
 * is open (a quality audit running, an external agent working in the chat,
 * a crawl, a deploy). It is how such a tab hears the change without polling
 * the admin on a timer (CLAUDE.md §11.B).
 *
 *   GET ?topics=agents,pending → { topics: LiveTopic[] }
 *
 * Answers with the requested topics that were published in this admin
 * process (see `live-events.ts` in admin-core), or `[]` after
 * {@link WAIT_MS}. The request holds no database connection and the server
 * runs no loop for it: one listener and one deadline. The wait stays below
 * the ~14 s after which the load balancer / IAP closes a response that sends
 * no bytes, so no keep-alive writes are needed either.
 *
 * Topics are hints, not data: the tab re-reads the surface through its own
 * permission-checked endpoint.
 */

import { waitForLiveTopics } from "@caelo-cms/admin-core";
import { parseLiveTopics } from "@caelo-cms/shared";
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

/** Longest wait before answering `[]`. Below the proxies' idle-close (~14 s). */
const WAIT_MS = 10_000;
/** One burst of commits (a proposal and its audit row) answers once. */
const SETTLE_MS = 150;

export const GET: RequestHandler = async ({ url, locals, request }) => {
  if (!locals.user) throw error(401, "Not authenticated");
  const parsed = parseLiveTopics(url.searchParams.get("topics"));
  if (!parsed.ok) {
    throw error(400, `unknown live topic(s): ${parsed.unknown.join(", ")}`);
  }
  if (parsed.topics.length === 0) {
    throw error(400, "topics is required: a comma-separated list such as topics=agents,pending");
  }
  const topics = await waitForLiveTopics(parsed.topics, {
    timeoutMs: WAIT_MS,
    settleMs: SETTLE_MS,
    signal: request.signal,
  });
  return json({ topics }, { headers: { "cache-control": "no-store" } });
};
