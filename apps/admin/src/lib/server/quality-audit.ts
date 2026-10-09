// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the staging-deploy actions' hook into the quality gate.
 * Every action that builds staging OUTSIDE a chat Stage (Ops → Deploy, the
 * pages list's Stage of one page) calls `enqueueStagingAudit` once the
 * build succeeded. Chat Stages run the whole flow — pre-merge
 * classification included — through admin-core's `stageChatSessions`.
 */

import { enqueueStagingAudit as enqueueWithDeps } from "@caelo-cms/admin-core";
import type { ExecutionContext } from "@caelo-cms/shared";
import { getQueryContext } from "./query.js";

/**
 * Record the quality audit decision for a succeeded deploy run and wake the
 * worker. Never throws; non-staging targets are ignored.
 *
 * @param args.chatSessionId - always null here (no chat context); chat
 *   Stages enqueue through `stageChatSessions`.
 */
export async function enqueueStagingAudit(
  ctx: ExecutionContext,
  args: {
    readonly deployRunId: string;
    readonly targetName: string;
    readonly chatSessionId: null;
    readonly branch: null;
    /** Pages staged on purpose outside a chat (audited after the homepage). */
    readonly pageIds?: readonly string[];
  },
): Promise<void> {
  const { adapter, registry } = getQueryContext();
  await enqueueWithDeps({ adapter, registry }, ctx, args);
}
