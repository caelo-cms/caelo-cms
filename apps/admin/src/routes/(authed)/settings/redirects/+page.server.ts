// SPDX-License-Identifier: MPL-2.0

/**
 * Settings → Redirects. #1550 — redirects are draft state: every rule with
 * its state (Live, Draft, Staged, Change staged, Removal staged), paged by
 * cursor with a total and a server-side search (#1540), the row actions
 * (Include in next publish, Keep as draft, Go live now, Discard change) and
 * the new-redirect form's choice of when it goes live. A save changes
 * nothing on the live site; Go live now is the one path past Publish live,
 * for someone with the Publish live permission.
 */

import type {
  RedirectReleasePlan,
  RedirectRule,
  RedirectSyncTargetStatus,
} from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { isExternalRedirectTarget, redirectTargetIssue } from "@caelo-cms/shared";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import {
  holdsApproverPermission,
  requireApproverPermission,
  requirePermission,
} from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import {
  approveRedirectProposal,
  goLiveNow,
  listRedirectProposals,
  messageOf,
  rejectRedirectProposal,
} from "#lib/server/redirect-proposals.js";
import type { Actions, PageServerLoad } from "./$types";

/** Rules per page. */
const PAGE_SIZE = 50;

const STATES = ["all", "staged", "draft"] as const;
type ListState = (typeof STATES)[number];

export const load: PageServerLoad = async ({ locals, url }) => {
  const user = requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 500);
  const stateParam = url.searchParams.get("state");
  const state: ListState = STATES.includes(stateParam as ListState)
    ? (stateParam as ListState)
    : "all";
  const cursor = url.searchParams.get("cursor");
  const listed = await execute(registry, adapter, locals.ctx, "redirects.list", {
    ...(query ? { query } : {}),
    state,
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  });
  if (!listed.ok) throw new Error(`redirects.list failed: ${JSON.stringify(listed.error)}`);
  const page = listed.value as {
    redirects: RedirectRule[];
    totalCount: number;
    nextCursor: string | null;
  };
  // #1157 — where the live redirects stand on the hosting (production).
  const status = await execute(registry, adapter, locals.ctx, "redirects.sync_status", {});
  if (!status.ok) {
    throw new Error(`redirects.sync_status failed: ${JSON.stringify(status.error)}`);
  }
  const syncTargets = (status.value as { targets: RedirectSyncTargetStatus[] }).targets;
  // #1550 — which Staged changes wait for their target in the staged build.
  const plan = await execute(registry, adapter, locals.ctx, "redirects.release_plan", {});
  const release = plan.ok ? (plan.value as RedirectReleasePlan) : null;
  return {
    rules: page.redirects,
    totalCount: page.totalCount,
    nextCursor: page.nextCursor,
    query,
    state,
    waiting: release?.waiting.map((w) => ({ id: w.id, reason: w.reason })) ?? [],
    releaseProblem: plan.ok ? (release?.problem ?? null) : messageOf(plan.error, "unknown"),
    syncTargets,
    liveSite: syncTargets.some((t) => t.live),
    canWrite: user.permissions.has("content.write"),
    canGoLive: user.permissions.has("deploy.trigger"),
    canApproveExternal: holdsApproverPermission(locals, registry, "redirects.execute_proposal"),
    canApproveGoLive: holdsApproverPermission(locals, registry, "redirects.execute_go_live"),
    proposals: await listRedirectProposals(locals),
  };
};

