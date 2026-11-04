// SPDX-License-Identifier: MPL-2.0
/** Deadline of a live surface's own read (pending, agents, quality …). */
export const LIVE_READ_TIMEOUT_MS = 15_000;
/** Deadline of one `/api/live-events` wait; the server answers within 10 s. */
export const LIVE_WAIT_TIMEOUT_MS = 20_000;
/** Visibility and focus fire together; one re-read covers both. */
const FOCUS_DEDUPE_MS = 1_000;
/**
 * Fetch with the live surfaces' deadline. Use it for every live read so a
 * slow admin never stacks requests from one tab.
 */
export function liveFetch(url, init = {}, fetchFn = fetch) {
    return fetchFn(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(LIVE_READ_TIMEOUT_MS),
    });
}
/** Build a hub over `env`. The app uses {@link liveHub}; tests build their own. */
export function createLiveHub(env) {
    const consumers = new Set();
    let openStreams = 0;
    let waitRunning = false;
    // Set by a failed wait; only a focus, visibility change or own action
    // clears it, so a broken endpoint is never hammered by a loop.
    let suspended = false;
    let lastFocusAt = Number.NEGATIVE_INFINITY;
    let stopFocus = null;
    const waitingConsumers = () => [...consumers].filter((c) => c.waiting?.() === true);
    const allTopics = () => {
        const set = new Set();
        for (const c of consumers)
            for (const t of c.topics)
                set.add(t);
        return [...set].sort();
    };
    const publish = (topics) => {
        if (topics.length === 0)
            return;
        const wanted = new Set(topics);
        for (const c of [...consumers]) {
            if (c.topics.some((t) => wanted.has(t)))
                c.refresh("topic");
        }
    };
    const shouldWait = () => !suspended && openStreams === 0 && env.isVisible() && waitingConsumers().length > 0;
    async function runWait() {
        if (waitRunning)
            return;
        waitRunning = true;
        try {
            while (shouldWait()) {
                const topics = allTopics();
                let answered;
                try {
                    const res = await env.fetch(`/api/live-events?topics=${topics.join(",")}`, {
                        headers: { accept: "application/json" },
                        signal: AbortSignal.timeout(LIVE_WAIT_TIMEOUT_MS),
                    });
                    if (!res.ok)
                        throw new Error(`HTTP ${res.status}`);
                    answered = (await res.json()).topics;
                }
                catch {
                    suspended = true;
                    return;
                }
                if (answered.length > 0)
                    publish(answered);
                else {
                    for (const c of [...consumers]) {
                        if (c.refreshOnExpiry === true || c.waiting?.() === true)
                            c.refresh("wait-expired");
                    }
                }
            }
        }
        finally {
            waitRunning = false;
        }
    }
    const kick = () => {
        if (shouldWait())
            void runWait();
    };
    const onFocus = () => {
        if (!env.isVisible())
            return;
        const now = env.now();
        if (now - lastFocusAt < FOCUS_DEDUPE_MS)
            return;
        lastFocusAt = now;
        suspended = false;
        for (const c of [...consumers])
            c.refresh("focus");
        kick();
    };
    return {
        register(consumer) {
            consumers.add(consumer);
            stopFocus ??= env.onFocus(onFocus);
            // Deferred: `register` runs inside Svelte effects, and reading every
            // consumer's `waiting()` there would make that effect depend on other
            // components' state (and re-register, and re-read, on each change).
            queueMicrotask(kick);
            return () => {
                consumers.delete(consumer);
                if (consumers.size === 0 && stopFocus) {
                    stopFocus();
                    stopFocus = null;
                }
            };
        },
        publish(topics) {
            suspended = false;
            publish(topics);
            kick();
        },
        kick,
        resume() {
            suspended = false;
            kick();
        },
        openStream() {
            openStreams += 1;
            let closed = false;
            return () => {
                if (closed)
                    return;
                closed = true;
                openStreams -= 1;
                queueMicrotask(kick);
            };
        },
    };
}
const browserEnv = {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
    onFocus(listener) {
        if (typeof window === "undefined")
            return () => undefined;
        const onVisibility = () => {
            if (document.visibilityState === "visible")
                listener();
        };
        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("focus", listener);
        return () => {
            document.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener("focus", listener);
        };
    },
};
/** The tab's hub. */
export const liveHub = createLiveHub(browserEnv);
