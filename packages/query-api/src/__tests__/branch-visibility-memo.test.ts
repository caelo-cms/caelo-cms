// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1392 — branch-visibility verdicts are reused within one request
 * and only there: another request, another caller, an expired entry or a
 * context without a requestId asks the database again.
 */

import { describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
import { BranchVisibilityMemo, firstInvisibleBranch } from "../branch-access.js";
import type { TransactionRunner } from "../operation.js";

const BRANCH = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ctx = (over: Partial<ExecutionContext> = {}): ExecutionContext => ({
  actorId: "00000000-0000-0000-0000-00000000aaaa",
  actorKind: "ai",
  requestId: "req-1",
  chatTaskId: "33333333-3333-4333-8333-333333333333",
  ...over,
});

/** A transaction that answers `caelo_branch_visible` from `visible` and counts the asks. */
function fakeTx(visible: Record<string, boolean>) {
  let asked = 0;
  const tx = {
    execute: async (q: unknown) => {
      asked++;
      const text = JSON.stringify(q);
      const branch = Object.keys(visible).find((b) => text.includes(b));
      return [{ visible: branch ? visible[branch] : false }];
    },
  } as unknown as TransactionRunner;
  return { tx, asked: () => asked };
}

describe("#1392 — BranchVisibilityMemo", () => {
  it("asks once per request and branch, and remembers a denial too", async () => {
    const memo = new BranchVisibilityMemo();
    const db = fakeTx({ [BRANCH]: true, [OTHER]: false });
    const c = ctx();
    expect(await firstInvisibleBranch(db.tx, [BRANCH], { memo, ctx: c })).toBeNull();
    expect(await firstInvisibleBranch(db.tx, [BRANCH], { memo, ctx: c })).toBeNull();
    expect(db.asked()).toBe(1);
    expect(memo.firstInvisible(c, [BRANCH])).toBeNull();
    expect(await firstInvisibleBranch(db.tx, [OTHER], { memo, ctx: c })).toBe(OTHER);
    expect(memo.firstInvisible(c, [BRANCH, OTHER])).toBe(OTHER);
    expect(db.asked()).toBe(2);
  });

  it("does not carry a verdict to another request, caller or chat", () => {
    const memo = new BranchVisibilityMemo();
    memo.set(ctx(), BRANCH, true);
    expect(memo.get(ctx(), BRANCH)).toBe(true);
    expect(memo.get(ctx({ requestId: "req-2" }), BRANCH)).toBeUndefined();
    expect(
      memo.get(ctx({ actorId: "00000000-0000-0000-0000-00000000bbbb" }), BRANCH),
    ).toBeUndefined();
    expect(memo.get(ctx({ actorKind: "human" }), BRANCH)).toBeUndefined();
    expect(memo.get(ctx({ chatTaskId: undefined }), BRANCH)).toBeUndefined();
    expect(memo.firstInvisible(ctx({ requestId: "req-2" }), [BRANCH])).toBeUndefined();
  });

  it("never memoises a context without a requestId", () => {
    const memo = new BranchVisibilityMemo();
    memo.set(ctx({ requestId: "" }), BRANCH, true);
    expect(memo.get(ctx({ requestId: "" }), BRANCH)).toBeUndefined();
  });

  it("expires entries and stays bounded", () => {
    let t = 0;
    const memo = new BranchVisibilityMemo({ ttlMs: 1_000, max: 2, now: () => t });
    memo.set(ctx(), BRANCH, true);
    t = 1_001;
    expect(memo.get(ctx(), BRANCH)).toBeUndefined();
    memo.set(ctx({ requestId: "a" }), BRANCH, true);
    memo.set(ctx({ requestId: "b" }), BRANCH, true);
    memo.set(ctx({ requestId: "c" }), BRANCH, true);
    expect(memo.get(ctx({ requestId: "a" }), BRANCH)).toBeUndefined();
    expect(memo.get(ctx({ requestId: "c" }), BRANCH)).toBe(true);
  });

  it("refuses a malformed id without asking", async () => {
    const memo = new BranchVisibilityMemo();
    const db = fakeTx({});
    expect(memo.firstInvisible(ctx(), ["not-a-uuid"])).toBe("not-a-uuid");
    expect(await firstInvisibleBranch(db.tx, ["not-a-uuid"], { memo, ctx: ctx() })).toBe(
      "not-a-uuid",
    );
    expect(db.asked()).toBe(0);
  });
});
