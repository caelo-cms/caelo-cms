// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

type ChatSessionRow = {
  id: string;
  title: string;
  lastActiveAt: string;
  publishedAt: string | null;
};

/**
 * P6.6 polish — return `sessions` as an UNawaited Promise so SvelteKit
 * streams it to the client. The +page.svelte wraps the list in
 * `{#await data.sessions}<Skeleton ... />{:then sessions}<Table .../>{/await}`,
 * giving the user a skeleton placeholder during the initial page
 * paint instead of a blank white frame while the DB query lands.
 *
 * Reference implementation for the deferred-load pattern. Other list
 * routes can adopt it incrementally — the pattern is mechanical and
 * the Skeleton primitive already in place handles the rendering.
 */
export const load: PageServerLoad = ({ locals }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const sessions = (async (): Promise<ChatSessionRow[]> => {
    const r = await execute(registry, adapter, locals.ctx, "chat.list_sessions", {});
    return r.ok ? (r.value as { sessions: ChatSessionRow[] }).sessions : [];
  })();
  return { sessions };
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requirePermission(locals, "content.read");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const result = await execute(registry, adapter, locals.ctx, "chat.create_session", {});
    if (!result.ok) return fail(400, { error: "Could not create chat." });
    const id = (result.value as { chatSessionId: string }).chatSessionId;
    // P8 review-pass: optional `prompt` field rides through to the
    // session URL so the SEO panel's Autofill / Re-optimize buttons
    // pre-seed the composer. The session page reads `?prompt=` on
    // mount and dispatches the existing `caelo:insert-into-composer`
    // CustomEvent that ChatPanel listens for.
    const prompt = String(form.get("prompt") ?? "");
    const target =
      prompt.length > 0
        ? `/content/chat/${id}?prompt=${encodeURIComponent(prompt)}`
        : `/content/chat/${id}`;
    throw redirect(303, target);
  },
};
