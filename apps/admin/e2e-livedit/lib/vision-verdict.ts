// SPDX-License-Identifier: MPL-2.0

/**
 * Closing LLM-vision verdict for the e2e-livedit Playwright suite
 * (issue #47, operator clarification in the issue's 2nd comment).
 *
 * The mid-flow assertions in a scenario are purely structural
 * (DOM + DB + admin-stderr). After Publish, this module posts a
 * full-page screenshot of the production URL to Anthropic's
 * `/v1/messages` API with a fixed rubric prompt and parses the
 * model's `{ ok, reason }` verdict. The scenario asserts
 * `verdict.ok === true`.
 *
 * Failure modes are all loud (CLAUDE.md §2 — no silent fallbacks).
 * One retry with 2s backoff on transient 5xx so a flaky Anthropic
 * edge doesn't waste the 3-min chat work the scenario already did.
 *
 * Module is intentionally Playwright-free so step 12 can unit-test
 * the parser + retry + structured-error surface from `bun test`.
 */

import { z } from "zod";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";

/** Default vision-judge model. Cheaper than Opus 4.7 — vision-only
 *  rubric check, not chat planning. Override via `model` arg in tests. */
export const DEFAULT_VISION_MODEL = "claude-haiku-4-5-20251001";

/**
 * Zod schema for the verdict JSON the rubric prompt asks the model to
 * emit. `.strict()` rejects extra fields so a model drift towards
 * `{ ok, reason, confidence }` (or similar) surfaces immediately
 * rather than getting silently truncated.
 */
const VisionVerdictSchema = z
  .object({
    ok: z.boolean(),
    reason: z.string(),
  })
  .strict();

/**
 * Final verdict returned to the scenario. `ok=true` ⇒ the scenario
 * passes the vision check; `ok=false` ⇒ the test fails with `reason`
 * surfaced in the Playwright error message.
 */
export type VisionVerdict = z.infer<typeof VisionVerdictSchema>;

export class VisionVerdictRequestError extends Error {
  readonly status: number;
  readonly bodyExcerpt: string;
  constructor(status: number, bodyExcerpt: string) {
    super(`Anthropic vision API returned ${status}. Body (first 500 chars): ${bodyExcerpt}`);
    this.name = "VisionVerdictRequestError";
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

export class VisionVerdictParseError extends Error {
  readonly raw: string;
  constructor(raw: string) {
    super(`Vision verdict could not be parsed as JSON: ${raw.slice(0, 500)}`);
    this.name = "VisionVerdictParseError";
    this.raw = raw;
  }
}

export class VisionVerdictSchemaError extends Error {
  readonly raw: unknown;
  readonly issues: readonly z.ZodIssue[];
  constructor(issues: readonly z.ZodIssue[], raw: unknown) {
    const summary = issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    super(
      `Vision verdict JSON failed schema validation: ${summary}. Raw: ${JSON.stringify(raw).slice(0, 500)}`,
    );
    this.name = "VisionVerdictSchemaError";
    this.raw = raw;
    this.issues = issues;
  }
}

/** Zod schema for the relevant subset of Anthropic's response shape. */
const AnthropicMessagesResponseSchema = z.object({
  content: z
    .array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.string() }).passthrough(), // ignore non-text blocks
      ]),
    )
    .min(1),
});

/**
 * Pull the concatenated text blocks out of a raw Anthropic `/v1/messages`
 * response (`{ content: [{ type: "text", text }, ...] }`). Non-text blocks
 * are ignored; no text at all is a schema error.
 */
function extractResponseText(responseJson: unknown): string {
  const responseParse = AnthropicMessagesResponseSchema.safeParse(responseJson);
  if (!responseParse.success) {
    throw new VisionVerdictSchemaError(responseParse.error.issues, responseJson);
  }
  const text = responseParse.data.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && "text" in b)
    .map((b) => b.text)
    .join("\n");
  if (text.length === 0) {
    const issue: z.ZodIssue = {
      code: "custom",
      path: ["content"],
      message: "no text blocks in Anthropic response",
    };
    throw new VisionVerdictSchemaError([issue], responseJson);
  }
  return text;
}

/**
 * Extract + validate the JSON object out of the model's text response.
 * Handles ```json fences and a leading sentence by slicing from the first
 * `{` to the LAST `}`. This is intentionally not a balanced-brace parser —
 * both rubric prompts ask for one flat object, so the literal first-`{` /
 * last-`}` window is sufficient and rejects wrapper text via `JSON.parse`.
 */
function parseJsonObjectText<T>(text: string, schema: z.ZodType<T>): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end < start) {
    throw new VisionVerdictParseError(text);
  }
  const slice = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    throw new VisionVerdictParseError(text);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new VisionVerdictSchemaError(result.error.issues, parsed);
  }
  return result.data;
}

/**
 * Parse a raw Anthropic `/v1/messages` response into a typed verdict.
 * The rubric prompt instructs the model to return ONLY a single JSON
 * object `{"ok": <bool>, "reason": "<string>"}` — but the model
 * occasionally wraps it in ```json ... ``` fences or prefixes a
 * sentence; see {@link parseVerdictJsonText}.
 */
export function parseVisionVerdict(responseJson: unknown): VisionVerdict {
  return parseVerdictJsonText(extractResponseText(responseJson));
}

