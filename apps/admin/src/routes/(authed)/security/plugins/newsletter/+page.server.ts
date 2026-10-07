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
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const r = await runPluginOperation({
    invocation: { origin: "owner-panel", actorId: locals.ctx.actorId },
    pluginSlug: "newsletter",
    operationName: "list_campaigns",
    args: {},
  });
  const v = r.ok
    ? (r.value as { campaigns: CampaignRow[]; subscriberCount: number })
    : { campaigns: [] as CampaignRow[], subscriberCount: null };
  return {
    campaigns: v.campaigns,
    subscriberCount: v.subscriberCount as number | null,
    error: r.ok ? null : r.error.message,
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
    if (typeof campaignId !== "string") return fail(400, { error: "campaignId required" });
    const r = await runPluginOperation({
      invocation: { origin: "owner-panel", actorId: locals.ctx.actorId },
      pluginSlug: "newsletter",
      operationName: "send_campaign",
      args: { campaignId },
    });
    if (!r.ok) return fail(400, { error: r.error.message });
    const v = r.value as { queued: number };
    return { ok: true, message: `Queued ${v.queued} sends.` };
  },
};
