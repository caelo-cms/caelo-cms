// SPDX-License-Identifier: MPL-2.0

import { CSRF_DEPENDENCY, freshestCsrfToken } from "#lib/csrf-refresh.js";
import { browser } from "$app/env";
import type { LayoutLoad } from "./$types";

/**
 * Carries the server load's data through, with the CSRF form token swapped
 * for a newer one the tab fetched since (#lib/csrf-refresh.ts). Invalidating
 * CSRF_DEPENDENCY reruns only this in-browser load, so refreshing the token
 * runs no server load and makes no request. On the server the data passes
 * through untouched: the fetched token lives in browser module state.
 */
export const load: LayoutLoad = ({ data, depends }) => {
  depends(CSRF_DEPENDENCY);
  return browser ? { ...data, csrfToken: freshestCsrfToken(data.csrfToken) } : data;
};
