// SPDX-License-Identifier: MPL-2.0

/**
 * #1720 — a worker's `cron` is parsed with croner in every review, so a
 * pattern the scheduler cannot register is refused before an Owner is
 * asked to approve, naming the worker. An approved artifact (`workerCron:
 * "record"`) is not refused for it: the scheduler records that worker.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { manifestFromDefinition, type PluginDefinition } from "@caelo-cms/plugin-sdk";
import { cronPatternProblem, validateManifest, validatePlugin } from "./index.js";

function workerManifest(cron: string) {
  return {
    slug: "cron-check",
    version: "0.0.1",
    tier: 1,
    schema: {},
    operations: ["sweep"],
    requestedCapabilities: ["background_workers"],
    workers: [{ name: "nightly_sweep", cron, operationName: "sweep" }],
  };
}

function scheduleFailures(cron: string, workerCron?: "refuse" | "record") {
  const { failures } = validateManifest(workerManifest(cron), workerCron ? { workerCron } : {});
  return failures.filter((f) => f.kind === "worker-schedule");
}

/** Patterns croner 11.0.0 accepted by guessing and 11.0.1 refuses (its release notes, checked against both). */
const NEWLY_REFUSED = [
  "0 0 * * SUN6", // a day name must stand alone (was 6)
  "0 0 1 JANFEB *", // was 12
  "0 0 * * */FRI", // was */5
  "0 0 15W5 * *", // digits only after a number (was 15W)
  "0 0 * * 5##2", // was 5#2
  "0 0 * * 5L#2", // was 5#2
  "0 0 5L * *", // L stands alone in day-of-month (the L was dropped)
  "3* * * * *", // was 3
];

describe("worker cron in review (#1720)", () => {
  it('refuses "61 * * * *", naming the worker and the pattern', () => {
    const failures = scheduleFailures("61 * * * *");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.hint).toContain('worker "nightly_sweep"');
    expect(failures[0]?.hint).toContain('cron "61 * * * *"');
    expect(failures[0]?.hint).toContain("Invalid value for minute: 61");
  });

  it.each(NEWLY_REFUSED)("refuses %p, which croner 11.0.1 no longer guesses at", (cron) => {
    expect(scheduleFailures(cron)).toHaveLength(1);
  });

  it.each(["0 * * * * *", "*/5 * * * *", "17 3 * * *", "0 0 * * MON-FRI", "0 0 L * *", "@hourly"])(
    "accepts %p",
    (cron) => {
      expect(scheduleFailures(cron)).toEqual([]);
    },
  );

  it("does not refuse an approved artifact's pattern (`record`): the scheduler records it", () => {
    expect(scheduleFailures("61 * * * *", "record")).toEqual([]);
    // Every other manifest rule still applies in `record` mode.
    const { failures } = validateManifest(
      { ...workerManifest("61 * * * *"), requestedCapabilities: [] },
      { workerCron: "record" },
    );
    expect(failures.map((f) => f.kind)).toEqual(["manifest-cap-missing"]);
  });

  it("refuses a runtime-installed artifact in its installation review (validatePlugin)", () => {
    const r = validatePlugin({
      manifest: { ...workerManifest("0 0 * * SUN6"), tier: 2 },
      source: "export default {};",
      allowExternalCapabilities: true,
    });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.kind)).toEqual(["worker-schedule"]);
    expect(r.failures[0]?.hint).toContain('worker "nightly_sweep"');
  });

  it("names every bad worker and none of the good ones", () => {
    const manifest = {
      ...workerManifest("0 * * * *"),
      workers: [
        { name: "good", cron: "0 * * * *", operationName: "sweep" },
        { name: "bad_minute", cron: "61 * * * *", operationName: "sweep" },
        { name: "bad_name", cron: "0 0 * * SUN6", operationName: "sweep" },
      ],
    };
    const hints = validateManifest(manifest)
      .failures.filter((f) => f.kind === "worker-schedule")
      .map((f) => f.hint);
    expect(hints).toHaveLength(2);
    expect(hints[0]).toContain('worker "bad_minute"');
    expect(hints[1]).toContain('worker "bad_name"');
  });
});

describe("every shipped plugin's worker cron parses (#1720)", () => {
  const pluginsDir = join(import.meta.dir, "../../plugins");
  const slugs = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it("finds the shipped plugins", () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  it("parses every worker cron of every shipped plugin, as the scheduler would", async () => {
    let workers = 0;
    for (const dir of slugs) {
      const mod = (await import(join(pluginsDir, dir, "src/index.ts"))) as {
        default: PluginDefinition;
      };
      const manifest = manifestFromDefinition(mod.default);
      for (const w of manifest.workers ?? []) {
        workers += 1;
        expect({ plugin: dir, worker: w.name, problem: cronPatternProblem(w.cron) }).toEqual({
          plugin: dir,
          worker: w.name,
          problem: null,
        });
      }
      expect(
        validateManifest(manifest).failures.filter((f) => f.kind === "worker-schedule"),
      ).toEqual([]);
    }
    // The shipped plugins declare workers today; a vacuous pass would hide a broken import.
    expect(workers).toBeGreaterThan(0);
  });
});
