// SPDX-License-Identifier: MPL-2.0

/**
 * Send the WebSub pings and IndexNow submissions that are due
 * (docs/dev/search-engine-feed.md). Called right after a production run is
 * recorded (inside the request that published) and on every scheduler tick
 * for retries; never from a timer (CLAUDE.md §11.B Tier 5).
 *
 * Each notification is claimed in a short transaction, sent with no
 * transaction open, and its outcome recorded in another. A sender that dies
 * mid-request leaves the claim to lapse, and the tick sends it again.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import {
  INDEXNOW_ENDPOINT,
  INDEXNOW_MAX_URLS,
  indexNowKeyFile,
  WEBSUB_HUB_URL,
} from "@caelo-cms/shared";
import { describeError } from "../ai/tools/_describe-error.js";
import { SYSTEM_ACTOR_ID } from "../audit.js";
import type { ClaimedSearchNotification } from "../ops/search-notifications.js";
import { searchNotifyDisabledReason } from "./notifications.js";

/** A response, as far as the sender reads it. */
export interface SearchNotifyResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The HTTP client (fetch by default; tests pass their own). */
export type SearchNotifyFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<SearchNotifyResponse>;

/** One request of a notification. */
export interface SearchNotifyRequest {
  readonly url: string;
  /** Names the request in what is recorded ("the WebSub hub", "IndexNow for example.com"). */
  readonly label: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const USER_AGENT = "Caelo-CMS (+https://caelo-cms.com)";
const REQUEST_TIMEOUT_MS = 10_000;

/** The WebSub publish ping for `feedUrl` (`hub.mode=publish`, form-encoded). */
export function websubRequest(feedUrl: string): SearchNotifyRequest {
  return {
    url: WEBSUB_HUB_URL,
    label: "the WebSub hub",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ "hub.mode": "publish", "hub.url": feedUrl }).toString(),
  };
}

/**
 * The IndexNow submissions for `urls`: one per host (a submission names
 * one host, whose root serves the key file), at most
 * {@link INDEXNOW_MAX_URLS} URLs each. A URL that is not an absolute
 * http(s) address cannot be submitted and is returned as `invalid`.
 */
export function indexNowRequests(
  key: string,
  urls: readonly string[],
): { readonly requests: SearchNotifyRequest[]; readonly invalid: string[] } {
  const byOrigin = new Map<string, { host: string; urls: string[] }>();
  const invalid: string[] = [];
  for (const u of urls) {
    const parsed = URL.parse(u);
    if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      invalid.push(u);
      continue;
    }
    const entry = byOrigin.get(parsed.origin) ?? { host: parsed.host, urls: [] };
    entry.urls.push(u);
    byOrigin.set(parsed.origin, entry);
  }
  const requests: SearchNotifyRequest[] = [];
  for (const [origin, { host, urls: list }] of [...byOrigin].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (let at = 0; at < list.length; at += INDEXNOW_MAX_URLS) {
      requests.push({
        url: INDEXNOW_ENDPOINT,
        label: `IndexNow for ${host}`,
        headers: { "Content-Type": "application/json; charset=utf-8", "User-Agent": USER_AGENT },
        body: JSON.stringify({
          host,
          key,
          keyLocation: `${origin}/${indexNowKeyFile(key)}`,
          urlList: list.slice(at, at + INDEXNOW_MAX_URLS),
        }),
      });
    }
  }
  return { requests, invalid };
}

/** What an answer means: done, try again later, or give up. */
export type SearchNotifyOutcome = "sent" | "retry" | "failed";

/**
 * Classify an engine's answer. 2xx is done (IndexNow's 202 means the key
 * is still being checked: received). 429 and 5xx are passing; any other 4xx
 * is a request the engine will refuse again (a bad key file: 403, URLs of
 * another host: 422).
 */
export function classifyStatus(status: number): SearchNotifyOutcome {
  if (status >= 200 && status < 300) return "sent";
  if (status === 429 || status >= 500) return "retry";
  return "failed";
}

/** Seconds of a `Retry-After` header (delta seconds or an HTTP date), or null. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed), 86_400);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.min(Math.max(0, Math.ceil((at - now) / 1000)), 86_400);
}

/**
 * The outcome of a notification's requests together. A passing error on any
 * request retries the notification (the engines tolerate a repeat); else one
 * accepted request makes it sent, since what was refused — a host whose key
 * file the engine cannot read, say — would be refused again; else it failed.
 */
export function combineOutcomes(outcomes: readonly SearchNotifyOutcome[]): SearchNotifyOutcome {
  if (outcomes.includes("retry")) return "retry";
  return outcomes.includes("sent") ? "sent" : "failed";
}

/** What to record for one notification. */
interface SendResult {
  readonly outcome: SearchNotifyOutcome;
  readonly responseStatus: number | null;
  readonly detail: string | null;
  readonly retryAfterSeconds: number | null;
}

