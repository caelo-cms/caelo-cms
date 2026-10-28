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

import { type LiveConsumer, liveFetch, liveHub } from "#lib/live/live-refresh.js";
import { coalescedRefresh } from "./coalesced-refresh.js";

export interface QualityGate {
  readonly open: boolean;
  readonly state:
    | "clean"
    | "accepted"
    | "overridden"
    | "missing"
    | "running"
    | "problems"
    | "errored";
  readonly auditRunId: string | null;
  readonly message: string;
  readonly canPublishAnyway: boolean;
  readonly openProblemCount: number;
}

/**
 * #727 — one group of open quality problems: one rule across pages
 * ("seo-check/description-missing: 312 pages"). `ref` names it the way an
 * acceptance does; `pages[].detail` is the measured value on that page.
 */
export interface QualityProblemGroup {
  readonly key: string;
  readonly ref:
    | { readonly auditId: string }
    | { readonly category: string }
    | { readonly ruleId: string };
  readonly title: string;
  readonly pages: readonly {
    readonly pageId: string | null;
    readonly pagePath: string;
    readonly detail: string;
  }[];
}

/** What the chat is told about a settled audit (#553). An `offer` (#685)
 *  is a card: its `prompt` is sent on the operator's click, or on its own
 *  when `autoContinue` (#771: the next round of a fix-all). */
export type QualityFeedback =
  | { readonly kind: "note"; readonly text: string }
  | {
      readonly kind: "offer";
      readonly text: string;
      readonly actionLabel: string;
      readonly prompt: string;
      /** #727 — the open problems by group: fix / accept / pick each. */
      readonly groups: readonly QualityProblemGroup[];
      readonly autoContinue: boolean;
    };

/** #727 — the groups (and optionally pages of each) a card click covers. */
export interface QualityGroupSelection {
  readonly key: string;
  /** Only these pages of the group; omitted = all of them. */
  readonly pagePaths?: readonly string[];
}

export interface QualityStatus {
  readonly audit: { readonly id: string; readonly status: string } | null;
  readonly notified: boolean;
  readonly feedback: QualityFeedback | null;
  readonly deployRunId: string | null;
  readonly gate: QualityGate | null;
}

class QualityStatusPoller {
  status = $state<QualityStatus | null>(null);
  #unregister: (() => void) | null = null;
  #users = 0;
  // Bumped by `apply()`. A read that started under an older epoch may have
  // read the state from before the change whose result was applied, so it
  // is discarded instead of overwriting the newer status (the accepted
  // group would reappear until the next read).
  #epoch = 0;
  // Coalesced, not dropped: a refresh asked for while one is on the wire
  // runs again after it, so a caller that just changed the state (ack,
  // dismiss, claim) always gets a fetch that started after its change.
  readonly #fetchCoalesced = coalescedRefresh(() => this.#fetchOnce());

  readonly chatSessionId: string;

  constructor(chatSessionId: string) {
    this.chatSessionId = chatSessionId;
  }

  acquire(): void {
    this.#users += 1;
    if (this.#users !== 1) return;
    void this.refresh();
    const consumer: LiveConsumer = {
      topics: ["quality"],
      refresh: () => void this.refresh(),
      // The result of a queued / running audit lands without any action here.
      waiting: () => this.#auditBusy(),
    };
    this.#unregister = liveHub.register(consumer);
  }

  release(): void {
    this.#users -= 1;
    if (this.#users <= 0) {
      this.#unregister?.();
      this.#unregister = null;
    }
  }

  #auditBusy(): boolean {
    const s = this.status?.audit?.status;
    return s === "queued" || s === "running";
  }

  /**
   * Show `status` now — the state a quality action's response carries,
   * read by the server after the action committed — and re-read once to
   * stay current. Any read already on the wire is discarded when it lands:
   * it may predate the action.
   */
  async apply(status: QualityStatus): Promise<void> {
    this.#epoch += 1;
    this.status = status;
    await this.refresh();
  }

  /** Fetch now (e.g. right after a Stage). Resolves once a fetch that
   *  started after this call has landed. */
  async refresh(): Promise<void> {
    await this.#fetchCoalesced();
    // A queued audit may just have appeared: start waiting for its result.
    liveHub.kick();
  }

  async #fetchOnce(): Promise<void> {
    const epoch = this.#epoch;
    try {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        const res = await liveFetch(`/content/chat/${this.chatSessionId}/quality-audit`, {
          headers: { accept: "application/json" },
        });
        if (!res.ok) return;
        const status = (await res.json()) as QualityStatus;
        if (epoch === this.#epoch) this.status = status;
      }
    } catch {
      // Network blip or deadline: the next topic or focus re-reads.
    }
  }
}

const pollers = new Map<string, QualityStatusPoller>();

/** The shared poller of `chatSessionId`. Call `acquire()` on mount and
 *  `release()` on unmount. */
export function qualityStatusFor(chatSessionId: string): QualityStatusPoller {
  let p = pollers.get(chatSessionId);
  if (!p) {
    p = new QualityStatusPoller(chatSessionId);
    pollers.set(chatSessionId, p);
  }
  return p;
}

/** POST an action to the chat's quality endpoint (CSRF via header). */
export async function postQualityAction(
  chatSessionId: string,
  csrfToken: string,
  body:
    | { action: "claim"; auditRunId: string; fixSelection?: readonly QualityGroupSelection[] }
    | {
        action: "accept";
        auditRunId: string;
        groups: readonly QualityGroupSelection[];
        reason: string;
      }
    | { action: "ack"; auditRunId: string }
    | { action: "release"; auditRunId: string }
    | { action: "dismiss"; auditRunId: string }
    | { action: "retry" },
): Promise<{
  ok: boolean;
  send?: string | null;
  note?: string;
  dismissed?: boolean;
  accepted?: number;
  /** "accept" — the chat's status after the acceptance applied. */
  status?: QualityStatus;
  error?: string;
}> {
  const res = await fetch(`/content/chat/${chatSessionId}/quality-audit`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    send?: string | null;
    note?: string;
    dismissed?: boolean;
    accepted?: number;
    status?: QualityStatus;
    error?: string;
  };
  return { ok: res.ok && data.ok !== false, ...data };
}
