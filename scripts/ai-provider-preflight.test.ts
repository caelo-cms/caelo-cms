// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cheapestAnthropicModel,
  classifyProviderResponse,
  failureReport,
  type ProbeResponse,
  redactKey,
  runPreflight,
} from "./ai-provider-preflight.js";

function anthropicError(type: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message }, request_id: "req_1" });
}

function res(status: number, body = "", shouldRetry: string | null = null): ProbeResponse {
  return { status, body, shouldRetry };
}

describe("classifyProviderResponse", () => {
  it("accepts a 2xx answer", () => {
    expect(classifyProviderResponse(res(200, "{}")).kind).toBe("ok");
  });

  it("treats the spending/usage limit as fatal — the run 38455081117 answer", () => {
    // Verbatim shape of the answer that made every scenario fail downstream.
    const v = classifyProviderResponse(
      res(
        400,
        anthropicError(
          "invalid_request_error",
          "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
        ),
        "false",
      ),
    );
    expect(v.kind).toBe("fatal");
    expect(v.kind !== "ok" && v.message).toContain(
      "You have reached your specified API usage limits",
    );
    expect(v.kind !== "ok" && v.message).toContain("HTTP 400 invalid_request_error");
  });

  it("treats an account limit as fatal even on a retryable status", () => {
    const v = classifyProviderResponse(
      res(429, anthropicError("rate_limit_error", "Your credit balance is too low"), "true"),
    );
    expect(v.kind).toBe("fatal");
  });

  it("treats an invalid key, a permission error and an unknown model as fatal", () => {
    expect(
      classifyProviderResponse(
        res(401, anthropicError("authentication_error", "invalid x-api-key")),
      ).kind,
    ).toBe("fatal");
    expect(
      classifyProviderResponse(res(403, anthropicError("permission_error", "not allowed"))).kind,
    ).toBe("fatal");
    expect(
      classifyProviderResponse(res(404, anthropicError("not_found_error", "model: x"))).kind,
    ).toBe("fatal");
  });

  it("retries overloaded, 5xx and rate-limit answers", () => {
    expect(
      classifyProviderResponse(res(529, anthropicError("overloaded_error", "Overloaded"))).kind,
    ).toBe("retryable");
    expect(classifyProviderResponse(res(500, anthropicError("api_error", "boom"))).kind).toBe(
      "retryable",
    );
    expect(classifyProviderResponse(res(503, "")).kind).toBe("retryable");
    expect(
      classifyProviderResponse(res(429, anthropicError("rate_limit_error", "slow down"))).kind,
    ).toBe("retryable");
  });

  it("follows the provider's x-should-retry hint over the status code", () => {
    expect(classifyProviderResponse(res(500, "", "false")).kind).toBe("fatal");
    expect(classifyProviderResponse(res(400, "", "true")).kind).toBe("retryable");
  });

  it("quotes a non-JSON body when there is no structured error", () => {
    const v = classifyProviderResponse(res(502, "<html>Bad gateway</html>"));
    expect(v.kind !== "ok" && v.message).toBe("HTTP 502: <html>Bad gateway</html>");
    const empty = classifyProviderResponse(res(502, ""));
    expect(empty.kind !== "ok" && empty.message).toBe("HTTP 502: (empty body)");
  });
});

describe("runPreflight", () => {
  const noSleep = { sleep: async () => undefined, backoffMs: [1, 2, 3] };

  it("stops at the first fatal answer without retrying", async () => {
    let calls = 0;
    const r = await runPreflight({
      ...noSleep,
      send: async () => {
        calls++;
        return res(400, anthropicError("invalid_request_error", "usage limits reached"));
      },
    });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ ok: false, failure: "fatal", attempts: 1 });
  });

  it("retries retryable answers with the configured backoff, then succeeds", async () => {
    const waits: number[] = [];
    const answers = [res(529), res(503), res(200, "{}")];
    const r = await runPreflight({
      backoffMs: [10, 20, 30],
      sleep: async (ms) => {
        waits.push(ms);
      },
      send: async () => answers.shift() ?? res(200),
    });
    expect(r).toMatchObject({ ok: true, attempts: 3 });
    expect(waits).toEqual([10, 20]);
  });

  it("reports the provider unavailable once every attempt failed", async () => {
    let calls = 0;
    const r = await runPreflight({
      ...noSleep,
      send: async () => {
        calls++;
        return res(529, anthropicError("overloaded_error", "Overloaded"));
      },
    });
    expect(calls).toBe(4);
    expect(r.failure).toBe("unavailable");
    expect(r.message).toContain("Overloaded");
  });

  it("treats a network failure as retryable", async () => {
    let calls = 0;
    const r = await runPreflight({
      ...noSleep,
      send: async () => {
        calls++;
        if (calls === 1) throw new Error("ECONNRESET");
        return res(200, "{}");
      },
    });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });
});

describe("helpers", () => {
  it("redacts the key wherever it appears", () => {
    expect(redactKey("bad key sk-ant-123 (sk-ant-123)", "sk-ant-123")).toBe(
      "bad key [redacted] ([redacted])",
    );
    expect(redactKey("nothing", "")).toBe("nothing");
  });

  it("reads the cheapest model from the real catalog", () => {
    const catalog = readFileSync(
      resolve(import.meta.dir, "../packages/admin-core/src/ai/model-catalog.json"),
      "utf8",
    );
    expect(cheapestAnthropicModel(catalog)).toMatch(/^claude-haiku-/);
    expect(() => cheapestAnthropicModel('{"providers":{}}')).toThrow(/"fast" slot/);
  });

  it("writes a report that names the cause and says it is not a regression", () => {
    const fatal = failureReport(
      { ok: false, failure: "fatal", message: "HTTP 400: usage limits", attempts: 1 },
      "claude-haiku-4-5",
    );
    expect(fatal).toContain("refused the CI key");
    expect(fatal).toContain("HTTP 400: usage limits");
    expect(fatal).toContain("not a regression");
    const down = failureReport(
      { ok: false, failure: "unavailable", message: "HTTP 529", attempts: 4 },
      "claude-haiku-4-5",
    );
    expect(down).toContain("unavailable (4 attempts)");
  });
});
