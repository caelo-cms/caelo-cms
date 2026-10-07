// SPDX-License-Identifier: MPL-2.0

/**
 * A/B experiment tools — the routine half of the experiments domain.
 *
 *   - `create_experiment`       → `experiments.create` (a DRAFT; no traffic)
 *   - `list_experiments`        → `experiments.list`
 *   - `get_experiment_results`  → `experiments.get_results`
 *
 * Activation and completion stay §11.A-gated (`propose_activate_experiment`
 * / `propose_complete_experiment`): those change what real visitors see.
 * Before these tools the gated half was reachable but its precondition — a
 * draft to activate, results to pick a winner from — was operator-only, so
 * the AI could propose an activation it had no way to set up.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { experimentCreateInputSchema } from "../../ops/experiments.js";
import { describeError } from "./_describe-error.js";
import { makeListReadTool, makeReadTool } from "./_make-read-tool.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

type CreateExperimentInput = z.infer<typeof experimentCreateInputSchema>;

export const createExperimentTool: ToolDefinitionWithHandler<CreateExperimentInput> = {
  name: "create_experiment",
  description:
    "Create a DRAFT A/B experiment on one page: 2–10 variants with traffic weights that sum to 1. A draft assigns no visitors — it only starts after `propose_activate_experiment` and the operator's approval, so creating one is safe to do without asking. " +
    "Each variant is `{label, weight, htmlPatches?}`; `htmlPatches` are literal find/replace pairs applied to the page's composed HTML (e.g. `[{find: 'Sign up free', replace: 'Try it free'}]`) — copy `find` verbatim from the page (`read_content` / `query_page_html`); a variant with no patches is the control. " +
    "`slug` is a short kebab-case name for the test (`hero-cta-wording`); take `pageId` from `list_pages`. " +
    "Typical flow: create_experiment → propose_activate_experiment → later get_experiment_results → propose_complete_experiment with the winner.",
  schema: experimentCreateInputSchema,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "experiments.create", input);
    if (!r.ok) {
      return { ok: false, content: `experiments.create failed: ${describeError(r.error)}` };
    }
    const { experimentId } = r.value as { experimentId: string };
    return {
      ok: true,
      content:
        `Draft experiment "${input.slug}" created (experimentId=${experimentId}, ${input.variants.length} variants). ` +
        "It is not live — call propose_activate_experiment with this experimentId when it should start receiving traffic.",
      value: { experimentId },
    };
  },
};

interface ExperimentRow {
  readonly id: string;
  readonly slug: string;
  readonly pageId: string;
  readonly status: "draft" | "active" | "completed";
  readonly variants: readonly { label: string; weight: number }[];
  readonly startedAt: string | null;
  readonly winningVariant: string | null;
}

export const listExperimentsTool = makeListReadTool<
  { status?: "draft" | "active" | "completed" },
  ExperimentRow
>({
  name: "list_experiments",
  description:
    "List the site's A/B experiments (id, slug, page, status, variants with weights, winner). Filter by `status` ('draft' | 'active' | 'completed'). " +
    "Use it to find the experimentId for `propose_activate_experiment`, `get_experiment_results` or `propose_complete_experiment`, and to avoid creating a duplicate test on a page that already has one.",
  opName: "experiments.list",
  input: z.object({
    status: z
      .enum(["draft", "active", "completed"])
      .optional()
      .describe("Only experiments in this state."),
  }),
  buildOpInput: (input) => (input.status ? { status: input.status } : {}),
  label: "experiments",
  rows: (value) => (value as { experiments: ExperimentRow[] }).experiments,
  columns: [
    { key: "id", value: (e) => e.id },
    { key: "slug", value: (e) => e.slug },
    { key: "pageId", value: (e) => e.pageId },
    { key: "status", value: (e) => e.status },
    {
      key: "variants",
      value: (e) => e.variants.map((v) => `${v.label}:${v.weight}`).join("|"),
    },
    { key: "startedAt", value: (e) => e.startedAt },
    { key: "winner", value: (e) => e.winningVariant },
  ],
  emptyMessage: "No experiments yet — create one with create_experiment.",
});

export const getExperimentResultsTool = makeReadTool<{ experimentId: string }>({
  name: "get_experiment_results",
  description:
    "Per-variant visitor counts for one experiment (unique visitors + total impressions per variant label). " +
    "Use it before `propose_complete_experiment` to pick the winner, or when the operator asks how a test is doing. Counts only — conversions are not tracked here, so say so instead of inventing a conversion rate.",
  opName: "experiments.get_results",
  input: z.object({ experimentId: z.string().uuid() }).strict(),
  format: (value) => {
    const counts = (
      value as {
        counts: { variantLabel: string; uniqueVisitors: number; totalImpressions: number }[];
      }
    ).counts;
    if (counts.length === 0) {
      return "No visitors assigned yet (the experiment is a draft, was just activated, or has had no traffic).";
    }
    return counts
      .map(
        (c) =>
          `${c.variantLabel}: ${c.uniqueVisitors} unique visitor(s), ${c.totalImpressions} impression(s)`,
      )
      .join("\n");
  },
});
