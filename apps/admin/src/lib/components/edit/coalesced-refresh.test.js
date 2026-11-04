// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { coalescedRefresh } from "./coalesced-refresh.js";
/** A task whose runs finish only when the test says so. */
function controllableTask() {
    const releases = [];
    let runs = 0;
    const task = () => new Promise((resolve) => {
        runs++;
        releases.push(resolve);
    });
    const releaseNext = async () => {
        releases.shift()?.();
        // Let the runner's loop observe the settled run.
        await new Promise((r) => setTimeout(r, 0));
    };
    return { task, releaseNext, runs: () => runs };
}
describe("coalescedRefresh", () => {
    it("runs once when nothing else is in flight", async () => {
        const t = controllableTask();
        const refresh = coalescedRefresh(t.task);
        const p = refresh();
        await t.releaseNext();
        await p;
        expect(t.runs()).toBe(1);
    });
    it("re-runs after the in-flight pass when called meanwhile — never drops the call", async () => {
        // The quality-card flake: refresh #1 is on the wire with pre-ack state;
        // the post-ack refresh #2 must still produce a fetch that starts later.
        const t = controllableTask();
        const refresh = coalescedRefresh(t.task);
        const first = refresh();
        const second = refresh();
        expect(t.runs()).toBe(1);
        await t.releaseNext();
        expect(t.runs()).toBe(2);
        let settled = false;
        void second.then(() => {
            settled = true;
        });
        await new Promise((r) => setTimeout(r, 0));
        expect(settled).toBe(false);
        await t.releaseNext();
        await Promise.all([first, second]);
        expect(t.runs()).toBe(2);
    });
    it("collapses many calls during one pass into a single re-run", async () => {
        const t = controllableTask();
        const refresh = coalescedRefresh(t.task);
        const calls = [refresh(), refresh(), refresh(), refresh()];
        await t.releaseNext();
        await t.releaseNext();
        await Promise.all(calls);
        expect(t.runs()).toBe(2);
        // Idle again: the next call starts a fresh pass.
        const later = refresh();
        await t.releaseNext();
        await later;
        expect(t.runs()).toBe(3);
    });
    it("propagates a failing pass and recovers on the next call", async () => {
        let fail = true;
        let runs = 0;
        const refresh = coalescedRefresh(async () => {
            runs++;
            if (fail)
                throw new Error("boom");
        });
        await expect(refresh()).rejects.toThrow("boom");
        fail = false;
        await refresh();
        expect(runs).toBe(2);
    });
});
