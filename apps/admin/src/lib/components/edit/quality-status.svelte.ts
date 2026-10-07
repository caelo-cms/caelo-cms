// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — one shared poller of a chat's quality-gate status, used by
 * the chat panel (fix-loop nudges) and the /edit toolbar (Publish gate). A
 * module-level registry keyed by chat id keeps it to ONE request stream per
 * chat however many components read it.
 *
 * Cadence: every 4 s while the chat's newest audit is queued/running (the
 * result should land promptly), every 20 s otherwise (a Stage from another
 * tab or chat can move the site-wide gate). Polling pauses while the tab is
 * hidden.
 */

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

export interface QualityStatus {
  readonly audit: { readonly id: string; readonly status: string } | null;
  readonly notified: boolean;
  readonly feedback: { readonly kind: "note" | "ai-turn"; readonly text: string } | null;
  readonly deployRunId: string | null;
  readonly gate: QualityGate | null;
}

class QualityStatusPoller {
  status = $state<QualityStatus | null>(null);
  #timer: ReturnType<typeof setTimeout> | null = null;
  #users = 0;
  #inFlight = false;

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

  /** Fetch now (e.g. right after a Stage) and reschedule. */
  async refresh(): Promise<void> {
    if (this.#inFlight) return;
    this.#inFlight = true;
    try {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        const res = await fetch(`/content/chat/${this.chatSessionId}/quality-audit`, {
          headers: { accept: "application/json" },
        });
        if (res.ok) this.status = (await res.json()) as QualityStatus;
      }
    } catch {
      // network blip — the next tick retries
    } finally {
      this.#inFlight = false;
      this.#schedule();
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
  body: { action: "claim"; auditRunId: string } | { action: "retry" },
): Promise<{ ok: boolean; send?: string | null; note?: string; error?: string }> {
  const res = await fetch(`/content/chat/${chatSessionId}/quality-audit`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    send?: string | null;
    note?: string;
    error?: string;
  };
  return { ok: res.ok && data.ok !== false, ...data };
}
