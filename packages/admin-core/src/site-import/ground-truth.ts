// SPDX-License-Identifier: MPL-2.0

/**
 * The site import's visual ground truth (issues #198, #247, #423): source
 * screenshots and computed-style design tokens for every crawled page,
 * with a loud note on every page that ends up without them.
 *
 * Since #1360 the crawl runs in a job (crawl-job.ts) and the work splits
 * along that line:
 *
 *   - job side, pure: {@link batchCaptures} turns a batch's renders into
 *     the captures to record; {@link captureMissingGroundTruth} is the
 *     second pass over the pages still without a screenshot, through a
 *     {@link GroundTruthSink} (the job's reports);
 *   - admin side: {@link recordBatchCaptures} and
 *     {@link writeRunDesignTokenAggregate} write through the Query API.
 *
 * Failure contract (CLAUDE.md §2 no-fallbacks): a page that ends up WITHOUT
 * a stored source screenshot always carries a `screenshot_missing` note
 * naming the cause (no renderer, render failed after a retry, storing it
 * failed), so downstream verification treats it as UNVERIFIED.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import {
  aggregateSiteDesignTokens,
  CRAWL_SKIP,
  type CrawledPage,
  deriveDesignTokens,
  EXTERNAL_URL_BLOCKED,
  type PageDesignTokens,
  type Screenshot,
  type Screenshotter,
} from "@caelo-cms/site-importer";
import type { CaptureTarget } from "./import-job-wire.js";

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "site-import",
};

/**
 * issue #191 — hostnames the importer's SSRF guard exempts. Set
 * CAELO_IMPORTER_ALLOWED_HOSTS to a comma-list of exact hostnames.
 * Exists for e2e fixture servers and deliberate private-network
 * crawls; empty (fully guarded) everywhere else. Read by the admin; the
 * crawl's job gets the admin's list with its start (#1360).
 */
export function importerAllowedHosts(): readonly string[] {
  return (process.env.CAELO_IMPORTER_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

/** The loud note on a captured page whose render gave no style samples. */
export const TOKENS_MISSING_NOTE =
  "Rendered page returned zero computed-style samples — no design tokens for this page. " +
  "Theme decisions fall back to the run's other pages / extractor tokens.";

/** One page's recorded ground truth. */
export interface PageCapture {
  readonly screenshotObjectKey?: string;
  readonly sampledDesignTokens?: PageDesignTokens;
}

/**
 * A screenshotter whose captures the admin already stored (#1360): the
 * crawl's job never holds the pixels, it learns where they went.
 */
export interface KeyedScreenshotter extends Screenshotter {
  /** Where the admin stored `shot`; `error` says why it could not. */
  stored(shot: Screenshot): { readonly key: string | null; readonly error: string | null };
}

/** No renderer on this install: every page is noted, none is tried again. */
export class RendererUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RendererUnavailableError";
  }
}

/**
 * The run used its render budget (#1360): the crawl skips the page and
 * takes no next one, the second pass notes every page left. Not a fault:
 * the crawl ends with the pages it has.
 */
export class RenderBudgetSpentError extends RendererUnavailableError {
  readonly code = CRAWL_SKIP;
  constructor(message: string) {
    super(message);
    this.name = "RenderBudgetSpentError";
  }
}

/**
 * The crawl's attempt has stopped (a report failed, the crawl failed, or
 * the admin ended the attempt): every later render fails at once. Coded as
 * the SSRF guard's refusal, so the crawler neither fetches the page itself
 * instead nor goes on with it; the second pass stops without a note.
 */
export class CrawlHaltedError extends Error {
  readonly code = EXTERNAL_URL_BLOCKED;
  constructor() {
    super("the crawl's attempt has stopped");
    this.name = "CrawlHaltedError";
  }
}

/**
 * issue #423 — one crawl batch's visual ground truth: the screenshot key
 * each render got and the design tokens derived from the same render's
 * style samples. A page with a stored screenshot but no samples is listed
 * for its loud `design_tokens_missing` note, because the second pass only
 * looks at pages without a screenshot and would never see it.
 */
