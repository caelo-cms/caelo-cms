// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type ChatTurnHold,
  type ChatTurnLeaseStore,
  ChatTurnSerializer,
  type ChatTurnSerializerOptions,
} from "../turn-serializer.js";

/**
 * The `chat_turn_leases` table in memory: one lease per chat, expiry on a
 * shared clock. Two serializers over ONE store behave like two admin
 * instances over one database (the integration test proves the real ops).
 */
class MemoryLeaseStore implements ChatTurnLeaseStore {
  readonly leases = new Map<string, { holderId: string; acquiredAt: number; expiresAt: number }>();
  renewals = 0;
  async acquire(args: { chatSessionId: string; holderId: string; ttlMs: number }) {
    const now = Date.now();
    const cur = this.leases.get(args.chatSessionId);
    if (cur && cur.expiresAt > now && cur.holderId !== args.holderId) {
      return {
        ok: true as const,
        acquired: false as const,
        heldSince: new Date(cur.acquiredAt).toISOString(),
      };
    }
    const tookOver = cur && cur.holderId !== args.holderId ? cur.holderId : null;
    this.leases.set(args.chatSessionId, {
      holderId: args.holderId,
      acquiredAt: now,
      expiresAt: now + args.ttlMs,
    });
    return { ok: true as const, acquired: true as const, tookOverExpiredHolderId: tookOver };
  }
  async renew(args: { chatSessionId: string; holderId: string; ttlMs: number }) {
    this.renewals += 1;
    const cur = this.leases.get(args.chatSessionId);
    if (!cur || cur.holderId !== args.holderId) return { ok: true as const, held: false };
    cur.expiresAt = Date.now() + args.ttlMs;
    return { ok: true as const, held: true };
  }
  async release(args: { chatSessionId: string; holderId: string }) {
    const cur = this.leases.get(args.chatSessionId);
    if (cur?.holderId === args.holderId) this.leases.delete(args.chatSessionId);
    return { ok: true as const };
  }
}

const FAST: ChatTurnSerializerOptions = {
  leaseTtlMs: 200,
  heartbeatMs: 40,
  waitTimeoutMs: 5_000,
  pollMinMs: 5,
  pollMaxMs: 20,
};

async function hold(
  serializer: ChatTurnSerializer,
  store: ChatTurnLeaseStore,
  chatSessionId: string,
  abortSignal?: AbortSignal,
): Promise<ChatTurnHold> {
  const r = await serializer.acquire({
    chatSessionId,
    store,
    ...(abortSignal ? { abortSignal } : {}),
  });
  if (r.kind !== "held") throw new Error(`expected held, got ${JSON.stringify(r)}`);
  return r.hold;
}

describe("ChatTurnSerializer — one instance", () => {
  it("lets a chat's next turn start only after the running one released", async () => {
    const store = new MemoryLeaseStore();
    const s = new ChatTurnSerializer(FAST);
    const order: string[] = [];
    const a = await hold(s, store, "chat-1");
    order.push("A start");
    const b = hold(s, store, "chat-1").then((h) => {
      order.push("B start");
      return h;
    });
    await Bun.sleep(30);
    expect(order).toEqual(["A start"]);
    order.push("A end");
    await a.release();
    const hb = await b;
    expect(order).toEqual(["A start", "A end", "B start"]);
    await hb.release();
    expect(store.leases.size).toBe(0);
  });

  it("keeps the queue order for three turns and does not block other chats", async () => {
    const store = new MemoryLeaseStore();
    const s = new ChatTurnSerializer(FAST);
    const order: string[] = [];
    const h1 = await hold(s, store, "chat-2");
    const t2 = hold(s, store, "chat-2").then((h) => {
      order.push("2");
      return h;
    });
    const t3 = hold(s, store, "chat-2").then((h) => {
      order.push("3");
      return h;
    });
    const other = await hold(s, store, "chat-3");
    order.push("other");
    await other.release();
    await h1.release();
    await (await t2).release();
    await (await t3).release();
    expect(order).toEqual(["other", "2", "3"]);
  });

  it("is idempotent on release", async () => {
    const store = new MemoryLeaseStore();
    const s = new ChatTurnSerializer(FAST);
    const h = await hold(s, store, "chat-4");
    await h.release();
    await h.release();
    const again = await hold(s, store, "chat-4");
    await again.release();
  });

  it("a turn aborted while it waits holds nothing and does not block the next one", async () => {
    const store = new MemoryLeaseStore();
    const s = new ChatTurnSerializer(FAST);
    const a = await hold(s, store, "chat-5");
    const ctl = new AbortController();
    const waiting = s.acquire({ chatSessionId: "chat-5", store, abortSignal: ctl.signal });
    const third = hold(s, store, "chat-5");
    ctl.abort();
    expect((await waiting).kind).toBe("aborted");
    await a.release();
    const h3 = await third;
    await h3.release();
    expect(store.leases.size).toBe(0);
  });
});

