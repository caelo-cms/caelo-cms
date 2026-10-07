// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — end-to-end smoke of the quality-audit stack: write a tiny
 * staged build to a temp dir, serve it through the loopback origin the
 * worker uses on providers without a reachable staging URL, run the real
 * Lighthouse child against it through the bundled Chromium, and assert
 * that all four category scores and the planted finding come back.
 *
 *   bun packages/admin-core/scripts/lighthouse-smoke.ts
 *
 * CI runs it inside the built admin image (ci.yml, boot-smoke job), which
 * is the only place that proves Lighthouse + Chromium work on the
 * production runtime (Bun on linux/amd64, image-installed browser).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuditJob } from "../src/quality/lighthouse-runner.js";
import { localBuildSource, serveStagedBuild } from "../src/quality/staged-origin.js";

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Caelo audit smoke</title>
<meta name="description" content="Smoke page for the quality audit."></head>
<body><main><h1>Smoke</h1><img src="/pixel.svg" width="10" height="10"><p>Text.</p></main></body></html>`;

const PIXEL = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`;

const build = mkdtempSync(join(tmpdir(), "caelo-lh-smoke-"));
mkdirSync(build, { recursive: true });
writeFileSync(join(build, "index.html"), PAGE);
writeFileSync(join(build, "pixel.svg"), PIXEL);
writeFileSync(join(build, "robots.txt"), "User-agent: *\nAllow: /\n");
const origin = await serveStagedBuild(localBuildSource(build));

const started = Date.now();
const result = await runAuditJob({
  pages: [{ pageId: "00000000-0000-4000-8000-000000000553", url: `${origin.baseUrl}/` }],
  performanceRuns: 3,
});
await origin.close();
rmSync(build, { recursive: true, force: true });

if (!result.ok) {
  console.error(
    `[lighthouse-smoke] audit failed: ${result.failure.code}: ${result.failure.message}`,
  );
  process.exit(1);
}
if (result.pageErrors.length > 0 || result.pages.length !== 1) {
  console.error("[lighthouse-smoke] page did not audit", result.pageErrors);
  process.exit(1);
}
const page = result.pages[0];
if (!page) process.exit(1);
const findings = page.measurement.failingAudits.map((f) => f.id);
// The planted defect: the image has no alt text.
if (!findings.includes("image-alt")) {
  console.error("[lighthouse-smoke] expected the image-alt finding, got", findings);
  process.exit(1);
}
console.log(
  `[lighthouse-smoke] OK in ${Date.now() - started} ms: scores=${JSON.stringify(page.measurement.scores)} performanceRuns=${JSON.stringify(page.performanceRuns)} findings=${findings.join(",")}`,
);
