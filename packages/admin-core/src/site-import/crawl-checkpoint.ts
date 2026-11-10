// SPDX-License-Identifier: MPL-2.0

/**
 * The crawl's frontier as the admin keeps it (issues #192, #425, #1360):
 * after every batch the crawl's job reports where it stands, and the next
 * attempt resumes from there instead of starting over.
 *
 * Two readers, two rules:
 *
 *   - a checkpoint the job REPORTS is untrusted data and must match
 *     {@link crawlCheckpointSchema} exactly (bounded, strict); a malformed
 *     one is a bug in the job, refused loudly;
 *   - a checkpoint the admin READS BACK from `import_runs.crawl_state` was
 *     written by this code or by the in-admin crawl worker of a release
 *     before #1360, whose checkpoints lack the #425 fields;
 *     {@link parseStoredCheckpoint} revives both and restarts the crawl
 *     from its source on anything else (UNIQUE(run_id, source_url) absorbs
 *     the replay).
 */

import { type CrawlCheckpoint, MAX_SKIPPED_REPORTED } from "@caelo-cms/site-importer";
import { z } from "zod";

const url = z.string().min(1).max(4000);
const urlWithReason = z.object({ url, reason: z.string().max(2000) }).strict();

/**
 * A reported checkpoint. Bounds well above any real crawl (at most 2000
 * pages, the frontier compacted by {@link compactCheckpoint}) and far below
 * what a run may upload.
 */
export const crawlCheckpointSchema = z
  .object({
    queue: z.array(z.object({ url, depth: z.number().int().min(0).max(10) }).strict()).max(200_000),
    seen: z.array(url).max(200_000),
    pagesCrawled: z.number().int().min(0).max(100_000),
    errors: z.array(urlWithReason).max(50_000),
    skipped: z.array(urlWithReason).max(MAX_SKIPPED_REPORTED),
    skippedOutOfScope: z.number().int().min(0).max(10_000_000),
  })
  .strict();

/**
 * The frontier without the entries the crawl would skip anyway: a URL it
 * has seen, or one queued before. The crawler queues every link it finds
 * and dedupes when it takes the next one (`seen`), so the first entry of a
 * URL is the one it would crawl; dropping the rest changes no step of the
 * resumed crawl and keeps the checkpoint the size of the real frontier.
 */
export function compactCheckpoint(cp: CrawlCheckpoint): CrawlCheckpoint {
  const seen = new Set(cp.seen);
  const queued = new Set<string>();
  const queue = cp.queue.filter((q) => {
    if (seen.has(q.url) || queued.has(q.url)) return false;
    queued.add(q.url);
    return true;
  });
  return { ...cp, queue };
}

/**
 * The frontier stored on a run, or null to crawl from the source again
 * (nothing stored, the run report's end state, or an unreadable value).
 */
export function parseStoredCheckpoint(raw: unknown): CrawlCheckpoint | null {
  const v = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (typeof v !== "object" || v === null) return null;
  const cp = v as Partial<CrawlCheckpoint>;
  if (!Array.isArray(cp.queue) || !Array.isArray(cp.seen)) return null;
  if (typeof cp.pagesCrawled !== "number") return null;
  const hasUrl = (e: unknown): e is { url: string } =>
    typeof e === "object" && e !== null && typeof (e as { url?: unknown }).url === "string";
  const hasReason = (e: unknown): e is { url: string; reason: string } =>
    hasUrl(e) && typeof (e as { reason?: unknown }).reason === "string";
  return {
    queue: cp.queue
      .filter(hasUrl)
      .map((q) => ({ url: q.url, depth: Number((q as { depth?: unknown }).depth) || 0 })),
    seen: cp.seen.filter((x): x is string => typeof x === "string"),
    pagesCrawled: cp.pagesCrawled,
    errors: Array.isArray(cp.errors)
      ? cp.errors.filter(hasUrl).map((e) => ({
          url: e.url,
          reason: String((e as { reason?: unknown }).reason ?? ""),
        }))
      : [],
    // issue #425 — the skip ledger joined the checkpoint later; an older
    // checkpoint resumes with an empty one. An entry without its reason
    // must not reach the report claiming to have one (PR #435 review).
    skipped: Array.isArray(cp.skipped)
      ? cp.skipped.filter(hasReason).map((e) => ({ url: e.url, reason: e.reason }))
      : [],
    skippedOutOfScope: typeof cp.skippedOutOfScope === "number" ? cp.skippedOutOfScope : 0,
  };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
