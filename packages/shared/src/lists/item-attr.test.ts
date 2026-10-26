// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "bun:test";
import { parseListItemAttr } from "./item-attr.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("data-caelo-list-item values", () => {
  test("parse the three stamped forms", () => {
    expect(parseListItemAttr(`${A}/${B}`)).toEqual({ kind: "shared", listId: A, itemId: B });
    expect(parseListItemAttr(`instance/${A}/nav_links/${B}`)).toEqual({
      kind: "instance",
      contentInstanceId: A,
      field: "nav_links",
      itemId: B,
    });
    expect(parseListItemAttr(`local/nav_links/${B}`)).toEqual({
      kind: "local",
      field: "nav_links",
      itemId: B,
    });
  });

  test("refuse anything else", () => {
    for (const v of [
      "",
      `${A}`,
      `${A}/${B}/x`,
      `instance/${A}/${B}`,
      `local/Nav/${B}`,
      `AAAAAAAA-1111-4111-8111-111111111111/${B}`,
    ]) {
      expect(parseListItemAttr(v)).toBeNull();
    }
  });
});
