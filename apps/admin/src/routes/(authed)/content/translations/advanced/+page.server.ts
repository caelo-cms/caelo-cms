// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const localesR = await execute(registry, adapter, locals.ctx, "locales.list", {});
  const jobsR = await execute(registry, adapter, locals.ctx, "translation_jobs.list", {
    status: "any",
    limit: 50,
  });
  const locales = localesR.ok
    ? (localesR.value as { locales: { code: string; displayName: string; isDefault: boolean }[] })
        .locales
    : [];
  const jobs = jobsR.ok
    ? (
        jobsR.value as {
          jobs: {
            id: string;
            status: string;
            totalUnits: number;
            completedUnits: number;
            erroredUnits: number;
            costMicrocents: number;
            capMicrocents: number | null;
            errorSummary: string | null;
            createdAt: string;
          }[];
        }
      ).jobs
    : [];
  return { locales, jobs };
};

export const actions: Actions = {
  bulkLocale: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const code = String(form.get("code") ?? "");
    if (!code) return fail(400, { error: "locale code required" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "translation_jobs.create", {
      scope: { kind: "locale", code },
    });
    if (!r.ok) {
      const m =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "queue failed";
      return fail(400, { error: m });
    }
    const v = r.value as { totalUnits: number };
    return { ok: true, message: `Queued ${v.totalUnits} translation(s) for locale ${code}.` };
  },

  updateCap: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const jobId = String(form.get("jobId") ?? "");
    const usdRaw = form.get("capUsd");
    const usd = usdRaw === null || usdRaw === "" ? null : Number(usdRaw);
    if (usd !== null && !Number.isFinite(usd)) {
      return fail(400, { error: "cap must be a number" });
    }
    const capMicrocents = usd === null ? null : Math.round(usd * 1e8);
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "translation_jobs.update_cap", {
      jobId,
      capMicrocents,
    });
    if (!r.ok) return fail(400, { error: "update_cap failed" });
    return { ok: true, message: "Cap updated." };
  },

  revertJob: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const jobId = String(form.get("jobId") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "translation_jobs.revert", { jobId });
    if (!r.ok) return fail(400, { error: "revert failed" });
    const v = r.value as { deletedVariants: number; needManualRevert: number };
    const parts = [
      `Reverted ${v.deletedVariants} new translation${v.deletedVariants === 1 ? "" : "s"}.`,
    ];
    if (v.needManualRevert > 0) {
      parts.push(
        `${v.needManualRevert} updated translation${v.needManualRevert === 1 ? "" : "s"} need per-page revert via the Advanced History drawer.`,
      );
    }
    return { ok: true, message: parts.join(" ") };
  },

  forceRetranslate: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const pageId = String(form.get("pageId") ?? "");
    const targetLocale = String(form.get("targetLocale") ?? "");
    const { adapter, registry } = getQueryContext();
    // Force: soft-delete the existing variant first (if any), then dispatch Mode 1.
    const variantR = await execute(registry, adapter, locals.ctx, "pages.list", {});
    if (variantR.ok) {
      const pages = (variantR.value as { pages: { id: string; slug: string; locale: string }[] })
        .pages;
      // Find the source slug
      const source = pages.find((p) => p.id === pageId);
      if (source) {
        const variant = pages.find((p) => p.slug === source.slug && p.locale === targetLocale);
        if (variant) {
          await execute(registry, adapter, locals.ctx, "pages.delete", { pageId: variant.id });
        }
      }
    }
    const r = await execute(registry, adapter, locals.ctx, "translation.mode_1", {
      pageId,
      targetLocale,
    });
    if (!r.ok) {
      const m =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "force retranslate failed";
      return fail(400, { error: m });
    }
    return { ok: true, message: `Force-retranslated to ${targetLocale}.` };
  },

  resetTranslationState: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const variantPageId = String(form.get("variantPageId") ?? "");
    if (!variantPageId) return fail(400, { error: "variantPageId required" });
    const { adapter, registry } = getQueryContext();
    // Soft-delete the variant so the next run treats this slug+locale as not_started.
    const r = await execute(registry, adapter, locals.ctx, "pages.delete", {
      pageId: variantPageId,
    });
    if (!r.ok) return fail(400, { error: "reset failed" });
    return {
      ok: true,
      message: "Translation state reset — next run will treat as new translation.",
    };
  },
};
