// SPDX-License-Identifier: MPL-2.0
/**
 * Confirmation gate for destructive admin actions (delete, revoke,
 * revert, rotate, …). One dialog host is mounted in the authed layout
 * (`ConfirmDialogHost.svelte`); call sites either await
 * `requestConfirm(...)` from JS or put `use:confirmSubmit={...}` on the
 * `<form>` whose submit is destructive.
 *
 * The form action listens in the CAPTURE phase and stops immediate
 * propagation: SvelteKit's `use:enhance` submit listener does not check
 * `defaultPrevented`, and the global `SubmitLoadingObserver` would mark
 * the button busy for a submit that never happened. Capture-at-target
 * runs before both, so a declined confirm leaves no trace. On approval
 * the form is re-submitted with the original submitter, and that second
 * submit passes through untouched.
 */
import type { Action } from "svelte/action";

/** What the operator is asked before a destructive submit goes through. */
export interface ConfirmOptions {
  /** Question naming the concrete object, e.g. `Delete user anna@example.com?` */
  title: string;
  /** Consequence in plain words: what is lost, what breaks, whether it can be undone. */
  description?: string;
  /** Label of the confirming button; names the action (`Delete`, `Revoke`, …). */
  confirmLabel: string;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

class ConfirmState {
  current = $state<PendingConfirm | null>(null);
}

/** Read by `ConfirmDialogHost`; call sites use `requestConfirm` / `confirmSubmit`. */
export const confirmState = new ConfirmState();

/**
 * Opens the confirm dialog and resolves with the operator's decision.
 * A second request while one is open cancels the first, so a stale
 * promise never resolves `true` for an action the operator didn't see.
 */
export function requestConfirm(options: ConfirmOptions): Promise<boolean> {
  confirmState.current?.resolve(false);
  return new Promise((resolve) => {
    confirmState.current = { ...options, resolve };
  });
}

/** Closes the open dialog with the given decision. No-op when nothing is open. */
export function settleConfirm(confirmed: boolean): void {
  const pending = confirmState.current;
  if (!pending) return;
  confirmState.current = null;
  pending.resolve(confirmed);
}

/**
 * Svelte action: asks for confirmation before the form submits.
 * Works with and without `use:enhance`.
 *
 * @example
 * <form method="post" action="?/delete" use:confirmSubmit={{
 *   title: `Delete user ${u.email}?`,
 *   description: "They lose access immediately.",
 *   confirmLabel: "Delete user",
 * }}>
 */
export const confirmSubmit: Action<HTMLFormElement, ConfirmOptions> = (form, initial) => {
  let options = initial;
  let approved = false;

  async function onSubmit(event: SubmitEvent): Promise<void> {
    if (approved) {
      approved = false;
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const submitter = event.submitter instanceof HTMLElement ? event.submitter : undefined;
    if (!(await requestConfirm(options))) return;
    approved = true;
    form.requestSubmit(submitter);
  }

  form.addEventListener("submit", onSubmit, { capture: true });
  return {
    update(next) {
      options = next;
    },
    destroy() {
      form.removeEventListener("submit", onSubmit, { capture: true });
    },
  };
};
