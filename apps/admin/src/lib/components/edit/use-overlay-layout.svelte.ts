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
  pin: "floating",
  collapsed: false,
  x: 24,
  y: 80,
  width: 360,
  height: 480,
  pinnedHeight: 320,
  pinnedWidth: 380,
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
