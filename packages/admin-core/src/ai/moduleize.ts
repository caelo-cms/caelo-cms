// SPDX-License-Identifier: MPL-2.0

/**
 * `moduleize` — a small, focused AI building block that turns raw module HTML
 * into a proper Caelo module: parametrised HTML (`{{field}}` placeholders) + a
 * semantic `fields[]` schema + sensible displayName/kind/description.
 *
 * Why a dedicated call instead of (a) the main agent authoring `fields` in its
 * 100k-token turn or (b) the crude programmatic extractor: the main agent
 * shouldn't spend its huge context deciding field schemas, and the heuristic
 * extractor mints garbage names. This call sees ONLY the html (+ an optional
 * caller field hint) — tiny context, cheap — and does the one job well.
 *
 * It ALWAYS runs on the mint path; a caller-supplied `fields` is passed as a
 * HINT, never a gate (a broken hint gets repaired, not skipped). The output is
 * validated against the module contract (every `{{field}}` ↔ a declared field);
 * on failure the error is fed back for up to `maxRepairs` passes, then it
 * throws loudly (CLAUDE.md §2 — no silent garbage). When a repair happened
 * (attempts >= 2), `onRetry` fires so the caller can persist telemetry to
 * `ai_moduleize_attempts` — this module itself touches no DB, so it is fully
 * unit-testable against a FixtureProvider.
 */

import {
  type ModuleField,
  type ModuleKind,
  moduleFieldSchema,
  moduleKindSchema,
} from "@caelo-cms/shared";
import { z } from "zod";
import { validateTemplatizedModule } from "../ops/content/extract-module-structure.js";
import type { AIProvider, ProviderEvent } from "./provider.js";
import {
  MODULE_FIELDS_JSON_SCHEMA,
  MODULE_META_JSON_SCHEMA_PROPS,
} from "./tools/_module-fields-schema.js";

/** The clean module the block produces. */
export interface ModuleizeResult {
  readonly html: string;
  readonly fields: ModuleField[];
  readonly displayName: string;
  readonly kind: ModuleKind;
  readonly description: string;
}

/** Handed to `onRetry` when a repair pass was needed (attempts >= 2). */
export interface ModuleizeRetryRecord {
  readonly attempts: number;
  readonly errors: string[];
  readonly outcome: "ok_after_repair" | "failed";
  readonly inputHtml: string;
  readonly fieldsHint: readonly ModuleField[] | undefined;
  readonly finalFields: ModuleField[] | undefined;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModuleizeArgs {
  readonly provider: AIProvider;
  readonly html: string;
  /** Caller's field guess, folded in as a HINT (not a gate). */
  readonly fieldsHint?: readonly ModuleField[];
  readonly displayNameHint?: string;
  readonly kindHint?: ModuleKind;
  /** Repair passes after the first attempt. Default 2 → 3 attempts total. */
  readonly maxRepairs?: number;
  /** Fires only when a repair happened, so the caller can persist telemetry. */
  readonly onRetry?: (record: ModuleizeRetryRecord) => Promise<void>;
  readonly abortSignal?: AbortSignal;
}

const SUBMIT_TOOL_NAME = "submit_module";

const submitModuleTool = {
  name: SUBMIT_TOOL_NAME,
  description:
    "Return the moduleized result: the HTML rewritten with {{snake_case}} placeholders for every value a person would edit, the matching fields[] schema, plus a short displayName, a kind, and a one-line description.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["html", "fields", "displayName", "kind"],
    properties: {
      html: { type: "string", minLength: 1 },
      fields: MODULE_FIELDS_JSON_SCHEMA,
      displayName: { type: "string", minLength: 1, maxLength: 128 },
      ...MODULE_META_JSON_SCHEMA_PROPS,
    },
  },
} as const;

/** Zod shape the tool-call arguments must satisfy before contract validation. */
const moduleizeOutputSchema = z.object({
  html: z.string().min(1),
  fields: z.array(moduleFieldSchema),
  displayName: z.string().min(1).max(128),
  kind: moduleKindSchema.default("content"),
  description: z.string().max(2000).default(""),
});

const SYSTEM = [
  "You convert raw module HTML into a reusable Caelo module. Do ONE thing:",
  "1. Find every value a non-technical operator would want to edit (headings, body copy, button labels, hrefs, image srcs, list items) and replace it in the HTML with a `{{field_name}}` placeholder.",
  "2. Emit a `fields[]` entry for each placeholder with a SEMANTIC snake_case name that describes the VALUE (`hero_title`, `primary_cta_href`, `nav_items`), never the tag. Pick the right kind: text, richtext, url, image, number, boolean, link; repeating content is a LIST field (`text-list`, `link-list`, `module-list`) — never numbered scalars (label, label2, ...).",
  "   EVERY field MUST carry `default` = the ORIGINAL value you replaced in the input HTML (the exact heading text, the exact href, ...). The raw copy must never be lost — placements without custom content render these defaults.",
  "3. Give the module a short displayName, a kind (chrome|hero|content|cta|utility), and a one-line description (what it is + when to use it).",
  "Every `{{field}}` in html MUST have a matching fields[] entry and vice-versa. Return the result by calling the `submit_module` tool — do not reply with prose.",
].join("\n");

