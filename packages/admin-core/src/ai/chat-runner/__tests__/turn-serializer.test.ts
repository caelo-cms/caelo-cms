// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { acquireChatTurn } from "../turn-serializer.js";

describe("acquireChatTurn", () => {
  it("lets a chat's next turn start only after the running one released", async () => {
    const order: string[] = [];
    const releaseA = await acquireChatTurn("chat-1");
    order.push("A start");
    const b = acquireChatTurn("chat-1").then((release) => {
      order.push("B start");
      return release;
    });
    await Bun.sleep(20);
    expect(order).toEqual(["A start"]);
    order.push("A end");
    releaseA();
    const releaseB = await b;
    expect(order).toEqual(["A start", "A end", "B start"]);
    releaseB();
  });

  it("keeps the queue order for three turns and does not block other chats", async () => {
    const order: string[] = [];
    const r1 = await acquireChatTurn("chat-2");
    const t2 = acquireChatTurn("chat-2").then((r) => {
      order.push("2");
      return r;
    });
    const t3 = acquireChatTurn("chat-2").then((r) => {
      order.push("3");
      return r;
    });
    const other = await acquireChatTurn("chat-3");
    order.push("other");
    other();
    r1();
    (await t2)();
    (await t3)();
    expect(order).toEqual(["other", "2", "3"]);
  });

  it("is idempotent on release", async () => {
    const r = await acquireChatTurn("chat-4");
    r();
    r();
    const again = await acquireChatTurn("chat-4");
    again();
  });
});
