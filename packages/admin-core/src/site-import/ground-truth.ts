// SPDX-License-Identifier: MPL-2.0

/**
 * The site import's visual ground truth (issues #198, #247, #423): source
 * screenshots and computed-style design tokens for every crawled page,
 * with a loud note on every page that ends up without them. Driven by the
 * crawl worker (crawl-worker.ts) after each batch and once after the crawl.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import {
  aggregateSiteDesignTokens,
  type CrawledPage,
  createPlaywrightScreenshotter,
  deriveDesignTokens,
  type PageDesignTokens,
  type Screenshot,
  type Screenshotter,
} from "@caelo-cms/site-importer";

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "site-import",
};

/**
 * issue #191 — hostnames the importer's SSRF guard exempts. Set
 * CAELO_IMPORTER_ALLOWED_HOSTS to a comma-list of exact hostnames.
 * Exists for e2e fixture servers and deliberate private-network
 * crawls; empty (fully guarded) everywhere else.
 */
export function importerAllowedHosts(): readonly string[] {
  return (process.env.CAELO_IMPORTER_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

/**
 * issue #423 — persist one crawl batch's visual ground truth: screenshot
 * object keys (uploaded by the crawl's onPageCapture sink) + design
 * tokens derived from the same render session's style samples, in ONE
 * bulk op call. Pages with a stored screenshot but ZERO style samples get
 * the loud `design_tokens_missing` note here, because the post-crawl
 * ground-truth pass only touches keyless pages and would never see them.
 *
 * Exported for the integration tests to drive directly without standing
 * up the polling worker.
 */
export async function persistBatchCapture(args: {
  readonly runId: string;
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly pages: readonly CrawledPage[];
  /** url → uploaded screenshot object key (absent = no stored pixels). */
  readonly screenshotKeyByUrl: ReadonlyMap<string, string>;
}): Promise<void> {
  const captures = args.pages.flatMap((p) => {
    const key = args.screenshotKeyByUrl.get(p.url);
    const tokens =
      p.styleSamples && p.styleSamples.length > 0 ? deriveDesignTokens(p.styleSamples) : null;
    if (!key && !tokens) return [];
    return [
      {
        sourceUrl: p.url,
        ...(key ? { screenshotObjectKey: key } : {}),
        ...(tokens ? { sampledDesignTokens: tokens } : {}),
      },
    ];
  });
  if (captures.length === 0) return;

  const wrote = await execute(
    args.registry,
    args.adapter,
    SYSTEM_CTX,
    "imports.set_page_captures_by_url",
    { runId: args.runId, captures },
  );
  if (!wrote.ok) {
    // System-scoped op fed by our own crawl output — a rejection is a real
    // bug (schema drift), not an environment quirk (no-fallbacks pre-1.0).
    throw new Error(`imports.set_page_captures_by_url rejected: ${JSON.stringify(wrote.error)}`);
  }
  const w = wrote.value as {
    updated: Array<{ importPageId: string; sourceUrl: string }>;
    unmatched: string[];
  };
  if (w.unmatched.length > 0) {
    // The batch's rows were written by write_extracted_pages moments ago
    // (ON CONFLICT keeps replayed rows), so an unmatched URL means the
    // linkage is broken — fail the run loudly rather than staging pages
    // whose ground truth silently went nowhere.
    throw new Error(
      `imports.set_page_captures_by_url matched no import_pages row for: ${w.unmatched.join(", ")}`,
    );
  }

  // Loud design_tokens_missing markers for captured-but-sampleless pages
  // (same wording as the ground-truth pass). Note-write failures log
  // instead of throwing — a lost note must not mask the batch's data.
  const idByUrl = new Map(w.updated.map((u) => [u.sourceUrl, u.importPageId]));
  for (const p of args.pages) {
    if (!args.screenshotKeyByUrl.has(p.url)) continue; // keyless → after-pass owns notes
    if (p.styleSamples && p.styleSamples.length > 0) continue;
    const importPageId = idByUrl.get(p.url);
    if (!importPageId) continue;
    const noted = await execute(args.registry, args.adapter, SYSTEM_CTX, "imports.add_page_notes", {
      importPageId,
      notes: [
        {
          category: "design_tokens_missing",
          note:
            "Rendered page returned zero computed-style samples — no design tokens for this page. " +
            "Theme decisions fall back to the run's other pages / extractor tokens.",
          applied: false,
        },
      ],
    }).catch((e) => ({ ok: false as const, error: e }));
    if (!noted.ok) {
      console.error(
        `[site-import] failed to record design_tokens_missing note on import_page ${importPageId}:`,
        noted.error,
      );
    }
  }
}

/**
 * issue #423 — write the run-level design-token aggregate from EVERY
 * page's stored `sampled_design_tokens` (crawl-time captures + the
 * post-crawl pass), so neither pass clobbers the other's contribution.
 * No tokens anywhere = nothing written; the run report then says loudly
 * that theme values came from the extractor only.
 *
 * Exported for the integration tests to drive directly.
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

/**
 * issue #247 (WS1) — design ground truth for every import_pages row in
 * `runId`: ONE Playwright render session per source page produces the
 * source screenshot AND the computed-style token samples. Per-page
 * tokens land on `import_pages.sampled_design_tokens`; the run-level
 * aggregate lands on `import_runs.site_design_tokens` (which the run
 * report surfaces in preference to extractor tokens).
 *
 * Failure contract (CLAUDE.md §2 no-fallbacks): a page that ends up
 * WITHOUT a stored source screenshot always carries a
 * `screenshot_missing` note naming the cause — Playwright unavailable,
 * capture failed after a retry, storage missing, or upload failed —
 * so downstream verification treats it as UNVERIFIED. There is no code
 * path that skips capture wholesale without notes.
 *
 * issue #423 — the crawl itself now captures in the same session that
 * renders each page, so the crawl worker calls this with
 * `onlyPagesMissingScreenshot: true`: a second-chance + fallback pass
 * (fetch-only crawls, resumed runs, mid-crawl capture failures) instead
 * of a whole-run re-render. In that mode the run-level token aggregate is
 * NOT written here — the caller aggregates from row state afterwards
 * (`writeRunDesignTokenAggregate`), so the scoped pass cannot clobber the
 * crawl-time captures' contribution.
 *
 * Exported for the integration tests to drive directly without standing
 * up the polling worker.
 */
export async function captureImportGroundTruth(args: {
  readonly runId: string;
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /** Optional override for tests; defaults to Playwright via dynamic import. */
  readonly screenshotter?: Screenshotter | null;
  /** issue #423 — capture only pages whose screenshot_object_key is still
   *  NULL (and skip the run-level aggregate write; see above). */
  readonly onlyPagesMissingScreenshot?: boolean;
  /** issue #198 — when present, the source screenshot is uploaded and its
   *  key lands on the import_pages row. */
  readonly screenshotStorage?: {
    put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  };
}): Promise<{ captured: number; failed: number }> {
  const noteMissing = async (
    importPageId: string,
    category: "screenshot_missing" | "design_tokens_missing",
    note: string,
  ): Promise<void> => {
    // The note IS the loud marker — losing it silently would recreate
    // F9. It must not mask the original capture failure either, so a
    // failed write logs instead of throwing.
    try {
      const r = await execute(args.registry, args.adapter, SYSTEM_CTX, "imports.add_page_notes", {
        importPageId,
        notes: [{ category, note: note.slice(0, 1000), applied: false }],
      });
      if (!r.ok) {
        console.error(
          `[site-import] failed to record ${category} note on import_page ${importPageId}:`,
          r.error,
        );
      }
    } catch (e) {
      console.error(
        `[site-import] failed to record ${category} note on import_page ${importPageId}:`,
        e,
      );
    }
  };

  const get = await execute(args.registry, args.adapter, SYSTEM_CTX, "imports.get", {
    runId: args.runId,
  });
  if (!get.ok) {
    // issue #423 — this used to return {0,0} silently, which is exactly
    // the "run looks done with zero ground truth" failure class this
    // whole pass exists to prevent. A system op rejecting its own run id
    // is schema drift — fail the run loudly (no-fallbacks pre-1.0).
    throw new Error(`imports.get rejected in ground-truth pass: ${JSON.stringify(get.error)}`);
  }
  const all = (
    get.value as {
      pages: Array<{
        id: string;
        sourceUrl: string;
        proposedSlug: string;
        screenshotObjectKey: string | null;
      }>;
    }
  ).pages;
  // issue #423 — scoped mode: pages captured during the crawl are done;
  // only the still-keyless ones get the retry + loud-note treatment.
  const targets = args.onlyPagesMissingScreenshot
    ? all.filter((p) => p.screenshotObjectKey === null)
    : all;
  const v = { pages: targets };
  // Nothing to do → do not launch a browser for it.
  if (v.pages.length === 0) return { captured: 0, failed: 0 };

  const screenshotter =
    args.screenshotter !== undefined
      ? args.screenshotter
      : await createPlaywrightScreenshotter({ allowedHosts: importerAllowedHosts() });
  if (!screenshotter) {
    // Pre-#247 this returned silently and the run looked "done" with
    // zero screenshots (F9). Every page now reads as UNVERIFIED.
    for (const p of v.pages) {
      await noteMissing(
        p.id,
        "screenshot_missing",
        "Source screenshot NOT captured: Playwright/chromium is unavailable in this runtime. " +
          "Install it (`bun node_modules/playwright/cli.js install chromium`) and re-run the import; " +
          "this page is UNVERIFIED until a source screenshot exists.",
      );
    }
    return { captured: 0, failed: v.pages.length };
  }

  // One transient hiccup (slow host, flaky network) must not cost the
  // ground truth — retry exactly once, then note and move on.
  const captureWithRetry = async (url: string): Promise<Screenshot> => {
    try {
      return await screenshotter.capture(url, { external: true, sampleStyles: true });
    } catch {
      return await screenshotter.capture(url, { external: true, sampleStyles: true });
    }
  };

  let captured = 0;
  let failed = 0;
  const pageTokens: PageDesignTokens[] = [];
  try {
    for (const p of v.pages) {
      // issue #191 — the source URL is third-party: guard it.
      let sourceShot: Screenshot;
      try {
        sourceShot = await captureWithRetry(p.sourceUrl);
      } catch (e) {
        failed += 1;
        await noteMissing(
          p.id,
          "screenshot_missing",
          `Source screenshot NOT captured after a retry (${(e as Error).message}). ` +
            "This page is UNVERIFIED — the AI has no visual ground truth for it.",
        );
        continue;
      }

      // Tokens travel with the capture write below; an empty sample set
      // from a rendered page is a loud anomaly, not a shrug.
      const tokens =
        sourceShot.styleSamples && sourceShot.styleSamples.length > 0
          ? deriveDesignTokens(sourceShot.styleSamples)
          : null;
      if (tokens) pageTokens.push(tokens);
      else {
        await noteMissing(
          p.id,
          "design_tokens_missing",
          "Rendered page returned zero computed-style samples — no design tokens for this page. " +
            "Theme decisions fall back to the run's other pages / extractor tokens.",
        );
      }

      // issue #198 — persist the pixels, not just the verdict. The key is
      // deterministic per page so re-captures overwrite instead of
      // accumulating. issue #247 — a capture that cannot be PERSISTED
      // is a missing screenshot: note it (the key stays NULL and the
      // page stays UNVERIFIED), but still write tokens.
      let sourceKey: string | undefined;
      if (args.screenshotStorage) {
        try {
          sourceKey = `import-screenshots/${args.runId}/${p.id}-source.png`;
          await args.screenshotStorage.put(sourceKey, sourceShot.bytes, "image/png");
        } catch (e) {
          sourceKey = undefined;
          await noteMissing(
            p.id,
            "screenshot_missing",
            `Source screenshot captured but the upload failed (${(e as Error).message}). ` +
              "This page is UNVERIFIED until a stored source screenshot exists.",
          );
        }
      } else {
        await noteMissing(
          p.id,
          "screenshot_missing",
          "Source screenshot captured but NO screenshot storage is configured on this install — " +
            "the pixels were dropped. Wire screenshotStorage (media storage) into the site-import worker; " +
            "this page is UNVERIFIED until a stored source screenshot exists.",
        );
      }

      await execute(args.registry, args.adapter, SYSTEM_CTX, "imports.update_page_capture", {
        importPageId: p.id,
        ...(sourceKey ? { screenshotObjectKey: sourceKey } : {}),
        ...(tokens ? { sampledDesignTokens: tokens } : {}),
      });
      captured += 1;
    }
  } finally {
    await screenshotter.dispose().catch(() => undefined);
  }

  // Run-level aggregate — what the theme proposal consumes. Written
  // even for partial captures: N sampled pages beat zero ground truth,
  // and pageCount tells the AI how much of the site it represents.
  // issue #423 — SKIPPED in scoped mode: this pass then saw only the
  // pages that were still keyless, and an aggregate over that subset
  // would clobber the crawl-time captures' contribution. The caller
  // aggregates from row state instead (writeRunDesignTokenAggregate).
  if (args.onlyPagesMissingScreenshot) return { captured, failed };
  if (pageTokens.length > 0) {
    const wrote = await execute(
      args.registry,
      args.adapter,
      SYSTEM_CTX,
      "imports.set_run_design_tokens",
      { runId: args.runId, siteDesignTokens: aggregateSiteDesignTokens(pageTokens) },
    );
    if (!wrote.ok) {
      // System-scoped op fed by our own aggregator — a rejection is a
      // real bug (schema drift), not an environment quirk. Fail the run
      // loudly (no-fallbacks pre-1.0) rather than composing a theme
      // from silently-dropped ground truth.
      throw new Error(`imports.set_run_design_tokens rejected: ${JSON.stringify(wrote.error)}`);
    }
  }

  return { captured, failed };
}