/** The from paths a row action names (one or more `fromPath` fields). */
function fromPathsOf(form: FormData): string[] {
  return form
    .getAll("fromPath")
    .map((v) => String(v).trim())
    .filter((v) => v.startsWith("/"));
}

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const fromPath = String(form.get("fromPath") ?? "").trim();
    const toPath = String(form.get("toPath") ?? "").trim();
    const statusCodeRaw = Number(form.get("statusCode") ?? "301");
    const statusCode: 301 | 302 | 307 | 308 =
      statusCodeRaw === 302 || statusCodeRaw === 307 || statusCodeRaw === 308 ? statusCodeRaw : 301;
    const when = String(form.get("goLive") ?? "next_publish");
    const goLive = when === "later" || when === "now" ? when : "next_publish";
    if (!fromPath.startsWith("/")) {
      return fail(400, { error: "fromPath must start with /" });
    }
    if (goLive === "now") requirePermission(locals, "deploy.trigger");
    // #1358 — a target on another domain: the same two ops as the AI's
    // proposal, approved in one go by whoever may approve it.
    if (isExternalRedirectTarget(toPath)) {
      requireApproverPermission(locals, registry, "redirects.execute_proposal");
      if (goLive === "later") {
        return fail(400, {
          error:
            "A redirect to another website is saved with the next Publish live or now; it cannot wait as a draft.",
        });
      }
      // No choice made: the op's default (temporary) for an address that
      // can change, not this form's permanent one for a page on the site.
      const chosen = form.get("statusCode") ? { statusCode } : {};
      const proposed = await execute(registry, adapter, locals.ctx, "redirects.propose_external", {
        redirects: [{ fromPath, url: toPath, ...chosen }],
        goLive,
      });
      if (!proposed.ok) return fail(400, { error: messageOf(proposed.error, "create failed") });
      const applied = await execute(registry, adapter, locals.ctx, "redirects.execute_proposal", {
        proposalId: (proposed.value as { proposalId: string }).proposalId,
      });
      if (!applied.ok) return fail(400, { error: messageOf(applied.error, "create failed") });
      if (goLive === "now") {
        const refused = await goLiveNow(locals, [fromPath]);
        if (refused) {
          return fail(409, {
            error: `Redirect ${fromPath} → ${toPath} is saved and goes live with the next Publish live, but it could not go live now: ${refused}`,
          });
        }
        return { ok: true, message: `Redirect ${fromPath} → ${toPath} is live on your site now.` };
      }
      return {
        ok: true,
        message: `Redirect ${fromPath} → ${toPath} created. ${(applied.value as { nextStep: string }).nextStep}`,
      };
    }
    // Same rule as the op's schema, surfaced here so the form shows the
    // specific reason (e.g. a pasted full URL) instead of a generic 400.
    const targetIssue = redirectTargetIssue(toPath);
    if (targetIssue) {
      return fail(400, { error: targetIssue });
    }
    const r = await execute(registry, adapter, locals.ctx, "redirects.create", {
      fromPath,
      toPath,
      statusCode,
      goLive: goLive === "later" ? "later" : "next_publish",
    });
    if (!r.ok) return fail(400, { error: messageOf(r.error, "create failed") });
    const change = (r.value as { change: { outcome: string; replaced: string | null } }).change;
    // #1447 — a page at this URL replaces the redirect once it is published
    // (it may still be a draft); say so now rather than at the next Stage.
    const onPages = await execute(registry, adapter, locals.ctx, "redirects.page_conflicts", {
      paths: [fromPath],
    });
    if (!onPages.ok) {
      throw new Error(`redirects.page_conflicts failed: ${JSON.stringify(onPages.error)}`);
    }
    const page = (onPages.value as { conflicts: { pageTitle: string }[] }).conflicts[0];
    const pageNote = page
      ? ` The page "${page.pageTitle}" uses this URL: once it is published, visitors see it instead of the redirect. Remove the redirect or move the page.`
      : "";
    const replacedNote = change.replaced ? ` (${change.replaced})` : "";
    if (change.outcome === "unchanged") {
      return { ok: true, message: `Redirect ${fromPath} → ${toPath} is already live as it is.` };
    }
    if (goLive === "now") {
      const refused = await goLiveNow(locals, [fromPath]);
      if (refused) {
        return fail(409, {
          error: `Redirect ${fromPath} → ${toPath} is saved and goes live with the next Publish live, but it could not go live now: ${refused}`,
        });
      }
      return {
        ok: true,
        message: `Redirect ${fromPath} → ${toPath} is live on your site now.${pageNote}`,
      };
    }
    return {
      ok: true,
      message:
        goLive === "later"
          ? `Redirect ${fromPath} → ${toPath} saved as a draft: served nowhere until you include it in the next publish.${replacedNote}${pageNote}`
          : `Redirect ${fromPath} → ${toPath} saved: staging serves it now, your live site with the next Publish live.${replacedNote}${pageNote}`,
    };
  },
  include: async ({ request, locals }) => setState(request, locals, "include"),
  keepAsDraft: async ({ request, locals }) => setState(request, locals, "keep_as_draft"),
  discard: async ({ request, locals }) => setState(request, locals, "discard"),
  goLive: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const fromPaths = fromPathsOf(form);
    if (fromPaths.length === 0) return fail(400, { error: "fromPath missing" });
    const refused = await goLiveNow(locals, fromPaths);
    if (refused) return fail(409, { error: refused });
    return { ok: true, message: `${fromPaths.join(", ")}: live on your site now.` };
  },
  approve: async ({ request, locals }) => {
    const form = await request.formData();
    return approveRedirectProposal(locals, form, String(form.get("proposalId") ?? ""));
  },
  reject: async ({ request, locals }) => {
    const form = await request.formData();
    return rejectRedirectProposal(locals, form, String(form.get("proposalId") ?? ""));
  },
  sync: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const targetId = String(form.get("targetId") ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(targetId)) return fail(400, { error: "targetId missing" });
    const r = await execute(registry, adapter, locals.ctx, "redirects.sync_provider", {
      trigger: "manual",
      targetIds: [targetId],
    });
    if (!r.ok) return fail(500, { error: messageOf(r.error, "sync failed") });
    const failed = (
      r.value as { targets: { targetName: string; status: string; error: string | null }[] }
    ).targets.filter((t) => t.status === "failed");
    if (failed.length > 0) {
      return fail(502, {
        error: `Still not live: ${failed.map((t) => `${t.targetName}: ${t.error}`).join("; ")}`,
      });
    }
    return { ok: true, message: "The live redirects are on your hosting." };
  },
  delete: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const redirectId = String(form.get("redirectId") ?? "");
    const r = await execute(registry, adapter, locals.ctx, "redirects.delete", { redirectId });
    if (!r.ok) return fail(400, { error: messageOf(r.error, "delete failed") });
    return {
      ok: true,
      message:
        "Removal saved: staging stops redirecting now, your live site with the next Publish live.",
    };
  },
};

/** Include / Keep as draft / Discard change (redirects.set_changes_state). */
async function setState(
  request: Request,
  locals: App.Locals,
  action: "include" | "keep_as_draft" | "discard",
) {
  requirePermission(locals, "content.write");
  const form = await request.formData();
  await assertCsrfToken(form, locals);
  const fromPaths = fromPathsOf(form);
  if (fromPaths.length === 0) return fail(400, { error: "fromPath missing" });
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "redirects.set_changes_state", {
    fromPaths,
    action,
  });
  if (!r.ok) return fail(400, { error: messageOf(r.error, "change failed") });
  return {
    ok: true,
    message:
      action === "include"
        ? "Included: staging serves it now, your live site with the next Publish live."
        : action === "keep_as_draft"
          ? "Kept as a draft: served nowhere until you include it."
          : "Change discarded: the live redirect stays as it is.",
  };
}
