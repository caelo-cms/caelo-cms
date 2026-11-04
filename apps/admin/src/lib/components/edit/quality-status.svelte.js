// SPDX-License-Identifier: MPL-2.0
/**
 * Issue #553 — one shared reader of a chat's quality-gate status, used by
 * the chat panel (status notes, the fix offer card) and the /edit toolbar
 * (Publish gate). A
 * module-level registry keyed by chat id keeps it to ONE request at a time
 * per chat however many components read it.
 *
 * When it re-reads (#1215 — never on a timer, CLAUDE.md §11.B): on every
 * `quality` live topic (a Stage, an audit settling, a claim — from this
 * tab's chat stream, or from the live-events wait while the chat's newest
 * audit is queued/running), when the tab regains focus, and after this
 * tab's own quality actions. Nothing is read while the tab is hidden.
 */
import { liveFetch, liveHub } from "#lib/live/live-refresh.js";
import { coalescedRefresh } from "./coalesced-refresh.js";
class QualityStatusPoller {
    status = $state(null);
    #unregister = null;
    #users = 0;
    // Bumped by `apply()`. A read that started under an older epoch may have
    // read the state from before the change whose result was applied, so it
    // is discarded instead of overwriting the newer status (the accepted
    // group would reappear until the next read).
    #epoch = 0;
    // Coalesced, not dropped: a refresh asked for while one is on the wire
    // runs again after it, so a caller that just changed the state (ack,
    // dismiss, claim) always gets a fetch that started after its change.
    #fetchCoalesced = coalescedRefresh(() => this.#fetchOnce());
    chatSessionId;
    constructor(chatSessionId) {
        this.chatSessionId = chatSessionId;
    }
    acquire() {
        this.#users += 1;
        if (this.#users !== 1)
            return;
        void this.refresh();
        const consumer = {
            topics: ["quality"],
            // The hub's own re-read: automatic, so it may only kick, never resume.
            refresh: () => void this.#fetchCoalesced().then(() => liveHub.kick()),
            // The result of a queued / running audit lands without any action here.
            waiting: () => this.#auditBusy(),
        };
        this.#unregister = liveHub.register(consumer);
    }
    release() {
        this.#users -= 1;
        if (this.#users <= 0) {
            this.#unregister?.();
            this.#unregister = null;
        }
    }
    #auditBusy() {
        const s = this.status?.audit?.status;
        return s === "queued" || s === "running";
    }
    /**
     * Show `status` now — the state a quality action's response carries,
     * read by the server after the action committed — and re-read once to
     * stay current. Any read already on the wire is discarded when it lands:
     * it may predate the action.
     */
    async apply(status) {
        this.#epoch += 1;
        this.status = status;
        await this.refresh();
    }
    /** Fetch now, after an action of this tab (a Stage, a Retry, a claim).
     *  Resolves once a fetch that started after this call has landed. */
    async refresh() {
        await this.#fetchCoalesced();
        // A queued audit may just have appeared: wait for its result, also
        // when an earlier wait failed — this is the operator's own action.
        liveHub.resume();
    }
    async #fetchOnce() {
        const epoch = this.#epoch;
        try {
            if (typeof document === "undefined" || document.visibilityState !== "hidden") {
                const res = await liveFetch(`/content/chat/${this.chatSessionId}/quality-audit`, {
                    headers: { accept: "application/json" },
                });
                if (!res.ok)
                    return;
                const status = (await res.json());
                if (epoch === this.#epoch)
                    this.status = status;
            }
        }
        catch {
            // Network blip or deadline: the next topic or focus re-reads.
        }
    }
}
const pollers = new Map();
/** The shared poller of `chatSessionId`. Call `acquire()` on mount and
 *  `release()` on unmount. */
export function qualityStatusFor(chatSessionId) {
    let p = pollers.get(chatSessionId);
    if (!p) {
        p = new QualityStatusPoller(chatSessionId);
        pollers.set(chatSessionId, p);
    }
    return p;
}
/** POST an action to the chat's quality endpoint (CSRF via header). */
export async function postQualityAction(chatSessionId, csrfToken, body) {
    const res = await fetch(`/content/chat/${chatSessionId}/quality-audit`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({})));
    return { ok: res.ok && data.ok !== false, ...data };
}