const failedWith = (detail: string): SendResult => ({
  outcome: "failed",
  responseStatus: null,
  detail,
  retryAfterSeconds: null,
});

/** Send one claimed notification; returns what to record. */
async function sendOne(
  n: ClaimedSearchNotification,
  fetchImpl: SearchNotifyFetch,
): Promise<SendResult> {
  let requests: SearchNotifyRequest[];
  const notes: string[] = [];
  if (n.channel === "websub") {
    if (n.feedUrl === null) return failedWith("the run serves no feed");
    requests = [websubRequest(n.feedUrl)];
  } else {
    if (n.indexNowKey === null) return failedWith("the run serves no IndexNow key");
    const built = indexNowRequests(n.indexNowKey, n.urls);
    requests = built.requests;
    if (built.invalid.length > 0) {
      notes.push(
        `${built.invalid.length} address(es) are not absolute and were left out (${built.invalid.slice(0, 3).join(", ")})`,
      );
    }
    if (requests.length === 0) return failedWith(notes.join("; "));
  }
  const outcomes: SearchNotifyOutcome[] = [];
  let responseStatus: number | null = null;
  let retryAfter: number | null = null;
  for (const req of requests) {
    try {
      const res = await fetchImpl(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const step = classifyStatus(res.status);
      outcomes.push(step);
      responseStatus = res.status;
      if (step !== "sent") {
        const text = (await res.text().catch(() => "")).trim().slice(0, 300);
        notes.push(`${req.label} answered ${res.status}${text ? `: ${text}` : ""}`);
        retryAfter = Math.max(
          retryAfter ?? 0,
          retryAfterSeconds(res.headers.get("retry-after")) ?? 0,
        );
      }
    } catch (e) {
      outcomes.push("retry");
      notes.push(`${req.label} did not answer: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    outcome: combineOutcomes(outcomes),
    responseStatus,
    detail: notes.length > 0 ? notes.join("; ").slice(0, 2000) : null,
    retryAfterSeconds: retryAfter,
  };
}

let sends = 0;

/**
 * Send what is due (only `runId`'s when given) and record each outcome.
 * Never throws for an engine's answer; a failed claim or record throws.
 *
 * @returns how many were sent, are waiting for a retry, or failed for good.
 */
export async function sendSearchNotifications(opts: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly runId?: string;
  readonly fetch?: SearchNotifyFetch;
}): Promise<{ sent: number; retrying: number; failed: number }> {
  const ctx = {
    actorId: SYSTEM_ACTOR_ID,
    actorKind: "system" as const,
    requestId: `search-notify-${sends++}`,
  };
  // Off on this install: what is due is marked skipped, nothing is sent.
  const off = searchNotifyDisabledReason(process.env);
  const claimedR = await execute(opts.registry, opts.adapter, ctx, "search_notify.claim", {
    ...(opts.runId ? { runId: opts.runId } : {}),
    limit: 20,
    ...(off === null ? {} : { skipReason: off }),
  });
  if (!claimedR.ok) throw new Error(`search_notify.claim failed: ${describeError(claimedR.error)}`);
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as SearchNotifyFetch);
  const tally = { sent: 0, retrying: 0, failed: 0 };
  for (const n of (claimedR.value as { claimed: ClaimedSearchNotification[] }).claimed) {
    // A notification the sender cannot even build is recorded as failed, so
    // it never blocks the ones after it or comes back on every claim.
    const result = await sendOne(n, fetchImpl).catch(
      (e: unknown): SendResult =>
        failedWith(`could not be sent: ${e instanceof Error ? e.message : String(e)}`),
    );
    const recorded = await execute(opts.registry, opts.adapter, ctx, "search_notify.record", {
      id: n.id,
      ...result,
    });
    if (!recorded.ok) {
      throw new Error(`search_notify.record failed: ${describeError(recorded.error)}`);
    }
    const status = (recorded.value as { status: "sent" | "pending" | "failed" | "skipped" }).status;
    if (status === "sent") tally.sent += 1;
    else if (status === "pending") tally.retrying += 1;
    else if (status === "failed") tally.failed += 1;
  }
  return tally;
}

/**
 * After a production run is recorded: send its notifications now, inside
 * the request that published. A failure is logged and left to the tick —
 * the site is live either way.
 */
export async function sendSearchNotificationsAfterPublish(opts: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly runId: string;
}): Promise<void> {
  try {
    const r = await sendSearchNotifications(opts);
    if (r.retrying + r.failed > 0) {
      console.warn("[search-notify] not every notification went out; Settings → SEO shows why", {
        runId: opts.runId,
        ...r,
      });
    }
  } catch (e) {
    console.error("[search-notify] could not send after the publish; the scheduler retries", {
      runId: opts.runId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
