// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "bun:test";
import { providerEnvKey } from "../provider-env.js";

test("Google chat, image and credential display share env-key precedence", () => {
  expect(providerEnvKey("google", { GOOGLE_GENERATIVE_AI_API_KEY: "sdk-key" })).toBe("sdk-key");
  expect(
    providerEnvKey("google", { GOOGLE_API_KEY: "legacy", GOOGLE_GENERATIVE_AI_API_KEY: "sdk-key" }),
  ).toBe("legacy");
  expect(providerEnvKey("google", {})).toBeUndefined();
  expect(providerEnvKey("openai", { GOOGLE_API_KEY: "google" })).toBeUndefined();
});
