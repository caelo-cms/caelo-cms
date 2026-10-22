// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
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
