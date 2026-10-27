// SPDX-License-Identifier: MPL-2.0

/**
 * Provider ACCOUNT problems — quota, billing, credit, key — told apart from
 * Caelo defects.
 *
 * When the configured provider account hits its usage limit (Anthropic: "You
 * have reached your specified API usage limits…", a 400), runs out of credit,
 * or the key is invalid or revoked, the chat turn fails on the provider call.
 * Filed as a turn-fatal `ai_bug_reports` row, each such failure became a
 * `blocking` bug that the bug intake forwarded as a GitHub issue — but nothing
 * in Caelo is broken: the Owner has to raise the limit or fix the key at the
 * provider. This module recognises those answers so the chat-runner can tell
 * the operator what to do and file no bug.
 *
 * Classification reads the AI SDK's `APICallError` (CLAUDE.md §12): the HTTP
 * status plus the provider's parsed error body (`data`, or `responseBody`
 * when `data` is absent). The status alone is not enough — Anthropic reports
 * the usage cap and an empty credit balance as a plain 400
 * `invalid_request_error`, the same status a malformed request gets — so for
 * those two the provider's message is matched too. Retried calls (OpenAI
 * returns `insufficient_quota` as a 429, which the SDK retries) arrive as a
 * `RetryError`; its last error is classified. A non-SDK error falls back to
 * matching the message, for the few paths that only carry text.
 */

import { APICallError, RetryError } from "ai";

/**
 * `quota` — usage/spending/billing limit or credit used up (raise it at the
 * provider). `auth` — the key is invalid, revoked or lacks permission (fix the
 * key under Settings → AI).
 */
export type ProviderAccountIssueKind = "quota" | "auth";

/** A provider refusal that is about the account, not about Caelo. */
export interface ProviderAccountIssue {
  readonly kind: ProviderAccountIssueKind;
  /** HTTP status of the provider answer, when known. */
  readonly statusCode: number | null;
  /**
   * The provider's own message. May name the provider — for server logs and
   * Owner surfaces only, never the editor chat (CLAUDE.md §2).
   */
  readonly providerMessage: string;
}

/**
 * Account-limit wording the providers use where no machine-readable code
 * exists (Anthropic's usage cap + credit balance are 400s with only a
 * message; Google's billing quota is a 429 shared with per-minute limits).
 */
const QUOTA_MESSAGE =
  /usage limits?|spend(?:ing)? limit|credit balance|exceeded your current quota|check your plan and billing|billing (?:hard )?limit|insufficient[_ ]quota|billing details/i;
/** Key wording, for 400s that are really key failures (Google: API_KEY_INVALID). */
const AUTH_MESSAGE =
  /api[_ ]key[_ ](?:not[_ ]valid|invalid)|invalid[_ ]api[_ ]key|incorrect api key/i;
/** OpenAI / OpenAI-compatible error codes that mean "out of quota or billing". */
const QUOTA_CODES = new Set([
  "insufficient_quota",
  "billing_hard_limit_reached",
  "billing_not_active",
  "access_terminated",
]);
/** Error codes / types that mean "the key or its permissions are wrong". */
const AUTH_CODES = new Set([
  "invalid_api_key",
  "authentication_error",
  "permission_error",
  "permission_denied",
  "api_key_invalid",
  "unauthenticated",
]);

interface ErrorBodyFacts {
  readonly codes: string[];
  readonly message: string | null;
}

/**
 * Pull the error codes and message out of a provider error body. Anthropic:
 * `{error:{type,message}}`; OpenAI: `{error:{type,code,message}}`; Google:
 * `{error:{code,status,message,details:[{reason}]}}`.
 */
function bodyFacts(data: unknown, responseBody: string | undefined): ErrorBodyFacts {
  let parsed: unknown = data;
  if (parsed === undefined && typeof responseBody === "string") {
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      parsed = undefined;
    }
  }
  const err = (parsed as { error?: unknown } | null | undefined)?.error;
  if (err === null || typeof err !== "object") {
    return { codes: [], message: typeof responseBody === "string" ? responseBody : null };
  }
  const e = err as Record<string, unknown>;
  const codes: string[] = [];
  for (const key of ["type", "code", "status"] as const) {
    const v = e[key];
    if (typeof v === "string") codes.push(v.toLowerCase());
  }
  if (Array.isArray(e.details)) {
    for (const d of e.details) {
      const reason = (d as { reason?: unknown } | null)?.reason;
      if (typeof reason === "string") codes.push(reason.toLowerCase());
    }
  }
  return { codes, message: typeof e.message === "string" ? e.message : null };
}