describe("ChatTurnSerializer — two instances sharing one lease store (issue #628)", () => {
  it("a turn on instance B waits for the running turn on instance A", async () => {
    const store = new MemoryLeaseStore();
    const instanceA = new ChatTurnSerializer(FAST);
    const instanceB = new ChatTurnSerializer(FAST);
    const order: string[] = [];
    const a = await hold(instanceA, store, "chat-x");
    order.push("A start");
    const b = hold(instanceB, store, "chat-x").then((h) => {
      order.push("B start");
      return h;
    });
    // Longer than the TTL: A's heartbeat keeps the lease alive meanwhile.
    await Bun.sleep(500);
    expect(order).toEqual(["A start"]);
    expect(store.renewals).toBeGreaterThan(0);
    order.push("A end");
    await a.release();
    await (await b).release();
    expect(order).toEqual(["A start", "A end", "B start"]);
  });

  it("a crashed holder's lease lapses and the next turn takes it over", async () => {
    const store = new MemoryLeaseStore();
    // The "crashed" instance: it claimed the lease and then never renewed or
    // released it (simulated by writing the lease row directly).
    store.leases.set("chat-y", {
      holderId: "dead-instance",
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 150,
    });
    const startedAt = Date.now();
    const h = await hold(new ChatTurnSerializer(FAST), store, "chat-y");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
    expect(store.leases.get("chat-y")?.holderId).not.toBe("dead-instance");
    await h.release();
  });

  it("gives up after the wait bound with an actionable message", async () => {
    const store = new MemoryLeaseStore();
    const a = await hold(new ChatTurnSerializer(FAST), store, "chat-z");
    const r = await new ChatTurnSerializer({ ...FAST, waitTimeoutMs: 100 }).acquire({
      chatSessionId: "chat-z",
      store,
    });
    expect(r.kind).toBe("busy");
    if (r.kind === "busy") {
      expect(r.message).toContain("still answering an earlier message");
      expect(r.message).toContain("NOT sent");
    }
    await a.release();
  });

  it("signals `lost` when the lease was taken over under a stalled holder", async () => {
    const store = new MemoryLeaseStore();
    const a = await hold(new ChatTurnSerializer(FAST), store, "chat-w");
    // Another instance took the chat over after A's lease lapsed.
    store.leases.set("chat-w", {
      holderId: "other-instance",
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 10_000,
    });
    await Bun.sleep(120);
    expect(a.lost.aborted).toBe(true);
    await a.release();
    // A's release never deletes the lease it no longer holds.
    expect(store.leases.get("chat-w")?.holderId).toBe("other-instance");
  });

  it("reports a store failure instead of running unserialized", async () => {
    const store = new MemoryLeaseStore();
    store.acquire = async () => ({ ok: false as const, message: "db down" });
    const r = await new ChatTurnSerializer(FAST).acquire({ chatSessionId: "chat-v", store });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.message).toContain("db down");
  });
});

