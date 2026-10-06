// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "bun:test";
import { catalogSlots } from "../model-catalog.js";

test("OpenAI default catalog slot selects GPT-5.5", () => {
  expect(catalogSlots("openai")).toEqual([
    {
      role: "default",
      note: "",
      match: "^gpt-\\d+(\\.\\d+)?o?$",
      id: "gpt-5.5",
      label: "GPT-5.5",
    },
  ]);
});
