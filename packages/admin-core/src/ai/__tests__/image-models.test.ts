// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "bun:test";
import {
  capabilityRefusal,
  imageCapabilities,
  imageReserveMicrocents,
  settleImageCostMicrocents,
} from "../image-models.js";

const ref = (bytes = 1000, mediaType = "image/png") => ({ bytes, mediaType });

test("unknown models have no profile — callers refuse them before paying", () => {
  expect(imageCapabilities("some-new-model")).toBeNull();
  expect(imageReserveMicrocents("some-new-model")).toBeNull();
  expect(() => settleImageCostMicrocents("some-new-model", {})).toThrow("no pricing profile");
});

test("requests outside a model's capabilities are refused with the limit named", () => {
  const dalle = imageCapabilities("dall-e-3")!;
  const gemini = imageCapabilities("gemini-3.1-flash-image")!;
  const legacy = imageCapabilities("gemini-2.5-flash-image")!;
  const generate = { operation: "generate" as const, references: [], mask: false };

  expect(capabilityRefusal(gemini, generate)).toBeNull();
  expect(capabilityRefusal(dalle, { ...generate, operation: "edit" })).toContain("cannot edit");
  expect(capabilityRefusal(dalle, { ...generate, references: [ref()] })).toContain("at most 0");
  expect(capabilityRefusal(gemini, { ...generate, operation: "edit", mask: true })).toContain(
    "mask",
  );
  expect(
    capabilityRefusal(gemini, { ...generate, references: Array.from({ length: 15 }, () => ref()) }),
  ).toContain("at most 14");
  expect(capabilityRefusal(gemini, { ...generate, references: [ref(11_000_000)] })).toContain(
    "larger than",
  );
  expect(
    capabilityRefusal(gemini, { ...generate, references: [ref(1000, "image/gif")] }),
  ).toContain("image/gif");
  expect(capabilityRefusal(legacy, { ...generate, imageSize: "4K" })).toContain(
    "no selectable resolution",
  );
  expect(capabilityRefusal(gemini, { ...generate, imageSize: "4K" })).toBeNull();
});

test("settled cost follows the model's pricing; unknown usage keeps the reservation", () => {
  expect(settleImageCostMicrocents("dall-e-3", { size: "1024x1024" })).toBe(4_000_000);
  expect(settleImageCostMicrocents("dall-e-3", { size: "1792x1024", quality: "hd" })).toBe(
    12_000_000,
  );
  expect(
    settleImageCostMicrocents(
      "gemini-3.1-flash-image",
      {},
      { inputTokens: 100, outputTokens: 1290 },
    ),
  ).toBe(Math.ceil((100 * 0.5 + 1290 * 60) * 100));
  expect(settleImageCostMicrocents("gemini-3.1-flash-image", {})).toBe(
    imageReserveMicrocents("gemini-3.1-flash-image") as number,
  );
  expect(settleImageCostMicrocents("fake-image", {})).toBe(0);
});
