// SPDX-License-Identifier: MPL-2.0

import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { parseRobotsRulesText, type RobotsRules, robotsRulesText } from "@caelo-cms/shared";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requireApproverPermission, requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

/** What `site_defaults.get_seo` answers, as this page reads it. */
interface SeoSettings {
  siteBaseUrl: string | null;
  sitemapEnabled: boolean;
  feedEnabled: boolean;
  indexNowEnabled: boolean;
  organizationJson: Record<string, unknown>;
  /** #1706 — the Owner's robots.txt rules and the live file they make. */
  robotsRules: RobotsRules;
  robotsTxt: string | null;
  robotsWarnings: string[];
  searchNotifications: {
    id: string;
    channel: "websub" | "indexnow";
    status: "pending" | "sent" | "failed" | "skipped";
    urlCount: number;
    detail: string | null;
    createdAt: string;
  }[];
}

/**
 * P8 — Owner-only SEO dashboard. Site-level base URL + sitemap, feed and
 * IndexNow toggles + Organization JSON-LD editor + robots.txt rules
 * (#1706) + the latest search engine
 * notifications + the stale-SEO queue. Owner-proxy via
 * `roles.manage` until the permission catalogue grows an explicit
 * `seo.settings` entry.
 */
export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "roles.manage");
  const { adapter, registry } = getQueryContext();
  const settings = await execute(registry, adapter, locals.ctx, "site_defaults.get_seo", {});
  const stale = await execute(registry, adapter, locals.ctx, "pages_seo.list_stale", {
    limit: 50,
  });
  // The site language lives on the identity half of site_defaults
  // (written by site_defaults.set_identity, which the AI can call too).
  const defaults = await execute(registry, adapter, locals.ctx, "site_defaults.get", {});
  // AI proposals (propose_set_site_seo) waiting for the Owner. A chat
  // approves them inline; a Power-MCP caller has no in-chat card, so its
  // proposals are approved here.
  const pending = await execute(registry, adapter, locals.ctx, "site_defaults.list_pending", {});
  // Null = not configured (migration 0232 dropped the `en` default); the
  // page shows that state, and publishing fails until it is set.
  const defaultsRow = defaults.ok
    ? (defaults.value as { defaults: { siteLanguage: string | null } | null }).defaults
    : null;
  const siteLanguage = defaultsRow?.siteLanguage ?? null;
  const siteLanguageError = !defaults.ok
    ? `site_defaults.get failed: ${describeError(defaults.error)}`
    : defaultsRow === null
      ? "site_defaults row is missing — set the default layout + template at /settings/site-defaults first."
      : null;
  return {
    pendingProposals: pending.ok
      ? (
          pending.value as {
            proposals: {
              id: string;
              createdAt: string;
              preview: { changes?: Record<string, { from: unknown; to: unknown }> };
            }[];
          }
        ).proposals
      : [],
    pendingError: pending.ok
      ? null
      : `site_defaults.list_pending failed: ${describeError(pending.error)}`,
    siteLanguage,
    siteLanguageError,
    settingsError: settings.ok
      ? null
      : `site_defaults.get_seo failed: ${describeError(settings.error)}`,
    settings: settings.ok
      ? (settings.value as SeoSettings)
      : {
          siteBaseUrl: null,
          sitemapEnabled: false,
          feedEnabled: false,
          indexNowEnabled: false,
          organizationJson: {},
          robotsRules: [],
          robotsTxt: null,
          robotsWarnings: [],
          searchNotifications: [],
        },
    robotsRulesText: settings.ok
      ? robotsRulesText((settings.value as SeoSettings).robotsRules)
      : "",
    stale: stale.ok
      ? (
          stale.value as {
            pages: {
              pageId: string;
              slug: string;
              title: string;
              autofilledAt: string | null;
              optimizedAt: string | null;
              metaDescription: string;
            }[];
          }
        ).pages
      : [],
  };
};

export const actions: Actions = {
  saveSettings: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const siteBaseUrl = String(form.get("siteBaseUrl") ?? "");
    const sitemapEnabled = form.get("sitemapEnabled") === "on";
    const feedEnabled = form.get("feedEnabled") === "on";
    const indexNowEnabled = form.get("indexNowEnabled") === "on";
    const organizationJsonRaw = String(form.get("organizationJson") ?? "{}");
    let organizationJson: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(organizationJsonRaw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return fail(400, { error: "organizationJson must be a JSON object" });
      }
      organizationJson = parsed as Record<string, unknown>;
    } catch {
      return fail(400, { error: "organizationJson is not valid JSON" });
    }
    const r = await execute(registry, adapter, locals.ctx, "site_defaults.set_seo", {
      siteBaseUrl,
      sitemapEnabled,
      feedEnabled,
      indexNowEnabled,
      organizationJson,
    });
    if (!r.ok) {
      const message =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "save failed";
      return fail(400, { error: message });
    }
    return { ok: true, message: "Saved." };
  },
  // `approve` / `reject` are the standard pending-queue action names: the
  // chat's pending strip posts here for site_defaults proposals.
  approve: async ({ request, locals }) => {
    requireApproverPermission(locals, getQueryContext().registry, "site_defaults.execute_proposal");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const r = await execute(registry, adapter, locals.ctx, "site_defaults.execute_proposal", {
      proposalId: String(form.get("proposalId") ?? ""),
    });
    if (!r.ok) return fail(400, { error: describeError(r.error) });
    return { ok: true, message: "Proposal approved — the SEO settings are updated." };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const reason = String(form.get("reason") ?? "").trim();
    const r = await execute(registry, adapter, locals.ctx, "site_defaults.reject_proposal", {
      proposalId: String(form.get("proposalId") ?? ""),
      ...(reason ? { reason } : {}),
    });
    if (!r.ok) return fail(400, { error: describeError(r.error) });
    return { ok: true, message: "Proposal rejected." };
  },
  saveLanguage: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const siteLanguage = String(form.get("siteLanguage") ?? "").trim();
    const r = await execute(registry, adapter, locals.ctx, "site_defaults.set_identity", {
      siteLanguage,
    });
    if (!r.ok) return fail(400, { error: describeError(r.error) });
    return { ok: true, message: "Site language saved." };
  },
  // #1706 — the robots.txt rules, written as robots.txt lines and checked
  // strictly; the other settings stay as they are stored.
  saveRobots: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const text = String(form.get("robotsRules") ?? "");
    const parsed = parseRobotsRulesText(text);
    if (!parsed.ok)
      return fail(400, { error: `robots.txt rules: ${parsed.message}`, robotsRulesText: text });
    const current = await execute(registry, adapter, locals.ctx, "site_defaults.get_seo", {});
    if (!current.ok)
      return fail(400, { error: describeError(current.error), robotsRulesText: text });
    const s = current.value as SeoSettings;
    if (s.siteBaseUrl === null) {
      return fail(400, {
        error: "Set the site base URL first: robots.txt is published at that address.",
        robotsRulesText: text,
      });
    }
    const r = await execute(registry, adapter, locals.ctx, "site_defaults.set_seo", {
      siteBaseUrl: s.siteBaseUrl,
      sitemapEnabled: s.sitemapEnabled,
      feedEnabled: s.feedEnabled,
      indexNowEnabled: s.indexNowEnabled,
      organizationJson: s.organizationJson,
      robotsRules: parsed.rules,
    });
    if (!r.ok) return fail(400, { error: describeError(r.error), robotsRulesText: text });
    return {
      ok: true,
      message:
        "robots.txt rules saved. They reach the live site with the next Stage and Publish live; staging keeps every crawler out.",
    };
  },
};
