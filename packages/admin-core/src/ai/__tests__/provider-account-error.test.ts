// SPDX-License-Identifier: MPL-2.0

/**
 * Provider account refusals (quota, billing, key) vs everything else. Each
 * case is the provider's real answer shape wrapped the way the AI SDK hands
 * it to us: an `APICallError` (status + parsed `data` + raw body), or a
 * `RetryError` around it when the SDK retried a 429 first.
 */

import { describe, expect, it } from "bun:test";
import { APICallError, RetryError } from "ai";

import {
  classifyProviderAccountError,
  classifyProviderAccountMessage,
  PROVIDER_ACCOUNT_NOTICE_PREFIX,
  providerAccountNotice,
} from "../provider-account-error.js";

function apiError(statusCode: number, body: unknown, message?: string): APICallError {
  const responseBody = JSON.stringify(body);
  const err = (body as { error?: { message?: string } }).error;
  return new APICallError({
    message: message ?? err?.message ?? "error",
    url: "https://provider.example/v1",
    requestBodyValues: {},
    statusCode,
    responseBody,
    data: body,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

const ANTHROPIC_USAGE_LIMIT = apiError(400, {
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
  },
});

describe("classifyProviderAccountError — quota / billing", () => {
  it("Anthropic usage limit (400 invalid_request_error, run 40432865086)", () => {
    expect(classifyProviderAccountError(ANTHROPIC_USAGE_LIMIT)).toMatchObject({
      kind: "quota",
      statusCode: 400,
    });
  });

  it("Anthropic credit balance too low", () => {
    const e = apiError(400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
    });
    expect(classifyProviderAccountError(e)?.kind).toBe("quota");
  });

  it("OpenAI insufficient_quota, after the SDK retried the 429", () => {
    const last = apiError(429, {
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        param: null,
        code: "insufficient_quota",
      },
    });
    const retry = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [last, last, last],
    });
    expect(classifyProviderAccountError(retry)).toMatchObject({ kind: "quota", statusCode: 429 });
  });

  it("Google billing quota (429 RESOURCE_EXHAUSTED)", () => {
    const e = apiError(429, {
      error: {
        code: 429,
        message:
          "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    expect(classifyProviderAccountError(e)?.kind).toBe("quota");
  });

  it("402 Payment Required", () => {
    expect(classifyProviderAccountError(apiError(402, { error: { message: "pay" } }))?.kind).toBe(
      "quota",
    );
  });

  it("reads the raw body when the SDK could not parse `data`", () => {
    const e = new APICallError({
      message: "Bad Request",
      url: "https://provider.example/v1",
      requestBodyValues: {},
      statusCode: 400,
      responseBody: JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "You have reached your specified API usage limits.",
        },
      }),
    });
    expect(classifyProviderAccountError(e)?.kind).toBe("quota");
  });

  it("finds an APICallError behind a cause chain", () => {
    const wrapped = new Error("stream failed", { cause: ANTHROPIC_USAGE_LIMIT });
    expect(classifyProviderAccountError(wrapped)?.kind).toBe("quota");
  });
});

describe("classifyProviderAccountError — key / permission", () => {
  it("Anthropic invalid key (401 authentication_error)", () => {
    const e = apiError(401, {
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
    });
    expect(classifyProviderAccountError(e)).toMatchObject({ kind: "auth", statusCode: 401 });
  });

  it("Anthropic permission_error (403)", () => {
    const e = apiError(403, {
      type: "error",
      error: { type: "permission_error", message: "Your API key does not have permission" },
    });
    expect(classifyProviderAccountError(e)?.kind).toBe("auth");
  });

  it("OpenAI invalid_api_key (401)", () => {
    const e = apiError(401, {
      error: {
        message: "Incorrect API key provided",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
    expect(classifyProviderAccountError(e)?.kind).toBe("auth");
  });

  it("Google API_KEY_INVALID (a 400)", () => {
    const e = apiError(400, {
      error: {
        code: 400,
        message: "API key not valid. Please pass a valid API key.",
        status: "INVALID_ARGUMENT",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" },
        ],
      },
    });
    expect(classifyProviderAccountError(e)?.kind).toBe("auth");
  });
});

describe("classifyProviderAccountError — NOT account problems (stay bugs / retries)", () => {
  it("a tool_use/tool_result pairing 400 is a Caelo defect", () => {
    const e = apiError(400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "messages.4: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_1",
      },
    });
    expect(classifyProviderAccountError(e)).toBeNull();
  });

  it("a plain rate limit and an overload are not quota", () => {
    expect(
      classifyProviderAccountError(
        apiError(429, {
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "Number of request tokens has exceeded your per-minute rate limit",
          },
        }),
      ),
    ).toBeNull();
    expect(
      classifyProviderAccountError(
        apiError(529, {
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
        }),
      ),
    ).toBeNull();
  });

  it("the prompt-too-long 400 and a non-SDK error are not account problems", () => {
    expect(
      classifyProviderAccountError(
        apiError(400, {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "prompt is too long: 210000 tokens > 200000 maximum",
          },
        }),
      ),
    ).toBeNull();
    expect(classifyProviderAccountError(new Error("socket hang up"))).toBeNull();
    expect(classifyProviderAccountError(undefined)).toBeNull();
  });
});

describe("message fallback + notice", () => {
  it("matches only account wording", () => {
    expect(
      classifyProviderAccountMessage("You have reached your specified API usage limits.")?.kind,
    ).toBe("quota");
    expect(classifyProviderAccountMessage("invalid_api_key")?.kind).toBe("auth");
    expect(
      classifyProviderAccountMessage("tool_use ids were found without tool_result"),
    ).toBeNull();
  });

  it("the chat notice is brand-free and points the Owner at Settings → AI", () => {
    for (const kind of ["quota", "auth"] as const) {
      const text = providerAccountNotice({ kind });
      expect(text.startsWith(PROVIDER_ACCOUNT_NOTICE_PREFIX)).toBe(true);
      expect(text).toContain("Settings → AI");
      expect(text.toLowerCase()).not.toMatch(/anthropic|claude|openai|gemini|google/);
    }
    expect(providerAccountNotice({ kind: "quota" })).toContain("limit");
    expect(providerAccountNotice({ kind: "auth" })).toContain("API key");
  });
});
