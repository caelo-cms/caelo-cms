# Live refresh in the editor (no timer polling)

CLAUDE.md §11.B: clients must not poll the admin on a timer, because every request keeps an instance up. Before #1215 the editor did: running agents every 3 s, the header indicator every 5 s, pending approvals every 10 s (each also re-reading the one-time credentials), quality status every 4–20 s, notifications every 30 s. On 2026-10-28 two idle tabs made ~1.7 requests a second, and once the admin slowed down each tab stacked dozens of requests on top of each other.

This page describes what replaced it and how to add a live surface.

## The model

A live surface (the running-agents bar, the pending strip, the quality status, the notification bell, …) re-reads itself through its usual read endpoint when one of these happens:

1. **A topic it shows arrives.** Topics are `agents`, `pending`, `credentials`, `quality`, `crawl`, `deploys` (`packages/shared/src/live-events.ts`). A topic is a hint, never data: no ids, no rows, no actor. The read that follows goes through the endpoint's own permission checks.
2. **The tab becomes visible or the window gets focus.**
3. **The tab did something itself** (an Approve, a Stop, a quality action): the code calls `liveHub.publish([...])` or re-reads directly.

An idle tab (no turn running, nothing in progress) makes **no request at all**. `scripts/no-timer-polling.test.ts` fails on a timer loop in `apps/admin/src` that reaches a request.

## Where topics come from

Every operation that commits is classified **by name** (`liveTopicsOfOperation`, shared) through the Query API's `observeCommittedOperations` hook, so no handler has to remember to announce its change. Only write ops are listed; reads and clock-driven writes (heartbeats, lease renewals, the audit worker's idle `claim_next`) announce nothing, because a hint on a clock is polling again. `packages/admin-core/src/__tests__/live-events.test.ts` checks the classification against the real op catalogue.

The admin's in-process hub (`packages/admin-core/src/live-events.ts`) hands topics to two listeners:

- **The chat stream.** While a turn runs, `/content/chat/<id>/stream` forwards every topic of the process to that tab as `{kind: "live", topics}` events (coalesced over 100 ms, flushed before `done`).
- **`GET /api/live-events?topics=…`.** A tab with no open stream that waits on work in progress (an audit queued or running, an agent working, a crawl, a deploy) holds one request here. The server answers with the first matching topics, or `[]` after 10 s (below the ~14 s idle close of the load balancer / IAP, so no keep-alive is written). The request holds no database connection and the server runs no loop for it.

Topics committed on **another** admin instance do not arrive (there is no cross-instance channel). That is why a waiting surface re-reads itself once when a wait comes back empty.

## The client hub

`apps/admin/src/lib/live/live-refresh.ts` holds one hub per tab:

- `liveHub.register({ topics, refresh, waiting? })` adds a surface; the returned function removes it (return it from a Svelte `$effect`).
- `refresh` must carry its own in-flight guard: wrap the read in `coalescedRefresh` (`lib/components/edit/coalesced-refresh.ts`).
- `waiting()` is true while the surface waits on work in progress that no action of this tab will announce. The hub holds at most one wait, only while the tab is visible, never while this tab's chat stream is open, and never retries a failed wait on a timer (the next focus, visibility change or own action resumes it).
- Every live read uses `liveFetch`, which adds `AbortSignal.timeout`, so a slow admin never stacks requests from one tab.

## Adding a live surface

1. If the surface needs a new topic, add it to `LIVE_TOPICS` and classify the write ops that change it in `liveTopicsOfOperation`; extend the catalogue test.
2. Register the component with `liveHub.register`, re-reading through `coalescedRefresh` + `liveFetch`.
3. Give it `waiting()` only if its state changes without any action of this tab (server-side work in progress).
4. Never add `setInterval` / self-rescheduling `setTimeout` around a request; the guard test fails. A timer that only updates local state (a clock) is fine.

## Known exceptions

Listed with their reasons in `scripts/no-timer-polling.test.ts`: the CSRF token renewal (one request per half token lifetime, #1191) and the Caelo update progress on Settings → Updates (the admin being asked is replaced mid-update, so no push survives the roll).
