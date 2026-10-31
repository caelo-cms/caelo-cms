// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from "bun:test";
import { CSRF_REFRESH_RETRY_MS, CSRF_TOKEN_PATH, csrfTokenIssuedAt, fetchFreshCsrfToken, freshestCsrfToken, keepCsrfTokenFresh, } from "./csrf-refresh.js";
/** A fake clock, timer and document; `fire()` runs the pending timer. */
function fakeEnv(start) {
    let now = start;
    let pending = null;
    const listeners = new Set();
    const doc = { visibilityState: "visible" };
    const env = {
        now: () => now,
        setTimeout: (fn, ms) => {
            pending = { fn, ms };
            return 1;
        },
        clearTimeout: () => {
            pending = null;
        },
        document: {
            get visibilityState() {
                return doc.visibilityState;
            },
            addEventListener: (_type, fn) => listeners.add(fn),
            removeEventListener: (_type, fn) => listeners.delete(fn),
        },
    };
    return {
        env,
        delay: () => pending?.ms ?? null,
        fire: () => pending?.fn(),
        advance: (ms) => {
            now += ms;
        },
        show: () => {
            doc.visibilityState = "visible";
            for (const fn of listeners)
                fn();
        },
        listeners,
    };
}
/** Let the refresh's awaited promise settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));
const HALF_HOUR = 30 * 60_000;
describe("keepCsrfTokenFresh", () => {
    it("refreshes once when the timer fires, then checks again after the retry delay", async () => {
        const f = fakeEnv(1_000);
        let calls = 0;
        keepCsrfTokenFresh(HALF_HOUR, async () => {
            calls++;
            return true;
        }, f.env);
        expect(f.delay()).toBe(HALF_HOUR);
        f.fire();
        f.show();
        await settle();
        expect(calls).toBe(1);
        expect(f.delay()).toBe(CSRF_REFRESH_RETRY_MS);
    });
    it("regression: a tab shown after its timer was frozen (laptop sleep) refreshes at once", async () => {
        const f = fakeEnv(0);
        let calls = 0;
        keepCsrfTokenFresh(HALF_HOUR, async () => {
            calls++;
            return true;
        }, f.env);
        f.show();
        expect(calls).toBe(0);
        f.advance(13 * 60 * 60_000);
        f.show();
        await settle();
        expect(calls).toBe(1);
    });
    it("regression: a failed refresh (offline after waking) is retried, not dropped", async () => {
        const f = fakeEnv(0);
        let calls = 0;
        keepCsrfTokenFresh(HALF_HOUR, async () => {
            calls++;
            if (calls === 1)
                throw new Error("Failed to fetch");
            return true;
        }, f.env);
        f.fire();
        await settle();
        expect(calls).toBe(1);
        expect(f.delay()).toBe(CSRF_REFRESH_RETRY_MS);
        f.fire();
        await settle();
        expect(calls).toBe(2);
    });
    it("a signed-out session stops refreshing", async () => {
        const f = fakeEnv(0);
        let calls = 0;
        keepCsrfTokenFresh(HALF_HOUR, async () => {
            calls++;
            return false;
        }, f.env);
        f.fire();
        await settle();
        f.advance(2 * HALF_HOUR);
        f.show();
        await settle();
        expect(calls).toBe(1);
    });
    it("the cleanup cancels the timer and the listener", () => {
        const f = fakeEnv(0);
        let calls = 0;
        const stop = keepCsrfTokenFresh(1_000, async () => {
            calls++;
            return true;
        }, f.env);
        stop();
        f.advance(2_000);
        f.show();
        expect(f.delay()).toBeNull();
        expect(f.listeners.size).toBe(0);
        expect(calls).toBe(0);
    });
});
describe("freshestCsrfToken", () => {
    afterEach(() => {
        freshestCsrfToken("");
    });
    const okResponse = (token) => async () => Response.json({ token });
    it("prefers a fetched token over an older server-signed one, and a newer server one over it", async () => {
        await fetchFreshCsrfToken(okResponse("2000.n.s"), async () => { });
        expect(freshestCsrfToken("1000.n.s")).toBe("2000.n.s");
        expect(freshestCsrfToken("3000.n.s")).toBe("3000.n.s");
    });
    it("signed out forgets the fetched token, so it never reaches the next session", async () => {
        await fetchFreshCsrfToken(okResponse("2000.n.s"), async () => { });
        expect(freshestCsrfToken("")).toBe("");
        expect(freshestCsrfToken("1000.n.s")).toBe("1000.n.s");
    });
    it("reads the signing time from the token", () => {
        expect(csrfTokenIssuedAt("1700000000000.bm9uY2U.c2ln")).toBe(1700000000000);
        expect(csrfTokenIssuedAt("")).toBeNull();
        expect(csrfTokenIssuedAt("x.y.z")).toBeNull();
    });
});
describe("fetchFreshCsrfToken", () => {
    afterEach(() => {
        freshestCsrfToken("");
    });
    it("fetches the endpoint, remembers the token, then applies it", async () => {
        const seen = [];
        let applied = false;
        const fetchFn = (async (url) => {
            seen.push(url);
            return Response.json({ token: "5000.n.s" });
        });
        expect(await fetchFreshCsrfToken(fetchFn, async () => {
            applied = freshestCsrfToken("1000.n.s") === "5000.n.s";
        })).toBe(true);
        expect(seen).toEqual([CSRF_TOKEN_PATH]);
        expect(applied).toBe(true);
    });
    it("a 401 (session gone) applies nothing and says stop", async () => {
        let applied = false;
        const fetchFn = (async () => Response.json({ error: "Not signed in." }, { status: 401 }));
        expect(await fetchFreshCsrfToken(fetchFn, async () => {
            applied = true;
        })).toBe(false);
        expect(applied).toBe(false);
    });
    it("any other failure throws, so the caller retries", async () => {
        const fetchFn = (async () => new Response("down", { status: 503 }));
        await expect(fetchFreshCsrfToken(fetchFn, async () => { })).rejects.toThrow("HTTP 503");
        const malformed = (async () => Response.json({ nope: 1 }));
        await expect(fetchFreshCsrfToken(malformed, async () => { })).rejects.toThrow();
    });
});
