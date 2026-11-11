// SPDX-License-Identifier: MPL-2.0

/** #1595 — which failures count as database trouble. */

import { describe, expect, it } from "bun:test";
import { classifyDatabaseTrouble } from "./database-trouble.js";
import { PoolAcquireTimeoutError } from "./pool-guard.js";

/** A driver error the way Bun.SQL throws it, wrapped by drizzle. */
const pgError = (errno: string, message: string) => {
  const cause = Object.assign(new Error(message), { code: "ERR_POSTGRES_SERVER_ERROR", errno });
  return Object.assign(new Error("Failed query: SELECT 1"), { cause });
};

describe("classifyDatabaseTrouble", () => {
  it("knows the pool deadline", () => {
    expect(
      classifyDatabaseTrouble(new PoolAcquireTimeoutError("admin", "modules.list", 10_000)),
    ).toBe("pool_wait_timeout");
  });

  it("tells the 0392 timeouts from other cancels and lock failures", () => {
    expect(
      classifyDatabaseTrouble(pgError("57014", "canceling statement due to statement timeout")),
    ).toBe("statement_timeout");
    expect(
      classifyDatabaseTrouble(pgError("57014", "canceling statement due to user request")),
    ).toBeNull();
    expect(
      classifyDatabaseTrouble(pgError("55P03", "canceling statement due to lock timeout")),
    ).toBe("lock_timeout");
    expect(
      classifyDatabaseTrouble(pgError("55P03", 'could not obtain lock on row in relation "x"')),
    ).toBeNull();
  });

  it("knows a session ended for idling in a transaction, by code or by message", () => {
    expect(
      classifyDatabaseTrouble(
        pgError("25P03", "terminating connection due to idle-in-transaction timeout"),
      ),
    ).toBe("idle_in_transaction_timeout");
    expect(
      classifyDatabaseTrouble(
        new Error("Connection closed: terminating connection due to idle-in-transaction timeout"),
      ),
    ).toBe("idle_in_transaction_timeout");
  });

  it("leaves every other failure alone", () => {
    expect(classifyDatabaseTrouble(pgError("23505", "duplicate key value"))).toBeNull();
    expect(classifyDatabaseTrouble(new TypeError("x is undefined"))).toBeNull();
    expect(classifyDatabaseTrouble("plain string")).toBeNull();
  });
});
