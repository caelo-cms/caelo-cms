// SPDX-License-Identifier: MPL-2.0

/**
 * #650 — Security → Staging access: who may open the protected staging
 * site (staging.<domain>), and the crawler credentials. Reading needs
 * settings.read; the credentials and every change need settings.write.
 * The AI reaches the same settings through propose_set_staging_access /
 * propose_rotate_staging_credentials (approved in the chat).
 */

import { execute } from "@caelo-cms/query-api";
import { error, fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface StagingAccess {
  stagingUrl: string | null;
  stagingHost: string | null;
  stagingDomainSupported: boolean;
  provider: string;
  hasStagedBuild: boolean;
  stagedBuildHost: string | null;
  stageNeeded: "nothing-staged" | "host-changed" | null;
  stageNote: string | null;
  draftPages: { count: number; pages: { id: string; title: string; path: string }[] };
  settings: {
    cookieEnabled: boolean;
    basicAuthEnabled: boolean;
    basicAuthUser: string;
    basicAuthGenerated: boolean;
    headerEnabled: boolean;
    headerName: string;
    headerGenerated: boolean;
    ipAllowlist: string[];
    updatedAt: string;
  };
  credentials?: {
    basicAuthUser: string;
    basicAuthPassword: string | null;
    headerName: string;
    headerValue: string | null;
  };
}

function messageOf(e: unknown, fallback: string): string {
  return typeof e === "object" && e && "message" in e
    ? String((e as { message: unknown }).message)
    : fallback;
}

export const load: PageServerLoad = async ({ locals }) => {
  const user = requirePermission(locals, "settings.read");
  const canWrite = user.permissions.has("settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "staging_access.get", {
    includeCredentials: canWrite,
  });
  if (!r.ok) throw error(500, messageOf(r.error, "could not load the staging access settings"));
  return { access: r.value as StagingAccess, canWrite };
};

export const actions: Actions = {
  save: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const ipAllowlist = String(form.get("ipAllowlist") ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "staging_access.set", {
      cookieEnabled: form.get("cookieEnabled") === "on",
      basicAuthEnabled: form.get("basicAuthEnabled") === "on",
      basicAuthUser: String(form.get("basicAuthUser") ?? ""),
      headerEnabled: form.get("headerEnabled") === "on",
      headerName: String(form.get("headerName") ?? ""),
      ipAllowlist,
    });
    if (!r.ok) {
      const issues =
        r.error.kind === "ValidationFailed"
          ? (r.error as { issues: { path: PropertyKey[]; message: string }[] }).issues
              .map((i) => `${i.path.join(".") || "settings"}: ${i.message}`)
              .join("; ")
          : messageOf(r.error, r.error.kind);
      return fail(400, { error: issues });
    }
    return { ok: true, message: "Staging access saved. The gate applies it within seconds." };
  },
  rotate: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const which = String(form.get("which") ?? "");
    if (which !== "basic-auth" && which !== "header" && which !== "both") {
      return fail(400, { error: "which must be basic-auth, header or both" });
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "staging_access.rotate_credentials", {
      which,
    });
    if (!r.ok) return fail(400, { error: messageOf(r.error, r.error.kind) });
    return {
      ok: true,
      message:
        "Credential rotated. Give the new value to every crawler or tool that used the old one.",
    };
  },
};
