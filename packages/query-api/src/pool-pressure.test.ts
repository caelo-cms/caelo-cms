// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { PoolDemand } from "./pool-pressure.js";

describe("#1375 — PoolDemand", () => {
  it("counts waiters and holders, oldest waiter first, longest holder first", () => {
    let now = 1_000;
    const demand = new PoolDemand("admin", 3, () => now);
    expect(demand.snapshot()).toEqual({
      pool: "admin",
      max: 3,
      inUse: 0,
      waiting: 0,
      oldestWaitMs: 0,
      holders: [],
    });
    const endHoldA = demand.beginHold("content_instances.get");
    now = 1_500;
    const endHoldB = demand.beginHold("pages.list");
    const endWait1 = demand.beginWait();
    now = 2_000;
    const endWait2 = demand.beginWait();
    now = 2_400;
    expect(demand.snapshot()).toEqual({
      pool: "admin",
      max: 3,
      inUse: 2,
      waiting: 2,
      oldestWaitMs: 900,
      holders: [
        { holder: "content_instances.get", heldMs: 1_400 },
        { holder: "pages.list", heldMs: 900 },
      ],
    });
    // The oldest waiter is served: the next one is now the oldest.
    endWait1();
    expect(demand.snapshot().oldestWaitMs).toBe(400);
    endWait2();
    endHoldA();
    endHoldB();
    expect(demand.snapshot()).toMatchObject({ inUse: 0, waiting: 0, oldestWaitMs: 0 });
  });

  it("ending a wait or a hold twice changes nothing", () => {
    const demand = new PoolDemand("public", 2);
    const endWait = demand.beginWait();
    const other = demand.beginWait();
    endWait();
    endWait();
    expect(demand.snapshot().waiting).toBe(1);
    other();
    expect(demand.snapshot().waiting).toBe(0);
  });
});
