// SPDX-License-Identifier: MPL-2.0

/**
 * Keeping the running plugin host in step with committed plugin rows
 * (issue #585).
 *
 * The plugin ops change a plugin's state in cms_admin (activate, disable,
 * revoke a grant) AND in the running process (tools catalogue, worker
 * scheduler, dispatch flag). The process half must follow the commit, not
 * precede it: run inside the transaction, a rollback would leave the host
 * disabled while the row still says active — or worse, running a plugin
 * the database never activated. These helpers register the host change as
 * a post-commit effect of the op's own transaction, so it happens exactly
 * when the row change becomes real, and a failure surfaces as a loud
 * error + failed audit row instead of a silent divergence.
 */

import {
  applyPluginLifecycle,
  deregisterPlugin,
  type PluginLifecycleAction,
} from "@caelo-cms/plugin-host";
import { afterCommit, type TransactionRunner } from "@caelo-cms/query-api";

/** Apply `disable` / `enable` to the running host once `tx` commits. */
export function afterPluginCommit(
  tx: TransactionRunner,
  slug: string,
  pluginId: string,
  action: PluginLifecycleAction,
): void {
  afterCommit(tx, {
    label:
      action === "disable"
        ? `stop plugin "${slug}" in the running server`
        : `resume plugin "${slug}" in the running server`,
    entityId: pluginId,
    run: () => applyPluginLifecycle(slug, action),
  });
}

/** Remove an uninstalled plugin from every host registry once `tx` commits. */
export function afterPluginUninstallCommit(
  tx: TransactionRunner,
  slug: string,
  pluginId: string,
): void {
  afterCommit(tx, {
    label: `remove plugin "${slug}" from the running server`,
    entityId: pluginId,
    run: () => deregisterPlugin(slug),
  });
}
