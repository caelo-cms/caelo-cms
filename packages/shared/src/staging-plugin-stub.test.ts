// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  isPluginCallPath,
  STAGING_PLUGIN_STUB_BODY,
  STAGING_PREVIEW_ERROR_KIND,
} from "./staging-plugin-stub.js";

describe("staging plugin stub (#1326)", () => {
  it("is an ok:false answer of its own kind, with nothing else", () => {
    expect(JSON.parse(STAGING_PLUGIN_STUB_BODY)).toEqual({
      ok: false,
      error: { kind: STAGING_PREVIEW_ERROR_KIND },
    });
  });

  it("recognises plugin calls only", () => {
    expect(isPluginCallPath("/api/plugin/forms/submit")).toBe(true);
    expect(isPluginCallPath("/api/captcha/challenge")).toBe(false);
    expect(isPluginCallPath("/api/variant.js")).toBe(false);
  });
});
