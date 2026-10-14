// SPDX-License-Identifier: MPL-2.0

/**
 * The recorded Lighthouse 13.5 runs (lhr-performance-runs.json: a full run
 * and a Performance-only run of a small page whose LCP is its heading and
 * whose unsized hero image shifts the layout), and Performance metrics
 * extracted from them for tests that need a complete `PageMeasurement` —
 * so the shape is always what production produces.
 */

import { readFileSync } from "node:fs";
import type { LhrLike } from "../../lighthouse-extract.js";
import { type PerformanceMetrics, performanceMetricsFromRuns } from "../../lighthouse-metrics.js";

/** The recorded runs: [full run (all categories), Performance-only run]. */
export function recordedRuns(): [LhrLike, LhrLike] {
  const path = new URL("./lhr-performance-runs.json", import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as [LhrLike, LhrLike];
}

/** A fresh copy of the recorded page's metrics (the full run only):
 *  LCP 2.2 s, CLS 0.356 with one layout shift, LCP element h1. */
export function sampleMetrics(): PerformanceMetrics {
  return performanceMetricsFromRuns([recordedRuns()[0]]);
}
