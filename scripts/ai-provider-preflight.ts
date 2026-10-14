// SPDX-License-Identifier: MPL-2.0

/**
 * Fail-fast provider probe for the real-AI suite (.github/workflows/e2e-livedit.yml).
 *
 * When the CI Anthropic account hit its spending limit, every scenario of the
 * suite failed on an unrelated-looking downstream assertion (a null module, a
 * missing <h1>) or a 6-minute Stage timeout, and the cause took half an hour
 * to find. This probe makes ONE minimal call with the CI key before anything
 * else runs (the cheapest catalog model, `max_tokens: 1`) and classifies the
 * answer:
 *
 *   - ok        — the suite runs.
 *   - fatal     — usage/spending limit, invalid key, permission, unknown
 *                 model: retrying cannot help. The job fails at once with the
 *                 provider's own message.
 *   - retryable — overloaded (529), 5xx, 429 rate limit, network failure:
 *                 retried with backoff; still failing after the last attempt
 *                 means "provider unavailable", and the job fails with that.
 *
 *   bun scripts/ai-provider-preflight.ts [--report <file>]
 *
 * Reads the key from ANTHROPIC_API_KEY_E2E and never prints it (a provider
 * message that happens to echo it is redacted too). On failure it writes the
 * reason to $GITHUB_STEP_SUMMARY, emits an `::error::` annotation and, with
 * `--report`, a Markdown file the PR-comment step posts instead of the
 * (absent) scenario results.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CATALOG_PATH = join(ROOT, "packages/admin-core/src/ai/model-catalog.json");
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** The probe's verdict on one provider answer. */
export type ProbeVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "fatal"; readonly message: string }
  | { readonly kind: "retryable"; readonly message: string };

/** One HTTP answer, reduced to what the classification reads. */
export interface ProbeResponse {
  readonly status: number;
  readonly body: string;
  /** Anthropic's `x-should-retry` header, when present. */
  readonly shouldRetry: string | null;
}

/**
 * Account states that look like ordinary 4xx/429 answers but will not clear
 * by retrying within a CI job: a spending/usage cap or an empty credit
 * balance. Matched on the message because Anthropic reports the usage cap as
 * a 400 `invalid_request_error`.
 */
const ACCOUNT_LIMIT = /usage limit|spend(ing)? limit|credit balance/i;

/** Pull `error.type` + `error.message` out of an Anthropic error body. */
function providerError(body: string): { type: string | null; message: string | null } {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown; message?: unknown } };
    const type = typeof parsed.error?.type === "string" ? parsed.error.type : null;
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : null;
    return { type, message };
  } catch {
    return { type: null, message: null };
  }
}

/**
 * Classify one provider answer. Order matters: an account limit is fatal
 * whatever the status says; then the provider's own `x-should-retry` hint;
 * then the status code (408/409/425/429/5xx retry, every other 4xx is fatal —
 * the probe request itself is fixed and well-formed, so a 4xx is about the
 * key, the account or the model, never transient).
 */
export function classifyProviderResponse(res: ProbeResponse): ProbeVerdict {
  if (res.status >= 200 && res.status < 300) return { kind: "ok" };
  const { type, message } = providerError(res.body);
  const text = `HTTP ${res.status}${type ? ` ${type}` : ""}: ${message ?? (res.body.slice(0, 300) || "(empty body)")}`;
  if (message && ACCOUNT_LIMIT.test(message)) return { kind: "fatal", message: text };
  if (res.shouldRetry === "false") return { kind: "fatal", message: text };
  if (res.shouldRetry === "true") return { kind: "retryable", message: text };
  const retryable =
    res.status === 408 ||
    res.status === 409 ||
    res.status === 425 ||
    res.status === 429 ||
    res.status >= 500;
  return { kind: retryable ? "retryable" : "fatal", message: text };
}

/** Replace every occurrence of the key in `text` — defence in depth. */
export function redactKey(text: string, apiKey: string): string {
  return apiKey.length > 0 ? text.split(apiKey).join("[redacted]") : text;
}

