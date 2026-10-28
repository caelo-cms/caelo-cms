// SPDX-License-Identifier: MPL-2.0

/**
 * Semantic matching of reports (epic #901, #906, #1049). A fingerprint only
 * merges exact repeats: an auto-captured error's normalised text, an AI
 * report's title. The AI words the same defect differently from one chat to
 * the next, and names the tool differently too ("stage_changes",
 * "stage_changes (Firebase Hosting staging channel promotion)"), and an
 * auto-captured error and the AI's own report of it never share a
 * fingerprint. So when a fingerprint is new, the matcher compares the report
 * with the intake's pool of recent clusters, of every tool and both sources,
 * and names the one it describes, if any. Tool and source are shown per
 * candidate as hints for the model, never used to pre-filter.
 *
 * The kind is the one partition (#1192): the service offers only clusters
 * of the report's kind, and the prompt asks a different question for each
 * (same defect vs. same idea). As a second guard, an answer naming a
 * candidate of the other kind is refused here too.
 *
 * Structured output through the AI SDK's `generateObject` (CLAUDE.md §12).
 * Only a `high`-confidence answer naming one of the offered candidates is
 * accepted; anything else opens a new cluster, because a wrong merge hides
 * a defect while a missed one costs a maintainer one "close as duplicate".
 *
 * The prompt is bounded: at most `MAX_CANDIDATES` candidates of at most
 * `CANDIDATE_TEXT_CHARS` description each, plus one report within the
 * contract's field limits.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { BugIntakeReport } from "@caelo-cms/shared";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { ClusterSummary } from "./store.js";

/** Names the existing cluster a report with a new fingerprint belongs to. */
export interface ClusterMatcher {
  /** The id of the candidate this report describes, or null. */
  match(report: BugIntakeReport, candidates: ClusterSummary[]): Promise<string | null>;
}

const matchAnswer = z.object({
  clusterId: z
    .string()
    .nullable()
    .describe(
      "id of the candidate describing the SAME defect (or the SAME suggestion), or null when none does",
    ),
  confidence: z.enum(["high", "medium", "low"]),
});

const SOURCE_LABEL = {
  ai: "filed by the AI assistant",
  auto: "captured automatically from a failing tool call",
} as const;

/** The task the model is given, per kind of report being matched. */
const INSTRUCTIONS = {
  defect: [
    "You triage bug reports about the Caelo CMS. Some were filed by its AI assistant while it worked,",
    "others were captured automatically from a failing tool call (title and error text only).",
    "Decide whether the NEW report describes the same underlying defect as one of the candidates:",
    "the same thing misbehaving in the same way, even if worded differently.",
    "The tool is written down freely and may be named differently for the same defect;",
    "an automatic capture and an AI report of the same error are the same defect.",
    "Different symptoms are different defects. When unsure, answer null.",
  ],
  suggestion: [
    "You triage suggestions about the Caelo CMS, filed by its AI assistant while it worked:",
    "nothing misbehaved, but Caelo lacked a capability, a tool or documentation the assistant needed.",
    "Decide whether the NEW suggestion asks for the same thing as one of the candidates:",
    "the same missing capability or the same missing documentation, even if worded differently.",
    "The tool is written down freely and may be named differently for the same idea.",
    "Related but different ideas are different suggestions. When unsure, answer null.",
  ],
} as const;

/** Prompt for one match; exported so a test can pin what the model is told. */
export function matchPrompt(report: BugIntakeReport, candidates: ClusterSummary[]): string {
  const list = candidates
    .map(
      (c) =>
        `<candidate id="${c.id}">\nSource: ${SOURCE_LABEL[c.source]}\nTool: ${c.suspectedTool ?? "(none named)"}\nTitle: ${c.title}\nWhat happened: ${c.whatHappened}\n</candidate>`,
    )
    .join("\n");
  return [
    ...INSTRUCTIONS[report.kind],
    "",
    `<new-report>\nSource: ${SOURCE_LABEL[report.source]}\nTool: ${report.suspectedTool ?? "(none named)"}\nTitle: ${report.title}\nWhat happened: ${report.whatHappened}\nExpected: ${report.expected}\n</new-report>`,
    "",
    list,
  ].join("\n");
}

/** The model-backed matcher; accepts only a high-confidence answer naming an offered candidate. */
export class LlmClusterMatcher implements ClusterMatcher {
  constructor(readonly model: LanguageModel) {}

  /** The production matcher: an Anthropic model through the AI SDK. */
  static anthropic(apiKey: string, modelId: string): LlmClusterMatcher {
    return new LlmClusterMatcher(createAnthropic({ apiKey })(modelId));
  }

  async match(report: BugIntakeReport, offered: ClusterSummary[]): Promise<string | null> {
    const candidates = offered.filter((c) => c.kind === report.kind);
    if (candidates.length === 0) return null;
    const { object } = await generateObject({
      model: this.model,
      schema: matchAnswer,
      prompt: matchPrompt(report, candidates),
    });
    if (object.confidence !== "high" || object.clusterId === null) return null;
    return candidates.some((c) => c.id === object.clusterId) ? object.clusterId : null;
  }
}
