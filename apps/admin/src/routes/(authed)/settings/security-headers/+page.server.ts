// SPDX-License-Identifier: MPL-2.0

import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { DENIED_BROWSER_FEATURES, type SiteSecurityPolicy } from "@caelo-cms/shared";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

/** Issue #1454 — the site's response-header policy and what each environment sends. */
export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const read = await execute(registry, adapter, locals.ctx, "security_headers.get", {});
  if (!read.ok) return { state: null, error: describeError(read.error) };
  return { state: read.value as SecurityHeadersState, error: null };
};

type SecurityHeadersState = {
  policy: SiteSecurityPolicy;
  host: { provider: string; served: boolean; hostSendsHsts: boolean; note: string };
  staged: { headers: Record<string, string>; cspCut: boolean } | null;
  live: { headers: Record<string, string>; cspCut: boolean } | null;
  stageNeeded: boolean;
  enforceBlockers: string[];
  plugins: { slug: string; origins: string[]; inlineScripts: number }[];
  derivedOrigins: Record<string, string[]>;
  inlineScriptHashes: number;
};

/** One origin per line or space-separated. */
function origins(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(/\s+/)
    .filter((s) => s.length > 0);
}

export const actions: Actions = {
  save: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const read = await execute(registry, adapter, locals.ctx, "security_headers.get", {});
    if (!read.ok) return fail(500, { error: describeError(read.error) });
    const current = (read.value as SecurityHeadersState).policy;
    const extraSources = { ...current.extraSources };
    for (const kind of Object.keys(extraSourceKinds) as (keyof typeof extraSourceKinds)[]) {
      const list = origins(form.get(`extra-${kind}`));
      if (list.length > 0) extraSources[kind] = list;
      else delete extraSources[kind];
    }
    const policy: SiteSecurityPolicy = {
      ...current,
      cspMode: form.get("cspMode") === "enforce" ? "enforce" : "report_only",
      frameAncestors: origins(form.get("frameAncestors")),
      referrerPolicy: String(form.get("referrerPolicy")) as SiteSecurityPolicy["referrerPolicy"],
      allowedFeatures: DENIED_BROWSER_FEATURES.filter((f) => form.get(`feature-${f}`) === "on"),
      hsts: {
        maxAgeSeconds: Number(form.get("hstsMaxAge")),
        includeSubdomains: form.get("hstsSubdomains") === "on",
        preload: form.get("hstsPreload") === "on",
      },
      extraSources,
    };
    const saved = await execute(registry, adapter, locals.ctx, "security_headers.set", policy);
    if (!saved.ok) return fail(400, { error: describeError(saved.error) });
    return {
      ok: true,
      message:
        "Saved. Staging sends the new headers after the next Stage, the live site after Publish live.",
    };
  },
};

const extraSourceKinds = {
  script: true,
  style: true,
  img: true,
  font: true,
  connect: true,
  frame: true,
  media: true,
  form: true,
} as const;
