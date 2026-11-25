// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  CONTENT_INSTANCE_ATTRIBUTE,
  stripContentInstances,
  tagContentInstance,
  tagModuleId,
} from "./module-id-tag.js";

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

  it("stays linear on a long whitespace run inside the root tag", () => {
    const html = `<div${"\t".repeat(200_000)}x>`;
    const start = performance.now();
    expect(tagModuleId(html, "m1").endsWith(' data-caelo-module-id="m1">')).toBe(true);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("the content-instance stamp (epic #1644)", () => {
  const ID = "11111111-1111-4111-8111-111111111111";

  it("sits next to the module id, once, also on a self-closing root", () => {
    const tagged = tagContentInstance(tagModuleId("<p>hi</p>", "m1"), ID);
    expect(tagged).toBe(
      `<p data-caelo-module-id="m1" ${CONTENT_INSTANCE_ATTRIBUTE}="${ID}">hi</p>`,
    );
    expect(tagContentInstance(tagged, ID)).toBe(tagged);
    expect(tagContentInstance('<line x1="0"/>', ID)).toBe(
      `<line x1="0" ${CONTENT_INSTANCE_ATTRIBUTE}="${ID}"/>`,
    );
  });

  it("leaves no trace once stripped", () => {
    const html = `<div data-caelo-module-id="m1" ${CONTENT_INSTANCE_ATTRIBUTE}="${ID}"><p>x</p></div>`;
    expect(stripContentInstances(html)).toBe('<div data-caelo-module-id="m1"><p>x</p></div>');
    expect(stripContentInstances("<p>none</p>")).toBe("<p>none</p>");
  });
});
