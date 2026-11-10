// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — what a redirect tool's result ends with: where each saved rule is
 * served. A save is a pending change (docs/dev/redirects-and-settings-sync.md):
 *
 * - Staged: the staging site serves it within seconds — the staging gateway
 *   answers the staging view against the staged build (#1330), on every
 *   provider — and the live site with the next Publish live. A rule whose
 *   target the staged build does not have yet waits for its target, on
 *   staging and at Publish live.
 * - Draft: served nowhere until it is included.
 * - Live after approval: a Go live now proposal is waiting for its card.
 *
 * The live site never changes on a save, so no line says "live now"; the
 * production lines speak only of a push that failed (a release or Go live
 * now left the hosting behind).
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { RedirectSyncTargetStatus } from "../../ops/redirect_sync.js";
import type { RedirectReleasePlan } from "../../ops/redirects_release.js";
import { describeError } from "./_describe-error.js";
import type { ToolContext } from "./dispatch.js";

/** How many paths to name per line before summarising. */
const SHOWN = 5;

/** What a redirect write reported per rule (the ops' `changes`). */
export interface SavedRedirectChange {
  readonly fromPath: string;
  readonly outcome: "pending" | "unchanged";
  readonly state: "draft" | "staged" | null;
  readonly replaced: string | null;
}

function paths(list: readonly string[]): string {
  const shown = list.slice(0, SHOWN).join(", ");
  return list.length > SHOWN ? `${shown}, … (${list.length} in all)` : shown;
}

/**
 * The note for `changes`, one line per kind of outcome, each with a leading
 * newline; read `redirects.release_plan` for the Staged ones (which wait
 * for their target) and `redirects.sync_status` for a production push that
 * failed.
 */
export async function redirectSyncNote(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  changes: readonly SavedRedirectChange[],
): Promise<string> {
  const staged = changes.filter((c) => c.outcome === "pending" && c.state === "staged");
  let plan: RedirectReleasePlan | null = null;
  let planError: string | null = null;
  if (staged.length > 0) {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "redirects.release_plan", {});
    if (r.ok) plan = r.value as RedirectReleasePlan;
    else planError = describeError(r.error);
  }
  const status = await execute(toolCtx.registry, toolCtx.adapter, ctx, "redirects.sync_status", {});
  const targets = status.ok
    ? (status.value as { targets: RedirectSyncTargetStatus[] }).targets
    : null;
  return describeSavedRedirects(changes, plan, planError, targets);
}

/**
 * The lines of {@link redirectSyncNote}, from what it read. Exported for the
 * unit tests: the staging line must tell the truth on every provider.
 */
export function describeSavedRedirects(
  changes: readonly SavedRedirectChange[],
  plan: RedirectReleasePlan | null,
  planError: string | null,
  targets: readonly RedirectSyncTargetStatus[] | null,
): string {
  const lines: string[] = [];
  const staged = changes.filter((c) => c.outcome === "pending" && c.state === "staged");
  const drafts = changes.filter((c) => c.outcome === "pending" && c.state === "draft");
  const unchanged = changes.filter((c) => c.outcome === "unchanged");
  if (staged.length > 0) {
    if (plan === null || plan.problem !== null) {
      const why = planError ?? plan?.problem ?? "";
      lines.push(
        `Staged: ${paths(staged.map((c) => c.fromPath))}. Staging serves them against the staged build once it can be read${why ? ` (${why})` : ""}; the live site gets them with the next Publish live.`,
      );
    } else {
      const waiting = new Map(plan.waiting.map((w) => [w.fromPath, w]));
      const served = staged.filter((c) => !waiting.has(c.fromPath));
      const late = staged.filter((c) => waiting.has(c.fromPath));
      if (served.length > 0) {
        lines.push(
          `Staged, on staging now: ${paths(served.map((c) => c.fromPath))}. The live site gets them with the next Publish live.`,
        );
      }
      if (late.length > 0) {
        lines.push(
          `Staged, waiting for their target: ${paths(
            late.map((c) => `${c.fromPath} -> ${waiting.get(c.fromPath)?.toPath ?? "?"}`),
          )}. The staged build has no page there yet, so staging keeps the old answer; they go live with the Publish live that ships those pages (publish the page, Stage, Publish live).`,
        );
      }
    }
  }
  if (drafts.length > 0) {
    lines.push(
      `Draft, served nowhere: ${paths(drafts.map((c) => c.fromPath))}. Publish live leaves them out until they are included (update_redirect_changes, action include).`,
    );
  }
  if (unchanged.length > 0) {
    lines.push(
      `Already live as asked, nothing pending: ${paths(unchanged.map((c) => c.fromPath))}.`,
    );
  }
  for (const c of changes) if (c.replaced) lines.push(`Replaced: ${c.replaced}.`);
  if (staged.length + drafts.length > 0) {
    lines.push("The live site is unchanged until Publish live.");
  }
  if (targets === null) {
    lines.push("Hosting status unknown.");
  } else {
    for (const t of targets) {
      const line = describeRedirectSyncTarget(t);
      if (line !== null) lines.push(line);
    }
  }
  return lines.map((l) => `\n${l}`).join("");
}