function userMessage(args: ModuleizeArgs): string {
  const parts = [`HTML to moduleize:\n\n${args.html}`];
  if (args.displayNameHint) parts.push(`\nSuggested displayName: ${args.displayNameHint}`);
  if (args.kindHint) parts.push(`\nSuggested kind: ${args.kindHint}`);
  if (args.fieldsHint && args.fieldsHint.length > 0)
    parts.push(`\nField HINT (refine/replace as needed):\n${JSON.stringify(args.fieldsHint)}`);
  return parts.join("");
}

/** Drain one generate() call, returning the submit_module args + usage. */
async function runOnce(
  provider: AIProvider,
  systemPrompt: string,
  message: string,
  abortSignal?: AbortSignal,
): Promise<{
  args: unknown | undefined;
  inputTokens: number;
  outputTokens: number;
  model: string;
  providerError?: string;
}> {
  let toolArgs: unknown;
  let inputTokens = 0;
  let outputTokens = 0;
  let providerError: string | undefined;
  const stream = provider.generate({
    systemPrompt,
    messages: [{ role: "user", content: message }],
    tools: [submitModuleTool],
    // Force the single tool so the model returns structured args, not prose.
    toolChoice: { type: "tool", toolName: SUBMIT_TOOL_NAME },
    maxTokens: 8192,
    temperature: 0,
    ...(abortSignal ? { abortSignal } : {}),
  });
  for await (const ev of stream as AsyncIterable<ProviderEvent>) {
    if (ev.kind === "tool-call" && ev.name === SUBMIT_TOOL_NAME) {
      toolArgs = typeof ev.arguments === "string" ? safeJson(ev.arguments) : ev.arguments;
    } else if (ev.kind === "usage") {
      inputTokens = ev.inputTokens;
      outputTokens = ev.outputTokens;
    } else if (ev.kind === "error") {
      providerError = ev.message;
    }
  }
  return { args: toolArgs, inputTokens, outputTokens, model: provider.model, providerError };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Validate the tool-call args: shape (Zod) THEN the module contract
 * (placeholder ↔ field). Returns the parsed result or a human error string.
 */
function validate(
  args: unknown,
  inputHtml: string,
): { ok: true; value: ModuleizeResult } | { ok: false; error: string } {
  if (args === undefined) {
    return {
      ok: false,
      error: "did not call submit_module (no tool call / unparseable arguments)",
    };
  }
  const parsed = moduleizeOutputSchema.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      error: `submit_module arguments invalid: ${parsed.error.message.slice(0, 400)}`,
    };
  }
  const contract = validateTemplatizedModule(parsed.data.html, parsed.data.fields);
  if (!contract.ok) return { ok: false, error: contract.message };
  // Content-preservation contract: when the input HTML carried visible
  // copy and the model minted fields, at least one field must carry the
  // original value as its `default`. Without this check the copy VANISHES
  // (live-edit extract run: "Welcome to Caelo" was parametrised away with
  // no default and no content value — the model sets defaults only
  // sometimes, which is flaky-by-design; the retry makes it a contract).
  const inputCopy = inputHtml
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (inputCopy.length > 0 && parsed.data.fields.length > 0) {
    const hasAnyDefault = parsed.data.fields.some(
      (f) => "default" in f && f.default !== undefined && f.default !== "",
    );
    if (!hasAnyDefault) {
      return {
        ok: false,
        error:
          "no field carries a `default` — the input HTML's original copy would be LOST. " +
          "Set each field's `default` to the exact value you replaced (heading text, href, label, ...).",
      };
    }
  }
  return { ok: true, value: parsed.data };
}

/**
 * Turn raw module HTML into a validated module. Throws (loudly) if it can't
 * produce a contract-valid module within `maxRepairs` repair passes.
 */
export async function moduleize(args: ModuleizeArgs): Promise<ModuleizeResult> {
  const maxRepairs = args.maxRepairs ?? 2;
  const errors: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let model = args.provider.model;
  let message = userMessage(args);

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    const {
      args: toolArgs,
      inputTokens: it,
      outputTokens: ot,
      model: m,
      providerError,
    } = await runOnce(args.provider, SYSTEM, message, args.abortSignal);
    inputTokens += it;
    outputTokens += ot;
    model = m;
    // A provider/API error (rate limit, usage cap, network) is NOT a
    // moduleize repair case — retrying just burns more calls on a hard
    // failure. Fail loudly, immediately, without a telemetry row (this
    // table is for CONTRACT retries, not infra errors).
    if (providerError !== undefined) {
      throw new Error(`moduleize: provider error — ${providerError}`);
    }
    const result = validate(toolArgs, args.html);
    if (result.ok) {
      if (attempt > 1) {
        // A repair happened → persist telemetry (caller writes the row).
        await args.onRetry?.({
          attempts: attempt,
          errors,
          outcome: "ok_after_repair",
          inputHtml: args.html,
          fieldsHint: args.fieldsHint,
          finalFields: result.value.fields,
          model,
          inputTokens,
          outputTokens,
        });
      }
      return result.value;
    }
    errors.push(result.error);
    // Feed the error back for the next repair pass.
    message = `${userMessage(args)}\n\nYour previous attempt was rejected: ${result.error}\nFix it and call submit_module again.`;
  }

  // Exhausted the repair budget — record the failure, then fail loudly.
  await args.onRetry?.({
    attempts: maxRepairs + 1,
    errors,
    outcome: "failed",
    inputHtml: args.html,
    fieldsHint: args.fieldsHint,
    finalFields: undefined,
    model,
    inputTokens,
    outputTokens,
  });
  throw new Error(
    `moduleize failed after ${maxRepairs + 1} attempts — last error: ${errors[errors.length - 1] ?? "unknown"}`,
  );
}
