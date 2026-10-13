// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { eventReporter, phaseOfStep } from "./upgrader-reporter.js";

describe("phaseOfStep", () => {
  it.each([
    ["Checking the health check can reach admin + gateway...", "health-baseline"],
    ["Applying DB migrations (idempotent)...", "migrations"],
    ["Rolling admin → sha256:aaaa...", "roll"],
    ["Deep health check (database, migrations, version)...", "health"],
    ["Something else", null],
  ])("%s → %s", (label, phase) => {
    expect(phaseOfStep(label)).toBe(phase as never);
  });
});

describe("eventReporter", () => {
  it("writes events in order with their phase, and survives a failing write", async () => {
    const written: string[] = [];
    const logs: string[] = [];
    let n = 0;
    const r = eventReporter(
      async (phase, level, message) => {
        n += 1;
        if (n === 2) throw new Error("db down");
        await new Promise((res) => setTimeout(res, (6 - n) * 2));
        written.push(`${phase}/${level}: ${message}`);
      },
      (e) => logs.push(`${e.severity} ${e.message}`),
      "req-1",
    );
    r.phase("verify");
    r.info("checking");
    const s = r.step("Applying DB migrations (idempotent)...");
    s.done("Migrations applied");
    r.warn("Rolling back 1 service(s) to the revisions that served before...");
    r.error("x".repeat(5000));
    await r.flush();
    expect(written[0]).toBe("verify/info: checking");
    expect(written[1]).toBe("migrations/success: Migrations applied");
    expect(written[2]).toStartWith("rollback/warn: Rolling back");
    expect(written[3]?.length).toBeLessThanOrEqual("rollback/error: ".length + 4000);
    expect(logs.some((l) => l.includes("could not record a timeline event: db down"))).toBe(true);
  });
});
