// SPDX-License-Identifier: MPL-2.0

/**
 * What a staged page's plugin call gets until staging has its own gateway
 * (#1326 interim, #1329/#1330; epic #763 N4).
 *
 * The live gateway takes plugin posts only from a live-site Origin, and
 * staging is never one: unreviewed module JS on staging must not write
 * into live data. A plain 403 would make every staged page with a plugin
 * component log "Failed to load resource" in the browser console, which the
 * Stage quality audit counts as a page error and which would then block
 * Publish live. So the two places a staged page's `/api/plugin/*` call can
 * reach answer it with this instead, without dispatching anything:
 *
 *   - the API gateway, for a POST whose Origin is the staging host
 *     (gcp-firebase, self-hosted: staging's `/api` reaches the live gateway);
 *   - the audit's loopback origin (admin-core `quality/staged-origin.ts`,
 *     gcp / aws / azure), which no longer forwards plugin calls to live.
 *
 * HTTP 200 with `ok: false`: the browser logs nothing, and the component
 * takes its ordinary "no data" / "failed" path (plugin-component-kit
 * `postPluginJson` callers all read `ok`).
 */

/** The error kind a staged page's plugin call answers with. */
export const STAGING_PREVIEW_ERROR_KIND = "StagingPreview";

/** The JSON body of that answer. */
export const STAGING_PLUGIN_STUB_BODY = JSON.stringify({
  ok: false,
  error: { kind: STAGING_PREVIEW_ERROR_KIND },
});

/** Whether `pathname` is a plugin operation call (`/api/plugin/…`). */
export function isPluginCallPath(pathname: string): boolean {
  return pathname.startsWith("/api/plugin/");
}