/**
 * #1550 — what the next Publish live does to the redirects, for
 * `get_publish_gate` and `list_unpublished_changes`: the pending changes
 * going live, waiting for their target, and staying in Draft. "" when
 * nothing is pending; a leading newline otherwise.
 */
export async function redirectReleaseNote(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
): Promise<string> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "redirects.release_plan", {});
  if (!r.ok) return `\nRedirect changes unknown: ${describeError(r.error)}`;
  return describeReleasePlan(r.value as RedirectReleasePlan);
}

const ruleOf = (c: RedirectReleasePlan["goingLive"][number]): string =>
  c.toPath === null ? `${c.fromPath} (remove)` : `${c.fromPath} -> ${c.toPath}`;

/** The lines of {@link redirectReleaseNote}. Exported for the unit tests. */
export function describeReleasePlan(plan: RedirectReleasePlan): string {
  const { goingLive, waiting, draft } = plan;
  if (goingLive.length + waiting.length + draft.length === 0 && plan.problem === null) return "";
  const lines = ["Redirect changes with the next Publish live:"];
  if (plan.problem !== null) lines.push(`- cannot be told yet: ${plan.problem}`);
  if (goingLive.length > 0) {
    lines.push(`- going live (${goingLive.length}): ${paths(goingLive.map(ruleOf))}`);
  }
  if (waiting.length > 0) {
    lines.push(
      `- waiting for their target, stay Staged (${waiting.length}): ${paths(
        waiting.map(
          (w) =>
            `${ruleOf(w)} (${w.reason === "page" ? "the page is not at that URL in the staged build yet" : "not in the staged build"})`,
        ),
      )}`,
    );
  }
  if (draft.length > 0) {
    lines.push(`- staying in Draft (${draft.length}): ${paths(draft.map(ruleOf))}`);
  }
  return `\n${lines.join("\n")}`;
}

/**
 * One production target's line, or null when its hosting serves the live
 * redirects as recorded (nothing to say: a save changes nothing there).
 * Exported for the unit tests.
 */
export function describeRedirectSyncTarget(t: RedirectSyncTargetStatus): string | null {
  const name = `${t.targetName} (${t.env})`;
  if (!t.inSync) {
    return t.lastError
      ? `${name}: the live redirects are NOT on the hosting yet — the last push failed: ${t.lastError}. Retried automatically; tell the operator, and fix the redirects if the error names them.`
      : `${name}: the live redirects are NOT on the hosting yet — the push is pending and retried automatically.`;
  }
  return goneNote(t);
}

/**
 * #1357 — a 410 rule on a host that cannot send 410 answers 404: say so, so
 * the AI tells the operator instead of reporting the rule as stored.
 */
function goneNote(t: RedirectSyncTargetStatus): string | null {
  const gone = t.last?.goneCount ?? 0;
  if (gone === 0 || t.goneAnswer === 410) return null;
  const rules = gone === 1 ? "1 live 410 rule answers" : `${gone} live 410 rules answer`;
  return `${t.targetName} (${t.env}): ${rules} 404 on this hosting, not 410 Gone: it cannot send a bare 410. Search engines drop a 404 too, only more slowly; tell the operator if they asked for 410.`;
}