describe("ChatTurnSerializer — PR #631 review findings", () => {
  // Renew-failure cases: a TTL long enough that timer jitter under a loaded
  // test run cannot eat the two-beat safety margin.
  const RENEW: ChatTurnSerializerOptions = { ...FAST, leaseTtlMs: 1_000, heartbeatMs: 100 };

  it("a store that THROWS on acquire frees the local queue (no hang for later turns)", async () => {
    const store = new MemoryLeaseStore();
    const realAcquire = store.acquire.bind(store);
    let throwOnce = true;
    store.acquire = async (args) => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("connection reset");
      }
      return realAcquire(args);
    };
    const s = new ChatTurnSerializer(FAST);
    const r = await s.acquire({ chatSessionId: "chat-throw", store });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.message).toContain("Nothing was sent");
    const next = await Promise.race([
      hold(s, store, "chat-throw"),
      Bun.sleep(1_000).then(() => null),
    ]);
    expect(next).not.toBeNull();
    await next?.release();
  });

  it("stops the turn before its lease can lapse when renewals keep failing", async () => {
    const store = new MemoryLeaseStore();
    store.renew = async () => ({ ok: false as const, message: "db unreachable" });
    const startedAt = Date.now();
    const h = await hold(new ChatTurnSerializer(RENEW), store, "chat-renew-fail");
    await Bun.sleep(500);
    expect(h.lost.aborted).toBe(false);
    while (!h.lost.aborted && Date.now() - startedAt < 2_000) await Bun.sleep(5);
    // Lost strictly before the lease would lapse for another instance.
    expect(h.lost.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(RENEW.leaseTtlMs as number);
    await h.release();
  });

  it("stops the turn in time when a renew hangs or throws", async () => {
    for (const renew of [
      () => new Promise<never>(() => undefined),
      async () => {
        throw new Error("socket closed");
      },
    ]) {
      const store = new MemoryLeaseStore();
      store.renew = renew;
      const startedAt = Date.now();
      const h = await hold(new ChatTurnSerializer(RENEW), store, "chat-renew-hang");
      while (!h.lost.aborted && Date.now() - startedAt < 2_000) await Bun.sleep(5);
      expect(h.lost.aborted).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(RENEW.leaseTtlMs as number);
      await h.release();
    }
  });

  it("an abort that fires while the claim is in flight releases the lease and holds nothing", async () => {
    const store = new MemoryLeaseStore();
    const realAcquire = store.acquire.bind(store);
    let openGate!: () => void;
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    let claimStarted!: () => void;
    const claimInFlight = new Promise<void>((r) => {
      claimStarted = r;
    });
    store.acquire = async (args) => {
      claimStarted();
      await gate;
      return realAcquire(args);
    };
    const s = new ChatTurnSerializer(FAST);
    const ctl = new AbortController();
    const pending = s.acquire({
      chatSessionId: "chat-abort-claim",
      store,
      abortSignal: ctl.signal,
    });
    await claimInFlight;
    ctl.abort();
    openGate();
    expect((await pending).kind).toBe("aborted");
    expect(store.leases.size).toBe(0);
    store.acquire = realAcquire;
    const next = await hold(s, store, "chat-abort-claim");
    await next.release();
  });

  it("bounds the local queue wait too, and a later turn still queues behind the running one", async () => {
    const store = new MemoryLeaseStore();
    const s = new ChatTurnSerializer({ ...FAST, waitTimeoutMs: 300 });
    const order: string[] = [];
    const a = await hold(s, store, "chat-local-bound");
    const startedAt = Date.now();
    const b = await s.acquire({ chatSessionId: "chat-local-bound", store });
    expect(b.kind).toBe("busy");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(290);
    // C arrives after B gave up: it must wait for A, not slip in front of it.
    const c = s.acquire({ chatSessionId: "chat-local-bound", store }).then((r) => {
      order.push(`C ${r.kind}`);
      return r;
    });
    await Bun.sleep(80);
    expect(order).toEqual([]);
    order.push("A end");
    await a.release();
    const rc = await c;
    expect(order).toEqual(["A end", "C held"]);
    if (rc.kind === "held") await rc.hold.release();
  });

  it("rejects non-integer env values instead of misreading them", () => {
    const saved = process.env.CAELO_CHAT_TURN_WAIT_MS;
    try {
      for (const bad of ["1e3", "1.5", "-5", "0", "15s", ""]) {
        process.env.CAELO_CHAT_TURN_WAIT_MS = bad;
        expect(() => new ChatTurnSerializer({ leaseTtlMs: 1_000 })).toThrow(
          "CAELO_CHAT_TURN_WAIT_MS",
        );
      }
      process.env.CAELO_CHAT_TURN_WAIT_MS = "1500";
      expect(() => new ChatTurnSerializer({ leaseTtlMs: 1_000 })).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.CAELO_CHAT_TURN_WAIT_MS;
      else process.env.CAELO_CHAT_TURN_WAIT_MS = saved;
    }
  });
});
