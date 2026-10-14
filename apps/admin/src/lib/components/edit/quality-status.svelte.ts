// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — one shared poller of a chat's quality-gate status, used by
 * the chat panel (status notes, the fix offer card) and the /edit toolbar
 * (Publish gate). A
 * module-level registry keyed by chat id keeps it to ONE request stream per
 * chat however many components read it.
 *
 * Cadence: every 4 s while the chat's newest audit is queued/running (the
 * result should land promptly), every 20 s otherwise (a Stage from another
 * tab or chat can move the site-wide gate). Polling pauses while the tab is
 * hidden.
 */

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
 *  is a card: its `prompt` is sent only on the operator's click. */
export type QualityFeedback =
  | { readonly kind: "note"; readonly text: string }
  | {
      readonly kind: "offer";
      readonly text: string;
      readonly actionLabel: string;
      readonly prompt: string;
      /** #727 — the open problems by group: fix / accept / pick each. */
      readonly groups: readonly QualityProblemGroup[];
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
  #timer: ReturnType<typeof setTimeout> | null = null;
  #users = 0;
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
    if (this.#users === 1) void this.refresh();
  }

  release(): void {
    this.#users -= 1;
    if (this.#users <= 0 && this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** Fetch now (e.g. right after a Stage) and reschedule. Resolves once a
   *  fetch that started after this call has landed. */
  async refresh(): Promise<void> {
    await this.#fetchCoalesced();
    this.#schedule();
  }

  async #fetchOnce(): Promise<void> {
    try {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        const res = await fetch(`/content/chat/${this.chatSessionId}/quality-audit`, {
          headers: { accept: "application/json" },
        });
        if (res.ok) this.status = (await res.json()) as QualityStatus;
      }
    } catch {
      // network blip — the next tick retries
    }
  }

  #schedule(): void {
    if (this.#users <= 0) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    const busy =
      this.status?.audit?.status === "queued" || this.status?.audit?.status === "running";
    this.#timer = setTimeout(() => void this.refresh(), busy ? 4_000 : 20_000);
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
    error?: string;
  };
  return { ok: res.ok && data.ok !== false, ...data };
}
