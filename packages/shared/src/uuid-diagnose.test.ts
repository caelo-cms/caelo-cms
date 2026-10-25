// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { describeMalformedUuid } from "./uuid-diagnose.js";

describe("describeMalformedUuid (#1094)", () => {
  it("returns null for a well-formed UUID", () => {
    expect(describeMalformedUuid("c9c7ddcb-cc85-4747-84fa-90967da6f769")).toBeNull();
  });

  it("names the group that is a character short (the #1094 id)", () => {
    expect(describeMalformedUuid("c9c7ddcb-cc85-4747-84f-90967da6f769")).toBe(
      '"c9c7ddcb-cc85-4747-84f-90967da6f769" is not a UUID: group 4 has 3 character(s) (expected 4; a UUID is 8-4-4-4-12)',
    );
  });

  it("names a shortened id", () => {
    expect(describeMalformedUuid("b2208906…")).toMatch(/shortened/);
  });

  it("names a wrong group count and non-hex characters", () => {
    expect(describeMalformedUuid("abc")).toMatch(/1 dash-separated group/);
    expect(describeMalformedUuid("c9c7ddcb-cc85-4747-84fa-90967da6f76z")).toMatch(
      /group 5 contains non-hex/,
    );
    expect(describeMalformedUuid(42)).toMatch(/expected a string/);
  });
});
