<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Global submit-button loading state (operator feedback 2026-07-12:
   * "Save & start" submitted with zero feedback — "not clear that
   * something is loaded"; the same held for ~175 submit buttons).
   *
   * One document-level listener instead of per-button markup: when any
   * `method="post"` form submits, the triggering button
   * (`event.submitter`) gets `data-loading` + `disabled` + `aria-busy`
   * — app.css renders the spinner. Covers every existing and future
   * form without touching call sites.
   *
   * Reset paths:
   * - plain POSTs navigate → fresh document, nothing to reset;
   * - `use:enhance` POSTs resolve into a `page.form`/`page.status`
   *   change OR an `afterNavigate` → both clear every marked button;
   * - a 20s failsafe clears stragglers (network black-hole) so the UI
   *   can never wedge disabled.
   *
   * The chat composer and other JS-driven forms have no
   * `method="post"` and manage their own states — the listener
   * ignores them. Forms can opt out with `data-no-submit-loading`.
   */

  import { afterNavigate } from "$app/navigation";
  import { page } from "$app/state";

  const FAILSAFE_MS = 20_000;
  const timers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();

  function clearAll(): void {
    for (const [btn, t] of timers) {
      clearTimeout(t);
      delete btn.dataset.loading;
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    }
    timers.clear();
  }

  function onSubmit(e: SubmitEvent): void {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.method !== "post") return;
    if ("noSubmitLoading" in form.dataset) return;
    const btn = e.submitter;
    if (!(btn instanceof HTMLButtonElement) || btn.disabled) return;
    // Client-side validation vetoed the submit (but use:enhance also
    // prevents default while the request IS flying — so only skip
    // when no enhance handler owns the form).
    if (e.defaultPrevented && !("sveltekitEnhanced" in form.dataset) && form.onsubmit !== null) {
      return;
    }
    btn.dataset.loading = "true";
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    timers.set(
      btn,
      setTimeout(() => {
        delete btn.dataset.loading;
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        timers.delete(btn);
      }, FAILSAFE_MS),
    );
  }

  $effect(() => {
    document.addEventListener("submit", onSubmit);
    return () => {
      document.removeEventListener("submit", onSubmit);
      clearAll();
    };
  });

  // An enhanced action resolving updates page.form / page.status —
  // that's the "response arrived" signal for non-navigating POSTs.
  $effect(() => {
    void page.form;
    void page.status;
    clearAll();
  });

  afterNavigate(() => {
    clearAll();
  });
</script>
