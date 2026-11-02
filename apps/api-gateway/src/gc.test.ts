// SPDX-License-Identifier: MPL-2.0

/**
 * The gateway sweeps its own state from the request handler, at most once
 * per interval: it gets CPU only while a request runs, so a timer could not
 * be relied on.
 */

import { describe, expect, it } from "bun:test";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { PgDialect } from "drizzle-orm/pg-core";
import { dueSweeper, gcBatchStatements, sweepGatewayState } from "./gc.js";

describe("sweepGatewayState (#1338: batched)", () => {
  /** An adapter whose every DELETE reports `deletedPerCall()` rows, one tx per call. */
  const fakeAdapter = (deletedPerCall: () => number) => {
    let txs = 0;
    const adapter = {
      withPublicTransaction: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
        txs++;
        return fn({ execute: async () => Array.from({ length: deletedPerCall() }) });
      },
    } as unknown as DatabaseAdapter;
    return { adapter, txs: () => txs };
  };

  it("deletes by primary key with a LIMIT, one statement per transaction", async () => {
    for (const { query } of gcBatchStatements(7)) {
      const { sql: text, params } = new PgDialect().sqlToQuery(query);
      expect(text).toStartWith("DELETE FROM gateway_");
      expect(text).toEndWith("RETURNING 1 AS d");
      if (!text.includes("gateway_ip_hash_keys")) {
        expect(text).toContain(" IN (");
        expect(params).toEqual([7]);
      }
    }
    const { adapter, txs } = fakeAdapter(() => 3);
    expect(await sweepGatewayState(adapter, { batchRows: 7 })).toEqual({ more: false });
    expect(txs()).toBe(gcBatchStatements(7).length);
  });

  it("stops each table after the batch cap and reports that more is left", async () => {
    const { adapter, txs } = fakeAdapter(() => 7);
    expect(await sweepGatewayState(adapter, { batchRows: 7, maxBatches: 2 })).toEqual({
      more: true,
    });
    expect(txs()).toBe(gcBatchStatements(7).length * 2);
  });
});

describe("dueSweeper", () => {
  it("runs on the first request, then not again until the interval passed", async () => {
    let clock = 0;
    let runs = 0;
    const sweepIfDue = dueSweeper(
      async () => {
        runs++;
        return { more: false };
      },
      1000,
      () => clock,
    );
    await sweepIfDue();
    expect(runs).toBe(1);
    clock = 999;
    await sweepIfDue();
    expect(runs).toBe(1);
    clock = 1000;
    await sweepIfDue();
    expect(runs).toBe(2);
  });

  it("lets concurrent requests through while one request's sweep runs", async () => {
    let release = (): void => undefined;
    let runs = 0;
    const sweepIfDue = dueSweeper(
      () =>
        new Promise<{ more: boolean }>((resolve) => {
          runs++;
          release = () => resolve({ more: false });
        }),
      1000,
      () => 0,
    );
    const first = sweepIfDue();
    await sweepIfDue();
    expect(runs).toBe(1);
    release();
    await first;
  });

  it("sweeps again on the next request while a batch was left full (#1338)", async () => {
    let runs = 0;
    const sweepIfDue = dueSweeper(
      async () => {
        runs++;
        return { more: runs < 3 };
      },
      1000,
      () => 0,
    );
    for (let i = 0; i < 5; i++) await sweepIfDue();
    expect(runs).toBe(3);
  });

  it("logs a failed sweep instead of failing the request, and retries after the interval", async () => {
    let clock = 0;
    let runs = 0;
    const sweepIfDue = dueSweeper(
      async () => {
        runs++;
        throw new Error("db down");
      },
      1000,
      () => clock,
    );
    await expect(sweepIfDue()).resolves.toBeUndefined();
    clock = 1000;
    await sweepIfDue();
    expect(runs).toBe(2);
  });
});
