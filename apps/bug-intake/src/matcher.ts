// SPDX-License-Identifier: MPL-2.0

/**
 * Semantic matching of AI-filed reports (epic #901, #906). The install's
 * fingerprint only merges exact repeats of an AI report's title; the AI
 * words the same defect differently from one chat to the next. When a
 * fingerprint is new, the matcher compares the report with the recent
 * clusters of the same tool and names the one it describes, if any.
 *
 * Structured output through the AI SDK's `generateObject` (CLAUDE.md §12).
 * Only a `high`-confidence answer naming one of the offered candidates is
 * accepted; anything else opens a new cluster, because a wrong merge hides
 * a defect while a missed one costs a maintainer one "close as duplicate".
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { BugIntakeReport } from "@caelo-cms/shared";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { ClusterSummary } from "./store.js";

export interface ClusterMatcher {
  /** The id of the candidate this report describes, or null. */
  match(report: BugIntakeReport, candidates: ClusterSummary[]): Promise<string | null>;
}

const matchAnswer = z.object({
  clusterId: z
    .string()
    .nullable()
    .describe("id of the candidate describing the SAME defect, or null when none does"),
  confidence: z.enum(["high", "medium", "low"]),
});

/** Prompt for one match; exported so a test can pin what the model is told. */
export function matchPrompt(report: BugIntakeReport, candidates: ClusterSummary[]): string {
  const list = candidates
    .map(
      (c) =>
        `<candidate id="${c.id}">\nTitle: ${c.title}\nWhat happened: ${c.whatHappened}\n</candidate>`,
    )
    .join("\n");
  return [
    "You triage bug reports that an AI assistant filed against the Caelo CMS while working.",
    "Decide whether the NEW report describes the same underlying defect as one of the candidates:",
    "the same tool misbehaving in the same way, even if worded differently.",
    "Different symptoms of one tool are different defects. When unsure, answer null.",
    "",
    `<new-report>\nTool: ${report.suspectedTool ?? "(none named)"}\nTitle: ${report.title}\nWhat happened: ${report.whatHappened}\nExpected: ${report.expected}\n</new-report>`,
    "",
    list,
  ].join("\n");
}

export class LlmClusterMatcher implements ClusterMatcher {
  constructor(readonly model: LanguageModel) {}

  /** The production matcher: an Anthropic model through the AI SDK. */
  static anthropic(apiKey: string, modelId: string): LlmClusterMatcher {
    return new LlmClusterMatcher(createAnthropic({ apiKey })(modelId));
  }

  async match(report: BugIntakeReport, candidates: ClusterSummary[]): Promise<string | null> {
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
