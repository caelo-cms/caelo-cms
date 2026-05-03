// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-translation — Tier-1 plugin packaging for Caelo's
 * translation (Mode 1 + Mode 2) feature.
 *
 * P11.5 commit 2 — proof-of-concept port. The actual translation
 * handlers (1910 lines of refined Mode 1 / Mode 2 / job runner code)
 * live in `packages/admin-core/src/ops/translation/` and stay there
 * for now; this plugin packages them as a Tier-1 plugin so:
 *   - `translate_page` + `start_translation_job` are registered into
 *     the chat-runner's tool catalogue from the plugin (instead of
 *     statically from `tools/index.ts`).
 *   - the plugin owns its system-prompt block (via promptContext).
 *   - the plugin's worker tick is mounted into the host's scheduler.
 *   - the cost dashboard groups translation spend by `plugin_id`.
 *
 * Operations are thin wrappers: each delegates to the existing
 * `translation.*` admin-core op via `ctx.cms.call(...)`. A future
 * P12-cleanup PR can move op bodies into this package; the SDK
 * surface won't change.
 */

import { definePlugin, type PluginContextTier1 } from "@caelo-cms/plugin-sdk";

const SLUG = "translation";

interface ComputeDiffResult {
  variantPageId: string | null;
}

interface Mode1Result {
  variantPageId: string;
  moduleCount: number;
  costMicrocents: number;
}

interface Mode2Result {
  variantPageId: string;
  blocksChanged: number;
  blocksAdded: number;
  blocksRemoved: number;
  costMicrocents: number;
}

export default definePlugin<PluginContextTier1>({
  slug: SLUG,
  version: "1.0.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["cms_admin", "ai_provider", "snapshots", "chat_runner_tools"],
  operations: {
    /**
     * `translate_page` — auto-dispatches Mode 1 or Mode 2 based on the
     * variant's existing status. Same shape the legacy AI tool used.
     */
    translate_page: async (ctx, args) => {
      if (!ctx.cms) throw new Error("translate_page: ctx.cms missing");
      const input = args as { pageId: string; targetLocale: string };
      const diff = await ctx.cms.call<typeof input, ComputeDiffResult>(
        "translation.compute_diff",
        input,
      );
      const opName = diff.variantPageId === null ? "translation.mode_1" : "translation.mode_2";
      if (opName === "translation.mode_1") {
        const r = await ctx.cms.call<typeof input, Mode1Result>(opName, input);
        return { mode: "mode_1" as const, ...r };
      }
      const r = await ctx.cms.call<typeof input, Mode2Result>(opName, input);
      return { mode: "mode_2" as const, ...r };
    },

    /**
     * `start_translation_job` — bulk run; queues units and returns the job id.
     */
    start_translation_job: async (ctx, args) => {
      if (!ctx.cms) throw new Error("start_translation_job: ctx.cms missing");
      const input = args as { scope: unknown; capMicrocents?: number };
      const r = await ctx.cms.call<typeof input, { jobId: string; queuedUnits: number }>(
        "translation_jobs.create",
        input,
      );
      return r;
    },

    /**
     * `_keepalive` — P11.5 audit fix #5: validates the plugin-host's
     * cron scheduler ticks in production. The existing setInterval-based
     * `startTranslationWorker` from admin-core remains primary for now;
     * full migration to a plugin-driven worker (where this op would
     * actually claim + process units) is P12-cleanup scope. This op
     * just records the tick so /security/plugins can show the scheduler
     * is alive.
     */
    _keepalive: async (_ctx, _args) => {
      return { tickedAt: new Date().toISOString() };
    },
  },
  tools: [
    {
      name: "translate_page",
      description:
        "Translate or update one page into one target locale. The mode (new translation vs. update) is auto-decided from the page's translation_status for that locale. " +
        "The result lands as a DRAFT page — DO NOT claim the translation is published. The user must confirm via the publish flow. " +
        "Inputs: pageId (the SOURCE page), targetLocale (the locale to translate INTO). " +
        "If the user asks to translate multiple pages or a whole locale at once, use `start_translation_job` instead.",
      operationName: "translate_page",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["pageId", "targetLocale"],
        properties: {
          pageId: { type: "string", format: "uuid" },
          targetLocale: { type: "string", pattern: "^[a-z]{2,3}(-[A-Za-z]{2,4})?$" },
        },
      },
    },
    {
      name: "start_translation_job",
      description:
        "Queue a bulk translation run. `scope` can be `{kind:'all-stale'}`, `{kind:'page', pageId}`, `{kind:'locale', code}`, or `{kind:'pages', pageIds:[...]}`. " +
        "Returns a job id; the user reviews progress at /content/translations. Owner approval of EACH translated page still applies at publish time.",
      operationName: "start_translation_job",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["scope"],
        properties: {
          scope: { type: "object" },
          capMicrocents: { type: "number" },
        },
      },
    },
  ],
  workers: [
    {
      // P11.5 audit fix #5: smoke-test the plugin-host's croner-backed
      // scheduler. Runs every 10 minutes; no-op handler. Real workers
      // (job_runner replacing startTranslationWorker) land in P12-cleanup.
      name: "keepalive",
      cron: "0 */10 * * * *",
      operationName: "_keepalive",
    },
  ],
  promptContext: [
    {
      label: "translations",
      render: async (ctx) => {
        if (!ctx.cms) return "";
        try {
          const r = await ctx.cms.call<
            Record<string, never>,
            { runningJobs: number; pendingUnits: number }
          >("translation_jobs.aggregate_active", {});
          if (r.runningJobs === 0 && r.pendingUnits === 0) return "";
          return [
            "# Translation jobs in flight",
            `- ${r.runningJobs} running job${r.runningJobs === 1 ? "" : "s"}`,
            `- ${r.pendingUnits} pending unit${r.pendingUnits === 1 ? "" : "s"}`,
            "Use `start_translation_job` only if no active job already covers the user's scope.",
          ].join("\n");
        } catch {
          // Op not registered yet — render no block (the plugin survives the
          // chat-runner turn even when the legacy aggregator op isn't shipped).
          return "";
        }
      },
    },
  ],
});
