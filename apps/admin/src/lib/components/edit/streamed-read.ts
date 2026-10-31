// SPDX-License-Identifier: MPL-2.0

/**
 * #1268 — the rules for reading streamed editor parts, as plain functions
 * (`StreamedValue` holds the state; these decide what of it to show).
 */

/** What a `StreamedValue` holds. */
export interface StreamedSnapshot<T> {
  readonly current: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  /** The chat or page the last settled value was loaded for. */
  readonly key: string | null;
}

/**
 * The value if it was loaded for `key`, else null: after a switch to another
 * chat or page, the previous one's value must not stand in for the new one's
 * (a Stage list of the previous chat submitted with the new chat's id).
 */
export function currentFor<T>(s: StreamedSnapshot<T>, key: string | null): T | null {
  return s.key === key ? s.current : null;
}

/** The failure if it happened for `key`, else null. */
export function errorFor<T>(s: StreamedSnapshot<T>, key: string | null): string | null {
  return s.key === key ? s.error : null;
}

/** True until a value or failure for `key` arrived. */
export function pendingFor<T>(s: StreamedSnapshot<T>, key: string | null): boolean {
  return s.loading || s.key !== key;
}

/**
 * The page the editor should show after a load: the one the load opened,
 * when the load was asked for the shown page (`requested`, its `?page=`)
 * and opened another one (the shown page is gone from this chat's view,
 * e.g. the AI deleted it). Null = keep the shown page.
 */
export function pageToFollow(
  requested: string | null,
  shown: string,
  opened: string | null,
): string | null {
  if (shown === "" || requested !== shown || opened === shown) return null;
  return opened ?? "";
}
