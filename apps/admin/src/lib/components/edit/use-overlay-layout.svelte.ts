// SPDX-License-Identifier: MPL-2.0

/**
 * Svelte 5 rune-based store for the live-edit overlay's layout state
 * (pin mode + position + size + collapsed flag), with debounced
 * persistence via the `user_preferences` ops.
 *
 * The overlay reads the persisted state on mount and writes back on
 * any change with a 500ms debounce so a drag doesn't fire 60
 * round-trips.
 */

export type PinMode = "floating" | "pinned-bottom" | "pinned-right";

export interface OverlayLayout {
  pin: PinMode;
  collapsed: boolean;
  /** Floating-mode position. Ignored in pinned modes. */
  x: number;
  y: number;
  /** Floating-mode size. Ignored in pinned modes. */
  width: number;
  height: number;
  /** P6.7.4 — pinned-bottom strip height (px). Drag the top edge to resize. */
  pinnedHeight: number;
  /** P6.7.4 — pinned-right strip width (px). Drag the left edge to resize. */
  pinnedWidth: number;
}

export const DEFAULT_LAYOUT: OverlayLayout = {
  // Chat-panel UX pass: the chat IS the product's primary surface, so
  // the DEFAULT is a full-height side column (Cursor/Copilot form
  // factor) instead of a 360×480 floating box that forced the
  // onboarding welcome behind two scrollbars. Users who prefer
  // floating drag it out once — the preference persists.
  pin: "pinned-right",
  collapsed: false,
  x: 24,
  y: 80,
  width: 400,
  height: 560,
  pinnedHeight: 320,
  pinnedWidth: 420,
};

const PREFERENCE_KEY = "edit_overlay_layout";

/**
 * Persists `layout` to the server via `user_preferences.set`. Caller is
 * expected to debounce. Errors are swallowed (a failed write is
 * tolerable — next change will retry; user can also just reload).
 */
export async function saveOverlayLayout(csrfToken: string, layout: OverlayLayout): Promise<void> {
  try {
    await fetch("/edit/preferences", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({ key: PREFERENCE_KEY, value: layout }),
    });
  } catch {
    // best-effort; ignore
  }
}

export function debounced<Args extends unknown[]>(
  fn: (...args: Args) => unknown,
  ms: number,
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
