// SPDX-License-Identifier: MPL-2.0

/**
 * Turn-completeness judge — the semantic half of the narrate-then-stop guard
 * (issue #106 redesign).
 *
 * The structural detector in `loop.ts` can tell that a turn used tools, wrote
 * nothing, and stopped. It CANNOT tell these two apart, because they are the
 * same shape:
 *
 *   operator: "wie lautet die aktuelle Überschrift?"
 *   → get_page → "Die Überschrift lautet 'Willkommen'."        ← finished
 *
 *   operator: "füge dem Layout eine Footer-Nav hinzu"
 *   → load_skill → "Ein site-weiter Footer gehört ins Layout — ich lege ihn an."
 *                                                               ← NOT finished
 *
 * The difference lives in the operator's request and in whether the closing
 * message ANSWERS or merely ANNOUNCES. That is a language question, and the
 * right tool for a language question is a language model — not the regex this
 * replaced. A small model reads the request, the tool names, and the closing
 * message, and returns one boolean. Same reason `query_page_html(describe)`
 * delegates extraction to a small model instead of parsing HTML by hand.
 *
 * Cost/latency: this runs only when the structural pre-filter in `loop.ts`
 * already matched (tools used, nothing written, `end_turn`), the prompt is a
 * few hundred tokens, and the operator has ALREADY seen the streamed text — so
 * the judgment delays only the turn's close, never the visible answer.
 */

import { getActiveProviderForModel } from "../provider-resolver.js";

/**
 * The judge model. Deliberately smaller than the chat model: the task is a
 * single well-scoped classification, and it must not add meaningful latency to
 * the close of every read-only turn.
 */
export const JUDGE_MODEL = "claude-sonnet-5";

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    finished: {
      type: "boolean",
      description:
        "true when the closing message delivers what the operator asked for; false ONLY when it announces a change that was never performed.",
    },
    reason: {
      type: "string",
      description: "One short sentence, in the operator's language, justifying the verdict.",
    },
  },
  required: ["finished", "reason"],
  additionalProperties: false,
} as const;

/**
 * The bias is deliberate and stated to the model: a wrong `false` makes the
 * assistant act when nothing was requested (it could write to the live site),
 * while a wrong `true` merely leaves the pre-existing behaviour in place. The
 * asymmetry has to be in the prompt, not only in our heads.
 */
const JUDGE_SYSTEM_PROMPT = `You audit ONE turn of an AI assistant that edits a website for a non-technical operator.

You receive: the operator's request, the names of the tools the assistant called during the turn, and the assistant's closing message.

Decide whether the turn is FINISHED.

finished = true when the closing message delivers what the operator asked for. This includes:
  - answering a question or reporting on the current state of the site,
  - summarising work the assistant already carried out this turn,
  - asking the operator a question that genuinely needs their decision,
  - reporting that nothing needed to change.

finished = false ONLY when the closing message announces or promises a change that the assistant did not actually perform — it says what it is GOING to do, and no tool in the list did it.

How to read the tool names: names starting with list_, get_, read_, find_, inspect_, screenshot_, check_, search_ and similar only READ the site; they never change anything. "load_skill" only loads instructions into the assistant's context. Any other name performed a real change.

When you are unsure, answer finished = true. A wrong "false" makes the assistant take an action nobody asked for; a wrong "true" costs nothing.

Write "reason" in the same language as the operator's request.`;

/** What the judge needs to see. */
export interface TurnCompletenessInput {
  /** The operator's message that opened this turn. */
  readonly userRequest: string;
  /** Every tool name called during the turn, in order. */
  readonly toolNames: readonly string[];
  /** The assistant's closing text — the message that ended the turn. */
  readonly assistantText: string;
  readonly abortSignal?: AbortSignal;
}

/** The judge's answer, plus the tokens to attribute to the chat. */
export interface TurnCompletenessVerdict {
  readonly finished: boolean;
  readonly reason: string;
  readonly providerName: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Judge one turn. Returns `null` when no verdict could be obtained — no active
 * provider, an unparseable response, or a provider error.
 *
 * `null` must be read by the caller as "do not force". That is NOT a silent
 * fallback of the kind CLAUDE.md §2 forbids: there is no state being masked,
 * the outcome is logged, and the alternative — forcing a tool call on an
 * unverified guess — is the one outcome that can change the operator's site
 * without them asking. Declining leaves the exact behaviour that existed
 * before this guard.
 */
export type JudgeTurnCompleteness = (
  input: TurnCompletenessInput,
) => Promise<TurnCompletenessVerdict | null>;

export const judgeTurnCompleteness: JudgeTurnCompleteness = async (input) => {
  try {
    const resolved = await getActiveProviderForModel(JUDGE_MODEL);
    if (!resolved) {
      console.error("[chat-runner] turn-completeness judge: no provider for", JUDGE_MODEL);
      return null;
    }
    const toolList =
      input.toolNames.length > 0 ? input.toolNames.join(", ") : "(no tools were called)";
    const result = await resolved.provider.generateObject({
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            `## Operator's request\n${input.userRequest}`,
            `## Tools the assistant called this turn\n${toolList}`,
            `## The assistant's closing message\n${input.assistantText}`,
          ].join("\n\n"),
        },
      ],
      jsonSchema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 300,
      temperature: 0,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    const obj = result.object as { finished?: unknown; reason?: unknown } | undefined;
    if (typeof obj?.finished !== "boolean") {
      console.error("[chat-runner] turn-completeness judge: no usable verdict", {
        model: resolved.model,
      });
      return null;
    }
    return {
      finished: obj.finished,
      reason: typeof obj.reason === "string" ? obj.reason : "",
      providerName: resolved.providerName,
      model: resolved.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } catch (err) {
    console.error("[chat-runner] turn-completeness judge failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
};
