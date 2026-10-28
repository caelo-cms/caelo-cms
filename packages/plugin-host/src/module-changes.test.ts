// SPDX-License-Identifier: MPL-2.0

/**
 * #1214 — the scope a module-change call runs in. The rows it writes are
 * derived from module content, so they must not take the writer's task
 * lease (two sibling tasks would collide on one derived row).
 */

import { describe, expect, it } from "bun:test";
import { moduleChangeInvocation } from "./module-changes.js";

const ACTOR = "00000000-0000-0000-0000-00000000a1a0";
const BRANCH = "11111111-1111-4111-8111-111111111111";

describe("moduleChangeInvocation", () => {
  it("acts on the writer's branch, without the writer's task", () => {
    const inv = moduleChangeInvocation({ actorId: ACTOR, chatBranchId: BRANCH });
    expect(inv).toEqual({ origin: "chat", actorId: ACTOR, chatBranchId: BRANCH });
    expect("chatTaskId" in inv).toBe(false);
  });

  it("acts on main for a main-line write", () => {
    expect(moduleChangeInvocation({ actorId: ACTOR, chatBranchId: null })).toEqual({
      origin: "system",
      actorId: ACTOR,
    });
  });
});
