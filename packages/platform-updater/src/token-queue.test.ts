// SPDX-License-Identifier: MPL-2.0

/**
 * The token-refreshing queue (token-queue.ts, #815) against fake pools: the
 * job can still record its end after a step that outlived its first
 * access token, and a retired pool is closed only once its calls settled.
 */

import { describe, expect, it } from "bun:test";
import type { UpdateQueue } from "@caelo-cms/provisioning";
import {
  type AccessToken,
  type OpenedQueue,
  parseMetadataToken,
  TOKEN_REFRESH_MARGIN_MS,
  tokenRefreshingQueue,
} from "./token-queue.js";

const MIN = 60_000;
const END = { status: "succeeded" as const, reason: null, codes: [], pauseAutoUpdates: false };

/** Pools that refuse any call made after their token expired (a new login would fail). */
function harness(tokens: AccessToken[]) {
  let clock = 0;
  const opened: { token: string; closed: boolean }[] = [];
  const issued: AccessToken[] = [];
  let next = 0;
  const pool = (token: string, expiresAt: number): OpenedQueue => {
    const entry = { token, closed: false };
    opened.push(entry);
    const use = async () => {
      if (entry.closed) throw new Error(`pool ${token} is closed`);
      if (clock >= expiresAt) throw new Error(`password authentication failed (${token} expired)`);
    };
    const queue: UpdateQueue = {
      claim: async () => {
        await use();
        return null;
      },
      event: async () => use(),
      record: async () => use(),
      finish: async () => {
        await use();
        return true;
      },
    };
    return {
      queue,
      close: async () => {
        entry.closed = true;
      },
    };
  };
  const q = tokenRefreshingQueue({
    fetchToken: async () => {
      const t = tokens[Math.min(next, tokens.length - 1)] as AccessToken;
      next += 1;
      issued.push(t);
      return t;
    },
    open: (token) => {
      const t = tokens.find((x) => x.token === token) as AccessToken;
      return pool(token, t.expiresAt);
    },
    now: () => clock,
  });
  return {
    q,
    opened,
    issued,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("tokenRefreshingQueue", () => {
  it("regression #815: records the end after a migration that outlived the first token", async () => {
    const h = harness([
      { token: "t1", expiresAt: 60 * MIN },
      { token: "t2", expiresAt: 120 * MIN },
    ]);
    await h.q.queue.claim("x1");
    h.advance(70 * MIN); // a long migration step
    expect(await h.q.queue.finish("req-1", END)).toBe(true);
    expect(h.opened.map((p) => p.token)).toEqual(["t1", "t2"]);
    // The retired pool was closed, the live one is closed by close().
    expect(h.opened[0]?.closed).toBe(true);
    await h.q.close();
    expect(h.opened[1]?.closed).toBe(true);
  });

  it("refreshes within the margin, before the token actually expires", async () => {
    const h = harness([
      { token: "t1", expiresAt: 60 * MIN },
      { token: "t2", expiresAt: 120 * MIN },
    ]);
    await h.q.queue.event("r", "start", "info", "a");
    h.advance(60 * MIN - TOKEN_REFRESH_MARGIN_MS); // exactly at the margin
    await h.q.queue.event("r", "start", "info", "b");
    expect(h.opened.map((p) => p.token)).toEqual(["t1", "t2"]);
  });

  it("keeps one pool while the token is fresh", async () => {
    const h = harness([{ token: "t1", expiresAt: 60 * MIN }]);
    for (let i = 0; i < 5; i++) {
      await h.q.queue.record("r", {});
      h.advance(5 * MIN);
    }
    expect(h.opened).toHaveLength(1);
    expect(h.issued).toHaveLength(1);
  });

  it("keeps the pool when the metadata server still hands out the same token", async () => {
    const h = harness([{ token: "t1", expiresAt: 60 * MIN }]);
    await h.q.queue.record("r", {});
    h.advance(57 * MIN);
    await h.q.queue.record("r", {});
    expect(h.opened).toHaveLength(1);
    expect(h.issued).toHaveLength(2);
  });

  it("concurrent calls share one refresh", async () => {
    const h = harness([
      { token: "t1", expiresAt: 10 * MIN },
      { token: "t2", expiresAt: 70 * MIN },
    ]);
    await h.q.queue.record("r", {});
    h.advance(6 * MIN);
    await Promise.all([
      h.q.queue.event("r", "roll", "info", "a"),
      h.q.queue.event("r", "roll", "info", "b"),
      h.q.queue.record("r", {}),
    ]);
    expect(h.opened.map((p) => p.token)).toEqual(["t1", "t2"]);
  });

  it("closes a retired pool only after its in-flight call settled", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let inside: () => void = () => {};
    const started = new Promise<void>((r) => {
      inside = r;
    });
    const closed: string[] = [];
    let clock = 0;
    const tokens = [
      { token: "t1", expiresAt: 10 * MIN },
      { token: "t2", expiresAt: 70 * MIN },
    ];
    let next = 0;
    const q = tokenRefreshingQueue({
      fetchToken: async () => tokens[next++] as AccessToken,
      open: (token) => ({
        queue: {
          claim: async () => null,
          event: async () => {
            if (token !== "t1") return;
            inside();
            await gate;
          },
          record: async () => {},
          finish: async () => true,
        },
        close: async () => {
          closed.push(token);
        },
      }),
      now: () => clock,
    });
    const slow = q.queue.event("r", "migrations", "info", "slow");
    await started;
    clock = 8 * MIN;
    await q.queue.record("r", {});
    expect(closed).toEqual([]);
    release();
    await slow;
    expect(closed).toEqual(["t1"]);
  });
});

describe("parseMetadataToken", () => {
  it("reads the token and its lifetime", () => {
    expect(
      parseMetadataToken(JSON.stringify({ access_token: "ya29.x", expires_in: 3599 }), 1_000),
    ).toEqual({ token: "ya29.x", expiresAt: 1_000 + 3_599_000 });
  });

  it("refuses a response without a token or a lifetime", () => {
    expect(() => parseMetadataToken(JSON.stringify({ expires_in: 10 }), 0)).toThrow(
      /no access token/,
    );
    expect(() => parseMetadataToken(JSON.stringify({ access_token: "ya29.x" }), 0)).toThrow(
      /expires_in/,
    );
  });
});