/** Extract + validate the `{ ok, reason }` verdict from the model's text. */
export function parseVerdictJsonText(text: string): VisionVerdict {
  return parseJsonObjectText(text, VisionVerdictSchema);
}

/**
 * Rubric the model judges against. Deliberately structural — the test
 * is "does this look like a working homepage", not "is this
 * well-written marketing copy."
 */
export const VISION_RUBRIC = `You are reviewing a screenshot of a freshly-deployed web page.

Reply with EXACTLY one JSON object of the shape:
  {"ok": <boolean>, "reason": "<short string>"}

Set ok=true if ALL of the following are true:
- The page has visible content (not blank, not an error page).
- A heading and at least some body text are visible.
- The layout is not broken (no overlapping/clipping text, no obviously
  unstyled HTML, no "module failed to render" placeholder).

Set ok=false if any are violated. In "reason", quote the specific
visual problem in <= 30 words. No prose outside the JSON object.`;

interface ExecuteOpts {
  readonly apiKey: string;
  readonly screenshotBase64: string;
  readonly mediaType?: "image/png" | "image/jpeg" | "image/webp";
  readonly model?: string;
  readonly rubric?: string;
  /**
   * Replaceable fetch — unit tests inject a stub here. Defaults to
   * the global `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
  /** Sleep injection — tests pass a no-op to skip the 2s backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST one screenshot + rubric to `/v1/messages` and return the raw JSON
 * response. Retries once on 5xx with 2s backoff; throws
 * `VisionVerdictRequestError` on the second non-2xx. 4xx errors do not
 * retry — re-requesting with the same body cannot recover.
 */
async function postVisionRequest(
  opts: ExecuteOpts,
  rubric: string,
  maxTokens: number,
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const model = opts.model ?? DEFAULT_VISION_MODEL;
  const mediaType = opts.mediaType ?? "image/png";

  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: opts.screenshotBase64,
            },
          },
          { type: "text", text: rubric },
        ],
      },
    ],
  });

  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(2000);
    const res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body,
    });
    if (res.ok) return (await res.json()) as unknown;
    lastStatus = res.status;
    lastBody = await res.text().catch(() => "");
    // 4xx is a client problem — retrying with the same body is
    // pointless. 5xx is potentially transient → retry once.
    if (lastStatus < 500) break;
  }
  throw new VisionVerdictRequestError(lastStatus, lastBody.slice(0, 500));
}

/** Issue ONE structural vision verdict request (see {@link VISION_RUBRIC}). */
export async function fetchVisionVerdict(opts: ExecuteOpts): Promise<VisionVerdict> {
  return parseVisionVerdict(await postVisionRequest(opts, opts.rubric ?? VISION_RUBRIC, 256));
}

/**
 * issue #161 — design-quality scores. Unlike the structural verdict this
 * is a TASTE judgement, so the suite records it (non-blocking) and only
 * promotes it to a gate once the 10× determinism recipe has measured its
 * variance. Integer 1–5 per axis; `.strict()` surfaces schema drift.
 */
const DesignRubricScoresSchema = z
  .object({
    hierarchy: z.number().int().min(1).max(5),
    contrast: z.number().int().min(1).max(5),
    rhythm: z.number().int().min(1).max(5),
    polish: z.number().int().min(1).max(5),
    notes: z.string(),
  })
  .strict();

/** Parsed design-judge scores. */
export type DesignRubricScores = z.infer<typeof DesignRubricScoresSchema>;

/**
 * Fixed design rubric. Anchored descriptions per score keep a cheap judge
 * model's numbers comparable run over run — the trend is what matters.
 */
export const DESIGN_RUBRIC = `You are a senior web designer grading a screenshot of a freshly-deployed web page.

Score each axis as an integer 1-5:
- hierarchy: is it obvious what matters most? 1 = everything the same size/weight; 3 = clear h1 but flat below; 5 = clear, consistent heading levels guiding the eye.
- contrast: text legibility and figure/ground separation. 1 = hard-to-read text or washed-out; 3 = legible but low separation between sections; 5 = crisp, accessible contrast throughout.
- rhythm: spacing and section cadence. 1 = cramped or random gaps; 3 = even but monotonous; 5 = deliberate, consistent spacing with clear section breaks.
- polish: does it look hand-built by a professional? 1 = unstyled/broken; 3 = generic template; 5 = coherent, distinctive, finished.

Reply with EXACTLY one JSON object of the shape:
  {"hierarchy": <1-5>, "contrast": <1-5>, "rhythm": <1-5>, "polish": <1-5>, "notes": "<=40 words on the weakest axis>"}
No prose outside the JSON object.`;

/** Parse a raw `/v1/messages` response into design scores. */
export function parseDesignRubricScores(responseJson: unknown): DesignRubricScores {
  return parseJsonObjectText(extractResponseText(responseJson), DesignRubricScoresSchema);
}

/** Issue ONE design-rubric request (see {@link DESIGN_RUBRIC}). */
export async function fetchDesignRubricScores(opts: ExecuteOpts): Promise<DesignRubricScores> {
  return parseDesignRubricScores(await postVisionRequest(opts, opts.rubric ?? DESIGN_RUBRIC, 300));
}