export function batchCaptures(
  pages: readonly CrawledPage[],
  keyByUrl: ReadonlyMap<string, string>,
): {
  readonly captures: Array<{ sourceUrl: string } & PageCapture>;
  readonly tokenlessCapturedUrls: string[];
} {
  const captures: Array<{ sourceUrl: string } & PageCapture> = [];
  const tokenlessCapturedUrls: string[] = [];
  for (const p of pages) {
    const key = keyByUrl.get(p.url);
    const tokens =
      p.styleSamples && p.styleSamples.length > 0 ? deriveDesignTokens(p.styleSamples) : null;
    if (key && !tokens) tokenlessCapturedUrls.push(p.url);
    if (!key && !tokens) continue;
    captures.push({
      sourceUrl: p.url,
      ...(key ? { screenshotObjectKey: key } : {}),
      ...(tokens ? { sampledDesignTokens: tokens } : {}),
    });
  }
  return { captures, tokenlessCapturedUrls };
}

/**
 * Record one batch's captures in ONE bulk op call and note its sampleless
 * pages. A capture that matches no page of the run fails loudly: the
 * batch's rows were written moments before, so the linkage is broken.
 */
export async function recordBatchCaptures(args: {
  readonly runId: string;
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly captures: ReadonlyArray<{ sourceUrl: string } & PageCapture>;
  readonly tokenlessCapturedUrls: readonly string[];
}): Promise<void> {
  if (args.captures.length === 0) return;
  const wrote = await execute(
    args.registry,
    args.adapter,
    SYSTEM_CTX,
    "imports.set_page_captures_by_url",
    { runId: args.runId, captures: args.captures },
  );
  if (!wrote.ok) {
    throw new Error(`imports.set_page_captures_by_url rejected: ${JSON.stringify(wrote.error)}`);
  }
  const w = wrote.value as {
    updated: Array<{ importPageId: string; sourceUrl: string }>;
    unmatched: string[];
  };
  if (w.unmatched.length > 0) {
    throw new Error(
      `imports.set_page_captures_by_url matched no import_pages row for: ${w.unmatched.join(", ")}`,
    );
  }
  const idByUrl = new Map(w.updated.map((u) => [u.sourceUrl, u.importPageId]));
  for (const url of args.tokenlessCapturedUrls) {
    const importPageId = idByUrl.get(url);
    if (!importPageId) continue;
    await addNote(args, importPageId, "design_tokens_missing", TOKENS_MISSING_NOTE);
  }
}

/**
 * Append one loud note. A lost note must not mask the data around it, so a
 * failed write logs instead of throwing.
 */
export async function addNote(
  args: { readonly adapter: DatabaseAdapter; readonly registry: OperationRegistry },
  importPageId: string,
  category: "screenshot_missing" | "design_tokens_missing",
  note: string,
): Promise<void> {
  const r = await execute(args.registry, args.adapter, SYSTEM_CTX, "imports.add_page_notes", {
    importPageId,
    notes: [{ category, note: note.slice(0, 1000), applied: false }],
  }).catch((e: unknown) => ({ ok: false as const, error: e }));
  if (!r.ok) {
    console.error(
      `[site-import] failed to record ${category} note on import_page ${importPageId}:`,
      r.error,
    );
  }
}

/**
 * issue #423 — write the run-level design-token aggregate from EVERY
 * page's stored `sampled_design_tokens` (the crawl's renders and the second
 * pass), read back from the rows so neither pass clobbers the other's
 * contribution. No tokens anywhere = nothing written; the run report then
 * says loudly that theme values came from the extractor only.
 */
export async function writeRunDesignTokenAggregate(args: {
  readonly runId: string;
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
}): Promise<void> {
  const g = await execute(args.registry, args.adapter, SYSTEM_CTX, "imports.get", {
    runId: args.runId,
  });
  if (!g.ok) {
    throw new Error(`imports.get rejected while aggregating tokens: ${JSON.stringify(g.error)}`);
  }
  const pages = (g.value as { pages: Array<{ sampledDesignTokens: unknown }> }).pages;
  // Rows were written through pageDesignTokensSchema-validated ops, so the
  // cast back is sound; junk would have been rejected at write time.
  const pageTokens = pages
    .map((p) => p.sampledDesignTokens)
    .filter((t): t is PageDesignTokens => t !== null && typeof t === "object");
  if (pageTokens.length === 0) return;
  const wrote = await execute(
    args.registry,
    args.adapter,
    SYSTEM_CTX,
    "imports.set_run_design_tokens",
    { runId: args.runId, siteDesignTokens: aggregateSiteDesignTokens(pageTokens) },
  );
  if (!wrote.ok) {
    throw new Error(`imports.set_run_design_tokens rejected: ${JSON.stringify(wrote.error)}`);
  }
}

