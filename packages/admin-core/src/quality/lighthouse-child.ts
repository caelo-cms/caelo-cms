// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the Lighthouse audit child process. Spawned by
 * `lighthouse-runner.ts` with the same Bun runtime the admin runs on:
 *
 *   bun packages/admin-core/src/quality/lighthouse-child.ts < job.json
 *
 * Why a child process and not in-process (spike result, recorded on the
 * PR): Lighthouse 13 runs fine under Bun, but trace processing is
 * synchronous CPU work that stalled the admin's event loop for ~270 ms on a
 * trivial page (worse on real ones), it adds a few hundred MB of heap, and
 * a crash would take the editor's server down with it. In a child the
 * admin stays responsive, the memory is returned when the audit ends, and
 * the parent can kill a hung audit and report it.
 *
 * The browser is the shared bundled Chromium (`launchBundledChromium`,
 * #428), launched here with the DevTools port Lighthouse connects to on
 * 127.0.0.1. One browser per audit, closed before the process exits.
 */

import { createServer } from "node:net";
import { launchBundledChromium } from "@caelo-cms/site-importer";
import { type LhrLike, LighthouseRunError, measurementFromRuns } from "./lighthouse-extract.js";
import { type AuditJob, auditJobSchema, type ChildEvent } from "./lighthouse-protocol.js";
import { QUALITY_CATEGORIES } from "./ratchet.js";

type LighthouseFn = (
  url: string,
  flags: Record<string, unknown>,
) => Promise<{ lhr: LhrLike } | undefined>;

function emit(event: ChildEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** A free loopback port for the DevTools endpoint. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function loadLighthouse(): Promise<LighthouseFn> {
  // Variable specifier: keeps bundlers and the type-checker from following
  // Lighthouse's large module graph; it only ever loads in this process.
  const specifier = "lighthouse";
  const mod = (await import(/* @vite-ignore */ specifier)) as { default: LighthouseFn };
  return mod.default;
}

async function readJob(): Promise<AuditJob> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return auditJobSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

async function runLighthouse(
  lighthouse: LighthouseFn,
  url: string,
  port: number,
  categories: readonly string[],
): Promise<LhrLike> {
  const result = await lighthouse(url, {
    port,
    output: "json",
    logLevel: "error",
    onlyCategories: [...categories],
  });
  if (!result)
    throw new LighthouseRunError("NO_RESULT", `Lighthouse returned no result for ${url}`);
  return result.lhr;
}

async function main(): Promise<void> {
  const job = await readJob();
  const lighthouse = await loadLighthouse();
  const port = await freeLoopbackPort();
  const launched = await launchBundledChromium({ remoteDebuggingPort: port });
  if (!launched.ok) {
    emit({ kind: "fatal", code: `browser-${launched.reason}`, message: launched.message });
    return;
  }
  try {
    for (const page of job.pages) {
      try {
        const full = await runLighthouse(lighthouse, page.url, port, QUALITY_CATEGORIES);
        const extra: LhrLike[] = [];
        for (let i = 1; i < job.performanceRuns; i += 1) {
          extra.push(await runLighthouse(lighthouse, page.url, port, ["performance"]));
        }
        const { measurement, performanceRuns } = measurementFromRuns(full, extra);
        emit({
          kind: "page",
          pageId: page.pageId,
          url: page.url,
          ...(full.finalDisplayedUrl ? { finalUrl: full.finalDisplayedUrl } : {}),
          measurement: {
            scores: measurement.scores,
            failingAudits: measurement.failingAudits.map(({ categories, elements, ...f }) => ({
              ...f,
              categories: [...categories],
              ...(elements ? { elements: [...elements] } : {}),
            })),
          },
          performanceRuns,
        });
      } catch (e) {
        emit({
          kind: "page-error",
          pageId: page.pageId,
          url: page.url,
          code: e instanceof LighthouseRunError ? e.code : "LIGHTHOUSE_FAILED",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    await launched.browser.close();
  }
  emit({ kind: "done" });
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    emit({
      kind: "fatal",
      code: "child-crashed",
      message: e instanceof Error ? e.message : String(e),
    });
    process.exit(1);
  },
);
