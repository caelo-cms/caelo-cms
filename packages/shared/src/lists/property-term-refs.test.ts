// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { propertyTermRefs } from "./fields.js";

const L = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";

describe("propertyTermRefs (#1753)", () => {
  it("reads every term reference of the properties once, in order, arrays included", () => {
    expect(
      propertyTermRefs({
        expertise: [`caelo:term/${L}/${A}`, `caelo:term/${L}/${B}`],
        main_topic: `caelo:term/${L}/${A}`,
        title: "caelo:term/not-a-ref",
        author: [`caelo:page/${A}`],
        count: 3,
      }),
    ).toEqual([
      { listId: L, itemId: A },
      { listId: L, itemId: B },
    ]);
    expect(propertyTermRefs({})).toEqual([]);
  });
});