/** Where the second pass reads its pages and records what it found. */
export interface GroundTruthSink {
  /** The run's pages without a stored screenshot. */
  targets(): Promise<readonly CaptureTarget[]>;
  note(
    importPageId: string,
    category: "screenshot_missing" | "design_tokens_missing",
    note: string,
  ): Promise<void>;
  record(importPageId: string, capture: PageCapture): Promise<void>;
}

/**
 * issue #247 (WS1), #423 — the second pass: every page that still lacks a
 * stored screenshot after the crawl (a render that failed mid-crawl, a
 * fetch-only crawl, a resumed run) is rendered once more, with one retry,
 * and noted loudly when it still ends up without one. The run-level token
 * aggregate is the admin's, from row state (`writeRunDesignTokenAggregate`).
 */
export async function captureMissingGroundTruth(
  sink: GroundTruthSink,
  screenshotter: KeyedScreenshotter,
): Promise<{ captured: number; failed: number }> {
  const targets = await sink.targets();
  let captured = 0;
  let failed = 0;
  // One transient hiccup (slow host, flaky network) must not cost the
  // ground truth — retry exactly once, then note and move on.
  const captureWithRetry = async (url: string): Promise<Screenshot> => {
    try {
      return await screenshotter.capture(url, { external: true, sampleStyles: true });
    } catch (e) {
      if (e instanceof RendererUnavailableError || e instanceof CrawlHaltedError) throw e;
      return await screenshotter.capture(url, { external: true, sampleStyles: true });
    }
  };
  for (const [i, p] of targets.entries()) {
    let shot: Screenshot;
    try {
      shot = await captureWithRetry(p.sourceUrl);
    } catch (e) {
      // The attempt stopped: nothing about this page is known, so no note.
      if (e instanceof CrawlHaltedError) throw e;
      if (e instanceof RendererUnavailableError) {
        // Pre-#247 this returned silently and the run looked "done" with
        // zero screenshots (F9): every page left reads as UNVERIFIED. No
        // renderer, or (#1360) the run's render budget spent.
        const why = e.message.endsWith(".") ? e.message : `${e.message}.`;
        for (const rest of targets.slice(i)) {
          await sink.note(
            rest.importPageId,
            "screenshot_missing",
            `Source screenshot NOT captured: ${why} This page is UNVERIFIED until a source screenshot exists.`,
          );
        }
        return { captured, failed: failed + targets.length - i };
      }
      failed += 1;
      await sink.note(
        p.importPageId,
        "screenshot_missing",
        `Source screenshot NOT captured after a retry (${(e as Error).message}). ` +
          "This page is UNVERIFIED — the AI has no visual ground truth for it.",
      );
      continue;
    }
    const tokens =
      shot.styleSamples && shot.styleSamples.length > 0
        ? deriveDesignTokens(shot.styleSamples)
        : null;
    if (!tokens) await sink.note(p.importPageId, "design_tokens_missing", TOKENS_MISSING_NOTE);
    const stored = screenshotter.stored(shot);
    if (!stored.key) {
      await sink.note(
        p.importPageId,
        "screenshot_missing",
        `Source screenshot captured but storing it failed (${stored.error ?? "no reason given"}). ` +
          "This page is UNVERIFIED until a stored source screenshot exists.",
      );
    }
    if (stored.key || tokens) {
      await sink.record(p.importPageId, {
        ...(stored.key ? { screenshotObjectKey: stored.key } : {}),
        ...(tokens ? { sampledDesignTokens: tokens } : {}),
      });
    }
    captured += 1;
  }
  return { captured, failed };
}
