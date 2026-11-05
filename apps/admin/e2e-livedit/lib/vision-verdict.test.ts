// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_VISION_MODEL,
  fetchDesignRubricScores,
  fetchVisionVerdict,
  parseDesignRubricScores,
  parseVisionVerdict,
  VisionVerdictParseError,
  VisionVerdictRequestError,
  VisionVerdictSchemaError,
} from "./vision-verdict.js";

const textResponse = (text: string) => ({ content: [{ type: "text", text }] });

describe("parseVisionVerdict", () => {
  it("reads a fenced verdict", () => {
    expect(
      parseVisionVerdict(textResponse('```json\n{"ok": true, "reason": "fine"}\n```')),
    ).toEqual({
      ok: true,
      reason: "fine",
    });
  });

  it("rejects extra fields and non-JSON", () => {
    expect(() =>
      parseVisionVerdict(textResponse('{"ok": true, "reason": "x", "confidence": 1}')),
    ).toThrow(VisionVerdictSchemaError);
    expect(() => parseVisionVerdict(textResponse("looks good"))).toThrow(VisionVerdictParseError);
  });
});

describe("parseDesignRubricScores", () => {
  it("reads integer scores behind a leading sentence", () => {
    expect(
      parseDesignRubricScores(
        textResponse(
          'Here you go: {"hierarchy": 4, "contrast": 5, "rhythm": 3, "polish": 4, "notes": "rhythm flat"}',
        ),
      ),
    ).toEqual({ hierarchy: 4, contrast: 5, rhythm: 3, polish: 4, notes: "rhythm flat" });
  });

  it("rejects out-of-range and fractional scores", () => {
    expect(() =>
      parseDesignRubricScores(
        textResponse('{"hierarchy": 6, "contrast": 5, "rhythm": 3, "polish": 4, "notes": ""}'),
      ),
    ).toThrow(VisionVerdictSchemaError);
    expect(() =>
      parseDesignRubricScores(
        textResponse('{"hierarchy": 3.5, "contrast": 5, "rhythm": 3, "polish": 4, "notes": ""}'),
      ),
    ).toThrow(VisionVerdictSchemaError);
  });

  it("rejects a response without text blocks", () => {
    expect(() => parseDesignRubricScores({ content: [{ type: "tool_use" }] })).toThrow(
      VisionVerdictSchemaError,
    );
  });
});

describe("what Claude Haiku 5.5 accepts and answers (#1477)", () => {
  const capture = () => {
    const sent: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "", signature: "s" },
          { type: "text", text: '{"ok":true,"reason":"fine"}' },
        ],
      });
    }) as typeof fetch;
    return { sent, fetchImpl };
  };

  it("sends no sampling parameter and leaves room for thinking", async () => {
    const { sent, fetchImpl } = capture();
    const verdict = await fetchVisionVerdict({
      apiKey: "k",
      screenshotBase64: "AA==",
      fetchImpl,
    });
    expect(verdict).toEqual({ ok: true, reason: "fine" });
    const body = sent[0] as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_VISION_MODEL);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("thinking");
    expect(body.max_tokens as number).toBeGreaterThanOrEqual(1024);
  });

  it("names a refusal instead of a schema error", () => {
    expect(() => parseVisionVerdict({ stop_reason: "refusal", content: [] })).toThrow(/declined/);
  });

  it("names thinking that used up the cap", () => {
    expect(() =>
      parseVisionVerdict({
        stop_reason: "max_tokens",
        content: [{ type: "thinking", thinking: "", signature: "s" }],
      }),
    ).toThrow(/max_tokens/);
  });
});

describe("request retry", () => {
  const ok = (text: string) => new Response(JSON.stringify(textResponse(text)), { status: 200 });
  const noSleep = async () => {};

  it("retries once on 5xx, then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1
        ? new Response("overloaded", { status: 529 })
        : ok('{"hierarchy": 3, "contrast": 3, "rhythm": 3, "polish": 3, "notes": "ok"}');
    }) as unknown as typeof fetch;
    const scores = await fetchDesignRubricScores({
      apiKey: "k",
      screenshotBase64: "",
      fetchImpl,
      sleep: noSleep,
    });
    expect(calls).toBe(2);
    expect(scores.polish).toBe(3);
  });

  it("does not retry a 4xx", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("bad", { status: 400 });
    }) as unknown as typeof fetch;
    await expect(
      fetchVisionVerdict({ apiKey: "k", screenshotBase64: "", fetchImpl, sleep: noSleep }),
    ).rejects.toBeInstanceOf(VisionVerdictRequestError);
    expect(calls).toBe(1);
  });
});
