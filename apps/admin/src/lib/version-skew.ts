// SPDX-License-Identifier: MPL-2.0

/**
 * A tab left open across an update keeps the previous release's client code
 * (#1656). A client-side navigation would render the new server's page data
 * with those old components, and a page whose data changed shape crashes
 * into an error page. SvelteKit knows when a newer release is deployed
 * (`updated`, from its focus and visibility checks and the
 * `x-sveltekit-version` header of every data response), but it reloads by
 * itself only when a navigation's load fails, never when rendering does.
 *
 * So the root layout turns every navigation into a full page load once a
 * newer release is known ({@link fullLoadTarget}), and the error page
 * reloads once when it shows up in a tab older than the release
 * ({@link reloadIfNewerRelease}). Neither polls: the checks ride on what
 * the tab does anyway (CLAUDE.md §11.B).
 */

/** The parts of SvelteKit's `beforeNavigate` argument {@link fullLoadTarget} reads. */
export interface PendingNavigation {
  readonly willUnload: boolean;
  readonly to: { readonly url: URL } | null;
}

/**
 * The address to load fully instead of navigating client-side, or `null`
 * to let the navigation run: a newer release is deployed, the target is in
 * this app, and the browser does not leave the page anyway.
 *
 * @example
 *   fullLoadTarget(true, { willUnload: false, to: { url: new URL("https://a.test/edit") } }, "https://a.test")
 *   // → "https://a.test/edit"
 */
export function fullLoadTarget(
  newerReleaseDeployed: boolean,
  navigation: PendingNavigation,
  origin: string,
): string | null {
  if (!newerReleaseDeployed || navigation.willUnload || navigation.to === null) return null;
  const { url } = navigation.to;
  return url.origin === origin ? url.href : null;
}

/** How long one address is not reloaded again after {@link reloadIfNewerRelease} reloaded it. */
export const RELOAD_GUARD_MS = 60_000;

/**
 * Where {@link reloadIfNewerRelease} remembers its last reload across the
 * reload (the tab's `sessionStorage`). `get` answers `null` and `set` does
 * nothing when the storage is unavailable.
 */
export interface ReloadMemory {
  get(): string | null;
  set(value: string): void;
}

/**
 * Reloads the page when a newer release is deployed than the one this tab
 * runs, and says whether it did. After the reload the tab runs that release,
 * so the check answers `false` and a real error stays on screen. The same
 * address is not reloaded twice within {@link RELOAD_GUARD_MS}, so a check
 * that keeps answering `true` (two revisions answering side by side during
 * a rollout) cannot loop. Without a memory that keeps the guard across the
 * reload (storage blocked or full) it never reloads: the operator reloads
 * by hand, as before.
 *
 * @param newerReleaseDeployed SvelteKit's `updated.check()`.
 * @param href The address the error page shows.
 */
export async function reloadIfNewerRelease(
  newerReleaseDeployed: () => Promise<boolean>,
  reload: () => void,
  memory: ReloadMemory,
  href: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (reloadedRecently(memory.get(), href, now)) return false;
  if (!(await newerReleaseDeployed())) return false;
  const guard = JSON.stringify({ href, at: now });
  memory.set(guard);
  if (memory.get() !== guard) return false;
  reload();
  return true;
}

function reloadedRecently(remembered: string | null, href: string, now: number): boolean {
  if (remembered === null) return false;
  try {
    const last = JSON.parse(remembered) as { href?: unknown; at?: unknown };
    return last.href === href && typeof last.at === "number" && now - last.at < RELOAD_GUARD_MS;
  } catch {
    return false;
  }
}
