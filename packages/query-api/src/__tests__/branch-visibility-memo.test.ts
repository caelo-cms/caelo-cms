// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1392 — branch-visibility verdicts are reused within one request
 * scope and only there: concurrent ops of the request share one ask,
 * another scope, another caller or an aged verdict asks the database
 * again, and outside a scope nothing is remembered.
 */

import { describe, expect, it, setSystemTime } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
import {
  firstInvisibleBranch,
  rememberedFirstInvisible,
  withBranchVisibilityScope,
} from "../branch-access.js";
import type { TransactionRunner } from "../operation.js";

const BRANCH = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ctx = (over: Partial<ExecutionContext> = {}): ExecutionContext => ({
  actorId: "00000000-0000-0000-0000-00000000aaaa",
  actorKind: "ai",
  requestId: "chat-session-1",
  chatTaskId: "33333333-3333-4333-8333-333333333333",
  ...over,
});

/** A transaction that answers `caelo_branch_visible` from `visible` and counts the asks. */
function fakeTx(visible: Record<string, boolean>) {
  let asked = 0;
  const tx = {
    execute: async (q: unknown) => {
      asked++;
      await Bun.sleep(5);
      const text = JSON.stringify(q);
      const branch = Object.keys(visible).find((b) => text.includes(b));
      return [{ visible: branch ? visible[branch] : false }];
    },
  } as unknown as TransactionRunner;
  return { tx, asked: () => asked };
}

describe("#1392 — the request-scoped branch-visibility memory", () => {
  it("asks once per branch within a scope, and remembers a denial too", async () => {
    const db = fakeTx({ [BRANCH]: true, [OTHER]: false });
    await withBranchVisibilityScope(async () => {
      expect(await firstInvisibleBranch(db.tx, [BRANCH], ctx())).toBeNull();
      expect(await firstInvisibleBranch(db.tx, [BRANCH], ctx())).toBeNull();
      expect(await rememberedFirstInvisible(ctx(), [BRANCH])).toBeNull();
      expect(await firstInvisibleBranch(db.tx, [OTHER], ctx())).toBe(OTHER);
      expect(await rememberedFirstInvisible(ctx(), [BRANCH, OTHER])).toBe(OTHER);
    });
    expect(db.asked()).toBe(2);
  });

  it("shares one ask between concurrent ops of the request", async () => {
    const db = fakeTx({ [BRANCH]: true });
    await withBranchVisibilityScope(() =>
      Promise.all([1, 2, 3, 4, 5, 6].map(() => firstInvisibleBranch(db.tx, [BRANCH], ctx()))),
    );
    expect(db.asked()).toBe(1);
  });

  it("never carries a verdict to another request, even with the same requestId", async () => {
    const db = fakeTx({ [BRANCH]: true });
    await withBranchVisibilityScope(() => firstInvisibleBranch(db.tx, [BRANCH], ctx()));
    await withBranchVisibilityScope(async () => {
      expect(await rememberedFirstInvisible(ctx(), [BRANCH])).toBeUndefined();
      await firstInvisibleBranch(db.tx, [BRANCH], ctx());
    });
    expect(db.asked()).toBe(2);
  });

  it("does not share a verdict between callers or chats of one request", async () => {
    const db = fakeTx({ [BRANCH]: true });
    await withBranchVisibilityScope(async () => {
      await firstInvisibleBranch(db.tx, [BRANCH], ctx());
      for (const other of [
        ctx({ actorId: "00000000-0000-0000-0000-00000000bbbb" }),
        ctx({ actorKind: "human" }),
        ctx({ chatTaskId: undefined }),
      ]) {
        expect(await rememberedFirstInvisible(other, [BRANCH])).toBeUndefined();
      }
    });
  });

  it("remembers nothing outside a scope", async () => {
    const db = fakeTx({ [BRANCH]: true });
    await firstInvisibleBranch(db.tx, [BRANCH], ctx());
    await firstInvisibleBranch(db.tx, [BRANCH], ctx());
    expect(await rememberedFirstInvisible(ctx(), [BRANCH])).toBeUndefined();
    expect(db.asked()).toBe(2);
  });

  it("asks again within a long request after 30 s", async () => {
    const db = fakeTx({ [BRANCH]: true });
    try {
      await withBranchVisibilityScope(async () => {
        setSystemTime(new Date("2026-11-03T10:00:00Z"));
        await firstInvisibleBranch(db.tx, [BRANCH], ctx());
        setSystemTime(new Date("2026-11-03T10:00:31Z"));
        expect(await rememberedFirstInvisible(ctx(), [BRANCH])).toBeUndefined();
        await firstInvisibleBranch(db.tx, [BRANCH], ctx());
      });
    } finally {
      setSystemTime();
    }
    expect(db.asked()).toBe(2);
  });

  it("refuses a malformed id without asking", async () => {
    const db = fakeTx({});
    await withBranchVisibilityScope(async () => {
      expect(await rememberedFirstInvisible(ctx(), ["not-a-uuid"])).toBe("not-a-uuid");
      expect(await firstInvisibleBranch(db.tx, ["not-a-uuid"], ctx())).toBe("not-a-uuid");
    });
    expect(db.asked()).toBe(0);
  });
});
