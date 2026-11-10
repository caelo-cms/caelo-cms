// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1361 — what the plugin host does at the start of every admin
 * request.
 *
 * The admin runs on request-billed CPU (CLAUDE.md §11.B): it gets CPU only
 * while it serves a request, so the plugin host keeps nothing current on a
 * timer. Every request instead begins with this, the scheduler tick's
 * request included:
 *
 *   - follow the plugin decisions made through any instance
 *     ({@link syncPluginHost}: throttled, reconciles only when the plugin
 *     rows changed), so the request renders and dispatches on the
 *     database's plugin state;
 *   - confirm this instance's plugin runtime rows once their heartbeat is
 *     older than `HEARTBEAT_REFRESH_MS` ({@link refreshRuntimeHeartbeat}),
 *     so health keeps counting a server that serves;
 *   - start the change-consumer drain a retry asked for once it is due
 *     ({@link resumeDueChangeConsumers}), without waiting for it.
 *
 * Never throws: each step logs its own failure, and the next request tries
 * again.
 */

import { resumeDueChangeConsumers } from "./change-consumers.js";
import { syncPluginHost } from "./reconcile.js";
import { refreshRuntimeHeartbeat } from "./runtime-health.js";

/** Run the plugin host's part of an admin request's start (see the module docblock). */
export async function pluginHostRequestStart(): Promise<void> {
  await syncPluginHost();
  await refreshRuntimeHeartbeat();
  resumeDueChangeConsumers();
}
