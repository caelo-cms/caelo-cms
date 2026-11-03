// SPDX-License-Identifier: MPL-2.0

/**
 * #1157 — the line a redirect tool's result ends with: where the saved
 * redirects are live. A redirects write pushes the table to the hosting
 * provider before it returns (deploy/redirect-sync.ts), so the AI can tell
 * the operator "live now" truthfully — or exactly why not.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { RedirectSyncTargetStatus } from "../../ops/redirect_sync.js";
import { describeError } from "./_describe-error.js";
import type { ToolContext } from "./dispatch.js";

/** How many not-yet-published targets to name before summarising. */
const UNSERVED_SHOWN = 5;

/** Read `redirects.sync_status` and phrase it for the AI. */
export async function redirectSyncNote(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
): Promise<string> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "redirects.sync_status", {});
  if (!r.ok) return `Live status unknown: ${describeError(r.error)}`;
  const targets = (r.value as { targets: RedirectSyncTargetStatus[] }).targets;
  if (targets.length === 0)
    return "No staging or production target exists, so nothing serves redirects yet.";
  return targets.map(describeRedirectSyncTarget).join("\n");
}

/** One target's line of {@link redirectSyncNote}. Exported for the unit tests. */
export function describeRedirectSyncTarget(t: RedirectSyncTargetStatus): string {
  const name = `${t.targetName} (${t.env})`;
  if (!t.inSync) {
    return t.lastError
      ? `${name}: NOT live yet — the push to hosting failed: ${t.lastError}. Retried automatically; tell the operator, and fix the redirects if the error names them.`
      : `${name}: NOT live yet — the push to hosting is pending and retried automatically.`;
  }
  const last = t.last;
  if (last === null || last.status === "nothing-live") {
    return `${name}: nothing published there yet; the redirects go live with its first publish.`;
  }
  if (last.status === "not-served") {
    return `${name}: this hosting serves no redirects on ${t.env}; they apply on production.`;
  }
  const unserved = last.unservedTargets;
  const pending =
    unserved.length === 0
      ? ""
      : ` ${unserved.length} point at pages not published yet (answer 404 until Publish live): ${unserved
          .slice(0, UNSERVED_SHOWN)
          .map((u) => `${u.fromPath} -> ${u.location}`)
          .join(", ")}${unserved.length > UNSERVED_SHOWN ? ", …" : ""}.`;
  return `${name}: live now (no build or Publish live needed).${pending}${goneNote(t)}`;
}

/**
 * #1357 — a 410 rule on a host that cannot send 410 answers 404: say so, so
 * the AI tells the operator instead of reporting the rule live as stored.
 */
function goneNote(t: RedirectSyncTargetStatus): string {
  const gone = t.last?.goneCount ?? 0;
  if (gone === 0 || t.goneAnswer === 410) return "";
  const rules = gone === 1 ? "1 410 rule answers" : `${gone} 410 rules answer`;
  return ` ${rules} 404 on this hosting, not 410 Gone: it cannot send a bare 410. Search engines drop a 404 too, only more slowly; tell the operator if they asked for 410.`;
}
