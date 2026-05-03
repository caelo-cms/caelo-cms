// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

const SLOTS = ["brand-voice", "tone", "banned-phrases", "instructions", "glossary"] as const;

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "ai_memory.list", {});
  const memory = r.ok ? (r.value as { memory: { slot: string; body: string }[] }).memory : [];
  return { slots: SLOTS, memory };
};

export const actions: Actions = {
  set: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const slot = String(form.get("slot") ?? "");
    const body = String(form.get("body") ?? "");
    const result = await execute(registry, adapter, locals.ctx, "ai_memory.set", {
      slot,
      body,
    });
    if (!result.ok) return fail(400, { error: "Could not save memory slot." });
    return { ok: true };
  },
};
