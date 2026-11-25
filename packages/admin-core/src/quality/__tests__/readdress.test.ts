// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { onOrigin, readdressed } from "../readdress.js";

describe("readdress", () => {
  it("moves a page URL between the origins one build is served on", () => {
    expect(
      onOrigin("http://127.0.0.1:4100/en/", "http://127.0.0.1:4100", "https://127.0.0.1:4200/"),
    ).toBe("https://127.0.0.1:4200/en/");
    expect(
      onOrigin("http://127.0.0.1:4100", "http://127.0.0.1:4100/", "https://127.0.0.1:4200"),
    ).toBe("https://127.0.0.1:4200");
  });

  it("refuses a URL of another origin", () => {
    expect(() => onOrigin("http://127.0.0.1:41000/", "http://127.0.0.1:4100", "https://x")).toThrow(
      /not on the staged build's origin/,
    );
  });

  it("re-addresses every URL inside a result", () => {
    const result = {
      url: "https://127.0.0.1:4200/",
      flagged: [{ source: "https://127.0.0.1:4200/_assets/a.js" }],
    };
    expect(readdressed(result, "https://127.0.0.1:4200", "http://127.0.0.1:4100")).toEqual({
      url: "http://127.0.0.1:4100/",
      flagged: [{ source: "http://127.0.0.1:4100/_assets/a.js" }],
    });
  });
});