/** The catalog's cheapest Anthropic model (the `fast` slot). */
export function cheapestAnthropicModel(catalogJson: string): string {
  const catalog = JSON.parse(catalogJson) as {
    providers?: { anthropic?: { slots?: { role?: string; id?: string }[] } };
  };
  const id = catalog.providers?.anthropic?.slots?.find((s) => s.role === "fast")?.id;
  if (!id) {
    throw new Error(
      `ai-provider-preflight: no anthropic "fast" slot in ${CATALOG_PATH} — the probe needs the cheapest model id`,
    );
  }
  return id;
}

export interface PreflightResult {
  readonly ok: boolean;
  /** "fatal" = the provider refused the key/account; "unavailable" = retries exhausted. */
  readonly failure: "fatal" | "unavailable" | null;
  readonly message: string;
  readonly attempts: number;
}

export interface PreflightDeps {
  /** Sends the probe; throws on a network failure. */
  readonly send: () => Promise<ProbeResponse>;
  readonly sleep: (ms: number) => Promise<void>;
  /** Waits before attempts 2..n; its length + 1 is the attempt count. */
  readonly backoffMs: readonly number[];
}

/** Run the probe with retries on retryable answers only. */
export async function runPreflight(deps: PreflightDeps): Promise<PreflightResult> {
  const maxAttempts = deps.backoffMs.length + 1;
  let last = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let verdict: ProbeVerdict;
    try {
      verdict = classifyProviderResponse(await deps.send());
    } catch (e) {
      verdict = {
        kind: "retryable",
        message: `network error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (verdict.kind === "ok") {
      return { ok: true, failure: null, message: "provider reachable", attempts: attempt };
    }
    if (verdict.kind === "fatal") {
      return { ok: false, failure: "fatal", message: verdict.message, attempts: attempt };
    }
    last = verdict.message;
    const wait = deps.backoffMs[attempt - 1];
    if (wait !== undefined) await deps.sleep(wait);
  }
  return { ok: false, failure: "unavailable", message: last, attempts: maxAttempts };
}

/** The Markdown the step summary and the PR comment show on failure. */
export function failureReport(result: PreflightResult, model: string): string {
  const headline =
    result.failure === "fatal"
      ? "The AI provider refused the CI key, so the real-AI scenarios were not run."
      : `The AI provider was unavailable (${result.attempts} attempts), so the real-AI scenarios were not run.`;
  const next =
    result.failure === "fatal"
      ? "This is an account/key problem, not a regression in this change: fix the account (spending limit, credit balance, key, permissions) and re-run the job."
      : "Re-run the job once the provider recovers; this is not a regression in this change.";
  return [
    "## Real-AI suite: provider preflight failed",
    "",
    headline,
    "",
    `Provider answer (probe model \`${model}\`, \`max_tokens: 1\`):`,
    "",
    "```",
    result.message,
    "```",
    "",
    next,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY_E2E ?? "";
  if (apiKey === "") {
    console.error("::error title=AI provider preflight::ANTHROPIC_API_KEY_E2E is not set");
    process.exit(1);
  }
  const reportIdx = process.argv.indexOf("--report");
  const reportPath = reportIdx >= 0 ? process.argv[reportIdx + 1] : undefined;
  const model = cheapestAnthropicModel(readFileSync(CATALOG_PATH, "utf8"));

  const result = await runPreflight({
    backoffMs: [5_000, 15_000, 30_000],
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    send: async () => {
      const res = await fetch(MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      return {
        status: res.status,
        body: await res.text(),
        shouldRetry: res.headers.get("x-should-retry"),
      };
    },
  });

  if (result.ok) {
    console.log(`AI provider preflight: ok (model ${model}, attempt ${result.attempts})`);
    return;
  }
  const safe = { ...result, message: redactKey(result.message, apiKey) };
  const report = failureReport(safe, model);
  const oneLine = safe.message.replace(/\s+/g, " ");
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, `${report}\n`);
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, report);
  }
  console.error(
    safe.failure === "fatal"
      ? `::error title=AI provider refused the CI key::${oneLine}`
      : `::error title=AI provider unavailable::${oneLine}`,
  );
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
