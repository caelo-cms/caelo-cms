class ConfirmState {
    current = $state(null);
}
/** Read by `ConfirmDialogHost`; call sites use `requestConfirm` / `confirmSubmit`. */
export const confirmState = new ConfirmState();
/**
 * Opens the confirm dialog and resolves with the operator's decision.
 * A second request while one is open cancels the first, so a stale
 * promise never resolves `true` for an action the operator didn't see.
 */
export function requestConfirm(options) {
    confirmState.current?.resolve(false);
    return new Promise((resolve) => {
        confirmState.current = { ...options, resolve };
    });
}
/** Closes the open dialog with the given decision. No-op when nothing is open. */
export function settleConfirm(confirmed) {
    const pending = confirmState.current;
    if (!pending)
        return;
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
export const confirmSubmit = (form, initial) => {
    let options = initial;
    let approved = false;
    async function onSubmit(event) {
        if (approved) {
            approved = false;
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        const submitter = event.submitter instanceof HTMLElement ? event.submitter : undefined;
        if (!(await requestConfirm(options)))
            return;
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
