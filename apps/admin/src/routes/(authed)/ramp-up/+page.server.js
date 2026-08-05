// SPDX-License-Identifier: MPL-2.0
/**
 * P19 / v0.2.15 — Ramp Up wizard. Owner-facing flow for getting a
 * fresh Caelo install populated in a few clicks:
 *
 *   0. Preferences (v0.2.15) — optional one-screen form capturing
 *      site purpose / brand voice / words to avoid. Each non-empty
 *      field becomes a `site_ai_memory.set` call so the AI has
 *      context from turn 1. Skippable; the AI's existing fallback
 *      ("confident, plainspoken tone") covers an empty memory.
 *   1. Welcome + URL input → calls `imports.create_run` (Owner-direct;
 *      goes straight to status='crawling', skipping the AI propose
 *      gate since the Owner is initiating).
 *   2. Crawling — page polls `imports.get` every 2s.
 *   3. Review — Owner sees extracted pages + screenshot diffs.
 *   4. Synthesise — clicks the button, server calls
 *      `imports.compose_from_run` to materialise theme + template +
 *      pages + modules in one transaction.
 *   5. Done — link to /edit?page=<homepageId> for the publish flow.
 *
 * The page is one route; query params (`runId`, `step`) drive the
 * step rendered. Resume-able: the Owner can navigate away and come
 * back via /ramp-up?runId=... at any point. `?step=url` skips the
 * preferences step (used by the "Skip — set up later" button + by
 * deep links from the dashboard).
 */
import { execute } from "@caelo-cms/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
export const load = async ({ locals, url }) => {
    requirePermission(locals, "settings.write");
    const runId = url.searchParams.get("runId");
    const stepHint = url.searchParams.get("step");
    const { adapter, registry } = getQueryContext();
    if (!runId) {
        // No active import run. Show the preferences step by default; the
        // operator can hit "Skip — set up later" or deep-link with
        // ?step=url to jump straight to the URL form. We pre-fill the
        // textarea values from existing site_ai_memory so re-running the
        // wizard doesn't lose what was already saved.
        if (stepHint === "url") {
            return { step: "welcome", memory: emptyMemorySnapshot() };
        }
        const memR = await execute(registry, adapter, locals.ctx, "ai_memory.list", {});
        const memory = memR.ok
            ? indexMemoryBySlot(memR.value.memory)
            : emptyMemorySnapshot();
        return { step: "preferences", memory };
    }
    const r = await execute(registry, adapter, locals.ctx, "imports.get", { runId });
    if (!r.ok) {
        return {
            step: "welcome",
            error: `Import run not found (${r.error.kind}).`,
            memory: emptyMemorySnapshot(),
        };
    }
    const data = r.value;
    return {
        step: stepFromStatus(data.run.status),
        run: data.run,
        pages: data.pages,
        memory: emptyMemorySnapshot(),
    };
};
function emptyMemorySnapshot() {
    return { purpose: "", brandVoice: "", bannedPhrases: "" };
}
function indexMemoryBySlot(rows) {
    const out = emptyMemorySnapshot();
    for (const r of rows) {
        if (r.slot === "purpose")
            out.purpose = r.body;
        else if (r.slot === "brand-voice")
            out.brandVoice = r.body;
        else if (r.slot === "banned-phrases")
            out.bannedPhrases = r.body;
    }
    return out;
}
/**
 * Map the import_runs.status enum → wizard step. The wizard's
 * "synthesised" step (status='completed' with accepted pages present)
 * is a separate UI; we infer it by checking whether any page row has
 * `accepted_page_id` set.
 */
function stepFromStatus(status) {
    switch (status) {
        case "proposed": // shouldn't happen — wizard skips the propose gate
            return "crawling";
        case "crawling":
            return "crawling";
        case "ready_for_review":
            return "review";
        case "completed":
            return "review";
        case "failed":
            return "failed";
    }
}
export const actions = {
    /**
     * v0.2.15 — Step 0 "preferences" form. Each non-empty textarea
     * becomes one `ai_memory.set` call so the AI sees the operator's
     * intent from turn 1 in chat. Empty textareas are skipped (set
     * with empty body would clear the slot — wrong UX for a wizard
     * where leaving a field blank means "no opinion yet"). Then
     * redirects to the URL step.
     */
    savePreferences: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const purpose = String(form.get("purpose") ?? "").trim();
        const brandVoice = String(form.get("brandVoice") ?? "").trim();
        const bannedPhrases = String(form.get("bannedPhrases") ?? "").trim();
        const { adapter, registry } = getQueryContext();
        const slots = [];
        if (purpose.length > 0)
            slots.push({ slot: "purpose", body: purpose });
        if (brandVoice.length > 0)
            slots.push({ slot: "brand-voice", body: brandVoice });
        if (bannedPhrases.length > 0)
            slots.push({ slot: "banned-phrases", body: bannedPhrases });
        for (const s of slots) {
            const r = await execute(registry, adapter, locals.ctx, "ai_memory.set", s);
            if (!r.ok) {
                return fail(400, {
                    error: `Could not save ${s.slot}: ${r.error.kind}`,
                });
            }
        }
        throw redirect(303, "/ramp-up?step=url");
    },
    start: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const sourceUrl = String(form.get("sourceUrl") ?? "").trim();
        const depth = Number.parseInt(String(form.get("depth") ?? "2"), 10);
        const maxPages = Number.parseInt(String(form.get("maxPages") ?? "20"), 10);
        if (!sourceUrl)
            return fail(400, { error: "Enter a URL to import." });
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "imports.create_run", {
            sourceUrl,
            depth,
            maxPages,
        });
        if (!r.ok)
            return fail(400, { error: `Could not start crawl (${r.error.kind}).` });
        const runId = r.value.runId;
        throw redirect(303, `/ramp-up?runId=${runId}`);
    },
    compose: async ({ request, locals }) => {
        requirePermission(locals, "settings.write");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const runId = String(form.get("runId") ?? "").trim();
        if (!runId)
            return fail(400, { error: "Missing runId." });
        const { adapter, registry } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "imports.compose_from_run", {
            runId,
        });
        if (!r.ok)
            return fail(400, { error: `Synthesis failed (${r.error.kind}).` });
        const result = r.value;
        // Still crawling is not a failure — tell the page to keep waiting.
        if (result.status === "crawling") {
            return { ok: true, composed: false, crawling: true };
        }
        const v = result;
        return {
            ok: true,
            composed: true,
            themeTokensApplied: v.themeTokensApplied,
            pageCount: v.pageIds.length,
            homepageId: v.homepageId,
            templateId: v.templateId,
        };
    },
};
