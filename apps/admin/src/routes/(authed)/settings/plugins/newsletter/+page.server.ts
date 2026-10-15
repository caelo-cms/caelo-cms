// SPDX-License-Identifier: MPL-2.0

import { runPluginOperation } from "@caelo-cms/plugin-host";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import type { Actions, PageServerLoad } from "./$types";

interface CampaignRow {
  id: string;
  slug: string;
  subject: string;
  status: string;
  created_at: string;
  sent_at: string | null;
  approvedSend: { status: string; recipientCount: number; processed: number } | null;
}

/** A draft as the Owner reviews it before approving its send (#635). */
interface CampaignReview {
  id: string;
  subject: string;
  bodyHtml: string;
  status: string;
  recipientCount: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const load: PageServerLoad = async ({ locals, url }) => {
  requirePermission(locals, "settings.write");
  const invocation = { origin: "owner-panel" as const, actorId: locals.ctx.actorId };
  const r = await runPluginOperation({
    invocation,
    pluginSlug: "newsletter",
    operationName: "list_campaigns",
    args: {},
  });
  const v = r.ok
    ? (r.value as { campaigns: CampaignRow[]; subscriberCount: number })
    : { campaigns: [] as CampaignRow[], subscriberCount: null };
  // The send form carries exactly what this review shows: the Owner
  // approves that content and that recipient bound, and only that is sent.
  const reviewId = url.searchParams.get("review");
  let review: CampaignReview | null = null;
  let reviewError: string | null = null;
  if (reviewId !== null) {
    if (!UUID_RE.test(reviewId)) {
      reviewError = "Not a campaign id.";
    } else {
      const got = await runPluginOperation({
        invocation,
        pluginSlug: "newsletter",
        operationName: "get_campaign",
        args: { campaignId: reviewId },
      });
      if (got.ok) review = got.value as CampaignReview;
      else reviewError = got.error.message;
    }
  }
  return {
    campaigns: v.campaigns,
    subscriberCount: v.subscriberCount as number | null,
    error: r.ok ? null : r.error.message,
    review,
    reviewError,
  };
};

export const actions: Actions = {
  draft: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const slug = form.get("slug");
    const subject = form.get("subject");
    const brief = form.get("brief");
    if (typeof slug !== "string" || typeof subject !== "string" || typeof brief !== "string") {
      return fail(400, { error: "slug + subject + brief required" });
    }
    const r = await runPluginOperation({
      invocation: { origin: "owner-panel", actorId: locals.ctx.actorId },
      pluginSlug: "newsletter",
      operationName: "draft_campaign",
      args: { slug, subject, brief },
    });
    if (!r.ok) return fail(400, { error: r.error.message });
    return { ok: true, message: "Draft created — visit Campaigns to send." };
  },
  send: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const campaignId = form.get("campaignId");
    const subject = form.get("subject");
    const bodyHtml = form.get("bodyHtml");
    const recipientCount = Number(form.get("recipientCount"));
    if (
      typeof campaignId !== "string" ||
      typeof subject !== "string" ||
      typeof bodyHtml !== "string" ||
      !Number.isInteger(recipientCount)
    ) {
      return fail(400, { error: "Review the campaign first, then send it from the review." });
    }
    // The plugin validates the shape and refuses a draft that changed
    // since this review was rendered.
    const r = await runPluginOperation({
      invocation: { origin: "owner-panel", actorId: locals.ctx.actorId },
      pluginSlug: "newsletter",
      operationName: "send_campaign",
      args: { campaignId, subject, bodyHtml, recipientCount },
    });
    if (!r.ok) return fail(400, { error: r.error.message });
    const v = r.value as { queued: number };
    return { ok: true, message: `Approved: ${v.queued} emails go out within a few minutes.` };
  },
};
