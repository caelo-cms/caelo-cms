// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { tagModuleId } from "./module-id-tag.js";

describe("tagModuleId", () => {
  it("stamps the first opening tag", () => {
    expect(tagModuleId('<p class="a">hi</p>', "m1")).toBe(
      '<p class="a" data-caelo-module-id="m1">hi</p>',
    );
  });

  it("keeps a self-closing root self-closed (#1099)", () => {
    expect(tagModuleId('<line x1="0" stroke="#E3E7EE"/>', "m1")).toBe(
      '<line x1="0" stroke="#E3E7EE" data-caelo-module-id="m1"/>',
    );
    expect(tagModuleId('<circle r="2" />', "m1")).toBe('<circle r="2" data-caelo-module-id="m1"/>');
    expect(tagModuleId("<br/>", "m1")).toBe('<br data-caelo-module-id="m1"/>');
  });

  it("does not mistake a slash inside a quoted value for self-closing", () => {
    expect(tagModuleId('<a href="/">x</a>', "m1")).toBe(
      '<a href="/" data-caelo-module-id="m1">x</a>',
    );
  });

  it("is idempotent", () => {
    const once = tagModuleId('<polyline points="0,0 1,1"/>', "m1");
    expect(tagModuleId(once, "m2")).toBe(once);
  });
});
