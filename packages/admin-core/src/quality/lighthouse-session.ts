// SPDX-License-Identifier: MPL-2.0

/**
 * One Lighthouse session: the bundled Chromium with a DevTools port, the
 * host's CPU calibration, and single runs reduced where they ran. Shared by
 * the in-process audit child (`lighthouse-child.ts`, every run of an audit
 * on one host) and the parallel audit task (`audit-task.ts`, #875, one run
 * per container).
 *
 * The browser is the shared bundled Chromium (`launchBundledChromium`,
 * #428), launched with the DevTools port Lighthouse connects to on
 * 127.0.0.1. Before the first run the session measures the host's benchmark
 * index in that browser and calibrates Lighthouse's CPU slowdown to it
 * (cpu-calibration.ts), so every run emulates the same target device
 * instead of applying a fixed 4x to whatever CPU the host has.
 */

import { createServer } from "node:net";
import { launchBundledChromium } from "@caelo-cms/site-importer";
import {
  assertCpuSlowdownApplied,
  type CpuCalibration,
  calibrateCpuSlowdown,
  fastestBenchmarkIndex,
} from "./cpu-calibration.js";
import {
  type LhrLike,
  LighthouseRunError,
  type RunMeasurement,
  reduceRun,
} from "./lighthouse-extract.js";
import type { QualityCategory } from "./ratchet.js";

type LighthouseFn = (
  url: string,
  flags: Record<string, unknown>,
) => Promise<{ lhr: LhrLike } | undefined>;

/** Benchmark samples per session; each takes about one second. */
const BENCHMARK_SAMPLES = 3;

/** A started session, or why it could not start. `code` is the child
 *  protocol's fatal code (`browser-<reason>`, `host-too-slow`). */
export type SessionStart =
  | { readonly ok: true; readonly session: LighthouseSession }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** A running browser with its calibration. Close it when done. */
export interface LighthouseSession {
  readonly cpuCalibration: {
    readonly benchmarkIndex: number;
    readonly cpuSlowdownMultiplier: number;
  };
  /**
   * One Lighthouse run of `url`, reduced (`reduceRun`).
   *
   * @throws LighthouseRunError when the run produced no usable result.
   */
  run(url: string, categories: readonly QualityCategory[]): Promise<RunMeasurement>;
  close(): Promise<void>;
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

/**
 * Lighthouse's own benchmark (`pageFunctions.computeBenchmarkIndex`), run in
 * a blank page of the audit browser — the same measurement Lighthouse
 * reports as "CPU/Memory Power", taken before any page is audited.
 */
async function measureCpu(
  // biome-ignore lint/suspicious/noExplicitAny: opaque Playwright Browser handle (launchBundledChromium)
  browser: any,
): Promise<CpuCalibration> {
  const specifier = "lighthouse/core/lib/page-functions.js";
  const { pageFunctions } = (await import(/* @vite-ignore */ specifier)) as {
    pageFunctions: { computeBenchmarkIndex: () => number };
  };
  const page = await browser.newPage();
  try {
    const samples: number[] = [];
    for (let i = 0; i < BENCHMARK_SAMPLES; i += 1) {
      samples.push((await page.evaluate(pageFunctions.computeBenchmarkIndex)) as number);
    }
    return calibrateCpuSlowdown(fastestBenchmarkIndex(samples));
  } finally {
    await page.close();
  }
}

/** Launch the browser and calibrate the CPU slowdown to this host. */
export async function startLighthouseSession(): Promise<SessionStart> {
  const lighthouse = await loadLighthouse();
  const port = await freeLoopbackPort();
  const launched = await launchBundledChromium({ remoteDebuggingPort: port });
  if (!launched.ok) {
    return { ok: false, code: `browser-${launched.reason}`, message: launched.message };
  }
  let cpu: CpuCalibration;
  try {
    cpu = await measureCpu(launched.browser);
  } catch (e) {
    await launched.browser.close();
    throw e;
  }
  if (!cpu.ok) {
    await launched.browser.close();
    return { ok: false, code: "host-too-slow", message: cpu.message };
  }
  const cpuCalibration = {
    benchmarkIndex: cpu.benchmarkIndex,
    cpuSlowdownMultiplier: cpu.cpuSlowdownMultiplier,
  };
  return {
    ok: true,
    session: {
      cpuCalibration,
      async run(url, categories) {
        const result = await lighthouse(url, {
          port,
          output: "json",
          logLevel: "error",
          onlyCategories: [...categories],
          // Overrides only the CPU part of the mobile default throttling.
          throttling: { cpuSlowdownMultiplier: cpuCalibration.cpuSlowdownMultiplier },
        });
        if (!result)
          throw new LighthouseRunError("NO_RESULT", `Lighthouse returned no result for ${url}`);
        assertCpuSlowdownApplied(result.lhr, cpuCalibration.cpuSlowdownMultiplier);
        return reduceRun(result.lhr, categories, cpuCalibration);
      },
      close: () => launched.browser.close(),
    },
  };
}
