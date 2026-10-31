// SPDX-License-Identifier: MPL-2.0

/**
 * #1211 — a step-wise operation runs without a transaction: `execute()`
 * checks scope and input like for any op, then calls its body with the
 * registry, the adapter and the caller's abort signal instead of asking
 * the adapter for a transaction.
 */

import { describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
import { err, ok } from "@caelo-cms/shared";
import { z } from "zod";
import {
  type DatabaseAdapter,
  defineOperation,
  defineStepwiseOperation,
  execute,
  OperationRegistry,
  type OperationSteps,
  observeCommittedOperations,
} from "../index.js";

const CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000001",
  actorKind: "human",
  requestId: "stepwise-test",
};

/** An adapter that must never open a transaction for the step-wise op itself. */
function countingAdapter(): { adapter: DatabaseAdapter; transactions: string[] } {
  const transactions: string[] = [];
  const adapter = {
    runOperation: async (op: { name: string; handler: (...a: unknown[]) => unknown }) => {
      transactions.push(op.name);
      return op.handler(CTX, {}, null);
    },
  } as unknown as DatabaseAdapter;
  return { adapter, transactions };
}

const stepOp = defineOperation({
  name: "test.step",
  readScope: "request",
  actorScope: ["human"],
  database: "cms_admin",
  input: z.object({}),
  output: z.object({ step: z.literal(true) }),
  handler: async () => ok({ step: true as const }),
});

describe("defineStepwiseOperation", () => {
  it("runs its body without a transaction; each step is an op of its own", async () => {
    let seen: OperationSteps | null = null;
    const op = defineStepwiseOperation({
      name: "test.stepwise",
      readScope: "request",
      actorScope: ["human"],
      database: "cms_admin",
      input: z.object({ n: z.number() }),
      output: z.object({ n: z.number() }),
      stepwise: async (ctx, input, steps) => {
        seen = steps;
        const first = await execute(steps.registry, steps.adapter, ctx, "test.step", {});
        const second = await execute(steps.registry, steps.adapter, ctx, "test.step", {});
        if (!first.ok || !second.ok) return err({ kind: "UnknownOperation", name: "test.step" });
        return ok({ n: input.n + 1 });
      },
    });
    const registry = new OperationRegistry();
    registry.register(op);
    registry.register(stepOp);
    const { adapter, transactions } = countingAdapter();
    const stop = new AbortController();
    const r = await execute(
      registry,
      adapter,
      CTX,
      "test.stepwise",
      { n: 1 },
      { signal: stop.signal },
    );
    expect(r).toEqual({ ok: true, value: { n: 2 } });
    // Two short transactions for the two steps, none around the body.
    expect(transactions).toEqual(["test.step", "test.step"]);
    expect(seen?.signal).toBe(stop.signal);
    expect(seen?.registry).toBe(registry);
  });

  it("tells the committed-operation listeners once its body answered ok (#1215)", async () => {
    let fail = false;
    const op = defineStepwiseOperation({
      name: "test.heard",
      readScope: "request",
      actorScope: ["human"],
      database: "cms_admin",
      input: z.object({}),
      output: z.object({}),
      stepwise: async () => (fail ? err({ kind: "UnknownOperation", name: "test.heard" }) : ok({})),
    });
    const registry = new OperationRegistry();
    registry.register(op);
    const heard: string[] = [];
    const stop = observeCommittedOperations((name) => {
      if (name === "test.heard") heard.push(name);
    });
    try {
      const { adapter } = countingAdapter();
      expect((await execute(registry, adapter, CTX, "test.heard", {})).ok).toBe(true);
      fail = true;
      expect((await execute(registry, adapter, CTX, "test.heard", {})).ok).toBe(false);
      expect(heard).toEqual(["test.heard"]);
    } finally {
      stop();
    }
  });

  it("checks actor scope and input before the body runs", async () => {
    let ran = false;
    const op = defineStepwiseOperation({
      name: "test.guarded",
      readScope: "request",
      actorScope: ["system"],
      database: "cms_admin",
      input: z.object({ n: z.number() }),
      output: z.object({}),
      stepwise: async () => {
        ran = true;
        return ok({});
      },
    });
    const registry = new OperationRegistry();
    registry.register(op);
    const { adapter } = countingAdapter();
    const scoped = await execute(registry, adapter, CTX, "test.guarded", { n: 1 });
    expect(scoped.ok).toBe(false);
    expect(scoped.ok ? null : scoped.error.kind).toBe("ActorScopeRejected");
    const invalid = await execute(
      registry,
      adapter,
      { ...CTX, actorKind: "system" },
      "test.guarded",
      { n: "x" },
    );
    expect(invalid.ok ? null : invalid.error.kind).toBe("ValidationFailed");
    expect(ran).toBe(false);
  });

  it("refuses a direct handler call: there is no transaction to give it", async () => {
    const op = defineStepwiseOperation({
      name: "test.direct",
      readScope: "request",
      actorScope: ["human"],
      database: "cms_admin",
      input: z.object({}),
      output: z.object({}),
      stepwise: async () => ok({}),
    });
    await expect(op.handler(CTX, {}, null as never)).rejects.toThrow(/holds no transaction/);
  });
});
