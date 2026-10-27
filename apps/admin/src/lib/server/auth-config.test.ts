// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { authConfigView, parsePasswordMinLength } from "./auth-config.js";

describe("authConfigView (#854)", () => {
  it("shows only the error, no default values, when the read fails", () => {
    const v = authConfigView({ ok: false, error: { message: "auth_config row missing" } });
    expect(v).toEqual({ config: null, error: "auth_config row missing" });
  });

  it("passes the stored config through", () => {
    const config = { id: "x", signupOpen: false, passwordMinLength: 12, updatedAt: null };
    expect(authConfigView({ ok: true, value: config })).toEqual({ config, error: null });
  });
});

describe("parsePasswordMinLength", () => {
  it("refuses a missing value instead of defaulting to 8", () => {
    expect(parsePasswordMinLength(null)).toBeTypeOf("string");
    expect(parsePasswordMinLength("")).toBeTypeOf("string");
    expect(parsePasswordMinLength("7")).toBeTypeOf("string");
    expect(parsePasswordMinLength("12")).toBe(12);
  });
});
