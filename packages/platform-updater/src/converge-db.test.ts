// SPDX-License-Identifier: MPL-2.0

/**
 * The converge job's database (converge-db.ts, #1373) against fake pools:
 * it opens where the install dials today, runs the database TLS step as a
 * step of the job, and moves to the DNS name after it — or, when the step
 * fails, to wherever the install dials then, so the job can still write
 * the step's error and the request's end.
 */

import { describe, expect, it } from "bun:test";
import type { ConvergeDatabaseTarget, ConvergeQueue } from "@caelo-cms/provisioning";
import { convergeDatabase, ipTargetTls } from "./converge-db.js";

const DNS = "abc123.p-label.europe-west1.sql-psa.goog";
const IP = "10.20.0.3";
const PIN = "a212b6cf51b3736b34a5d4a3194b200db6b3532a";
const ipTarget = (pinnedSha1: string[] | null = null): ConvergeDatabaseTarget => ({
  kind: "ip",
  host: IP,
  caPem: "ca",
  pinnedSha1,
});

function harness(opts: {
  targets: ConvergeDatabaseTarget[];
  step: () => Promise<string>;
  /** Every read after the first throws. */
  reReadFails?: boolean;
}) {
  const opened: { target: ConvergeDatabaseTarget; closed: boolean }[] = [];
  const events: { host: string; message: string }[] = [];
  const warnings: string[] = [];
  let resolved = 0;
  const run = convergeDatabase({
    resolveTarget: async () => {
      if (opts.reReadFails && resolved > 0) throw new Error("re-read failed");
      const t = opts.targets[Math.min(resolved, opts.targets.length - 1)];
      resolved += 1;
      if (!t) throw new Error("no target");
      return t;
    },
    runTlsStep: opts.step,
    open: (target) => {
      const entry = { target, closed: false };
      opened.push(entry);
      const queue: ConvergeQueue = {
        claimConverge: async () => null,
        handover: async () => true,
        event: async (_id, _phase, _level, message) => {
          if (entry.closed) throw new Error("closed pool");
          events.push({ host: target.host, message });
        },
        record: async () => {},
        finish: async () => true,
      };
      return {
        queue,
        close: async () => {
          entry.closed = true;
        },
      };
    },
    fetchToken: async () => ({ token: "t", expiresAt: 3_600_000 }),
    now: () => 0,
    warn: (m) => warnings.push(m),
  });
  return { run, opened, events, warnings };
}

describe("convergeDatabase", () => {
  it("on the DNS name there is no TLS step to run", async () => {
    const h = harness({
      targets: [{ kind: "dns", host: DNS }],
      step: async () => {
        throw new Error("must not run");
      },
    });
    const db = await h.run;
    expect(db.secureDatabase).toBeNull();
    await db.queue.event("r", "start", "info", "hello");
    expect(h.events).toEqual([{ host: DNS, message: "hello" }]);
  });

  it("writes on the IP before the step and on the DNS name after it", async () => {
    const h = harness({ targets: [ipTarget()], step: async () => DNS });
    const db = await h.run;
    await db.queue.event("r", "converge", "info", "before");
    const secured = await db.secureDatabase?.();
    expect(secured).toEqual({ ok: true, host: DNS });
    await db.queue.event("r", "converge", "success", "after");
    expect(h.events).toEqual([
      { host: IP, message: "before" },
      { host: DNS, message: "after" },
    ]);
    // The IP pool is closed, not left open next to the new one.
    expect(h.opened.map((o) => [o.target.kind, o.closed])).toEqual([
      ["ip", true],
      ["dns", false],
    ]);
    await db.close();
  });

  it("a failed step reports its error and reconnects to what the install dials then", async () => {
    // The step rotated the certificate before it stopped: the second read
    // pins the new one.
    const h = harness({
      targets: [ipTarget(), ipTarget([PIN])],
      step: async () => {
        throw new Error("database TLS could not be set up: no PRIVATE_SERVICES_ACCESS DNS name");
      },
    });
    const db = await h.run;
    await db.queue.event("r", "converge", "info", "before");
    const secured = await db.secureDatabase?.();
    expect(secured).toEqual({
      ok: false,
      error: "database TLS could not be set up: no PRIVATE_SERVICES_ACCESS DNS name",
    });
    await db.queue.event("r", "finish", "error", "the end");
    expect(h.events.map((e) => e.message)).toEqual(["before", "the end"]);
    expect(h.opened).toHaveLength(2);
    expect(h.opened[1]?.target).toEqual(ipTarget([PIN]));
    expect(h.opened[0]?.closed).toBe(true);
  });

  it("a failed re-read after a failed step is a warning; the job still reports the step", async () => {
    const h = harness({
      targets: [ipTarget()],
      reReadFails: true,
      step: async () => {
        throw new Error("boom");
      },
    });
    const db = await h.run;
    expect(await db.secureDatabase?.()).toEqual({ ok: false, error: "boom" });
    expect(h.warnings[0]).toContain("could not be read again: re-read failed");
    await db.queue.event("r", "finish", "error", "the end");
    expect(h.events.map((e) => e.message)).toEqual(["the end"]);
  });

  it("refuses to start when the first target cannot be read", async () => {
    const h = harness({ targets: [], step: async () => DNS });
    await expect(h.run).rejects.toThrow("no target");
  });
});

describe("ipTargetTls", () => {
  const cert = (fingerprint: string) => ({ fingerprint });

  it("hands the instance's CA to the connection and accepts only a pinned certificate", () => {
    const tls = ipTargetTls({ kind: "ip", host: IP, caPem: "ca-pem", pinnedSha1: [PIN] });
    expect(tls.ca).toBe("ca-pem");
    const colons = PIN.toUpperCase().replace(/(..)(?!$)/g, "$1:");
    expect(tls.checkServerIdentity(IP, cert(colons))).toBeUndefined();
    expect(tls.checkServerIdentity(IP, cert("00:11"))).toBeInstanceOf(Error);
  });

  it("without a pin the chain to the instance's own CA decides", () => {
    const tls = ipTargetTls({ kind: "ip", host: IP, caPem: "ca-pem", pinnedSha1: null });
    expect(tls.checkServerIdentity(IP, cert("00:11"))).toBeUndefined();
  });
});
