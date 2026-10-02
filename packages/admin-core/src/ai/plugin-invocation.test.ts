// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { chatPluginInvocation } from "./plugin-invocation.js";

describe("chatPluginInvocation", () => {
  it("carries the AI actor, the chat's human, branch and task", () => {
    expect(
      chatPluginInvocation(
        { actorId: "ai", actorKind: "ai", requestId: "r", chatBranchId: "b", chatTaskId: "t" },
        "owner",
      ),
    ).toEqual({
      origin: "chat",
      actorId: "ai",
      operatorActorId: "owner",
      chatBranchId: "b",
      chatTaskId: "t",
    });
  });
});