/** Classify one HTTP answer of a provider. Exported for unit tests. */
export function classifyProviderHttpError(args: {
  statusCode: number | undefined;
  data?: unknown;
  responseBody?: string;
  message: string;
}): ProviderAccountIssue | null {
  const { codes, message } = bodyFacts(args.data, args.responseBody);
  const text = message ?? args.message;
  const status = args.statusCode ?? null;
  const issue = (kind: ProviderAccountIssueKind): ProviderAccountIssue => ({
    kind,
    statusCode: status,
    providerMessage: text.slice(0, 1000),
  });
  if (codes.some((c) => QUOTA_CODES.has(c))) return issue("quota");
  if (status === 402) return issue("quota");
  // Anthropic's usage cap / credit balance (400 invalid_request_error) and
  // Google's billing quota (429 RESOURCE_EXHAUSTED) carry no specific code.
  // A plain per-minute rate limit does not match QUOTA_MESSAGE and stays a
  // retryable provider error.
  if ((status === 400 || status === 403 || status === 429) && QUOTA_MESSAGE.test(text)) {
    return issue("quota");
  }
  if (status === 401) return issue("auth");
  if (codes.some((c) => AUTH_CODES.has(c))) return issue("auth");
  if (status === 403) return issue("auth");
  if (status === 400 && AUTH_MESSAGE.test(text)) return issue("auth");
  return null;
}

/**
 * Classify any error the SDK surfaced (a stream `error` part, a thrown
 * `generateText` / `generateImage` failure). Returns null for everything that
 * is not an account problem — those stay turn-fatal provider errors.
 */
export function classifyProviderAccountError(error: unknown): ProviderAccountIssue | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (APICallError.isInstance(current)) {
      return classifyProviderHttpError({
        statusCode: current.statusCode,
        data: current.data,
        ...(current.responseBody !== undefined ? { responseBody: current.responseBody } : {}),
        message: current.message,
      });
    }
    if (RetryError.isInstance(current)) {
      current = current.lastError;
      continue;
    }
    const cause = (current as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null) {
      current = cause;
      continue;
    }
    break;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  return message === null ? null : classifyProviderAccountMessage(message);
}

/**
 * Message-only fallback for paths that carry no SDK error object. Narrower
 * than the HTTP classification: only wording that cannot describe a Caelo
 * defect.
 */
export function classifyProviderAccountMessage(message: string): ProviderAccountIssue | null {
  if (QUOTA_MESSAGE.test(message)) {
    return { kind: "quota", statusCode: null, providerMessage: message.slice(0, 1000) };
  }
  if (AUTH_MESSAGE.test(message)) {
    return { kind: "auth", statusCode: null, providerMessage: message.slice(0, 1000) };
  }
  return null;
}

/**
 * First words of every account notice. The real-AI suite keys its fail-fast
 * check on this prefix (`apps/admin/e2e-livedit/lib/turn-failure.ts`).
 */
export const PROVIDER_ACCOUNT_NOTICE_PREFIX = "The AI can't answer right now:";

/**
 * The operator-facing chat notice. Brand-free on purpose: the editor chat
 * never names the provider (CLAUDE.md §2); Settings → AI does.
 *
 * It makes no claim about what the turn changed: the limit can hit on a
 * continuation after tool calls already wrote, and those writes stay. So it
 * points the operator at the chat before they repeat the request.
 */
export function providerAccountNotice(issue: Pick<ProviderAccountIssue, "kind">): string {
  const resume =
    "Changes the AI already made in this turn stay; check the chat and the preview, then ask " +
    "it to continue where it stopped rather than repeating the whole request.";
  return issue.kind === "quota"
    ? `${PROVIDER_ACCOUNT_NOTICE_PREFIX} the usage, spending or billing limit of the configured ` +
        "AI provider account is used up. An Owner has to raise the limit or add credit at the " +
        "provider (Settings → AI shows which provider and key are configured). " +
        resume
    : `${PROVIDER_ACCOUNT_NOTICE_PREFIX} the configured AI provider rejected the API key ` +
        "(invalid, revoked or without permission). An Owner has to check or replace the key " +
        `under Settings → AI. ${resume}`;
}
