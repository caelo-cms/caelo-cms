// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { isNavigatingTo, isRepeatNavigation } from "./navigation-feedback.js";

const at = (path: string) => new URL(path, "https://admin.example.com");

describe("isNavigatingTo (#1268)", () => {
  it("matches the target page whatever its query", () => {
    expect(isNavigatingTo(at("/edit?page=abc"), "/edit")).toBe(true);
    expect(isNavigatingTo(at("/edit"), "/edit")).toBe(true);
  });

  it("does not match another page or no navigation", () => {
    expect(isNavigatingTo(at("/content/pages"), "/edit")).toBe(false);
    expect(isNavigatingTo(null, "/edit")).toBe(false);
    expect(isNavigatingTo(undefined, "/edit")).toBe(false);
  });
});

describe("isRepeatNavigation (#1268)", () => {
  it("is a repeat for the same page and query", () => {
    expect(isRepeatNavigation(at("/edit?page=a"), at("/edit?page=a"))).toBe(true);
  });

  it("is not a repeat for another query, another page or nothing in flight", () => {
    expect(isRepeatNavigation(at("/edit?page=a"), at("/edit?page=b"))).toBe(false);
    expect(isRepeatNavigation(at("/edit"), at("/"))).toBe(false);
    expect(isRepeatNavigation(null, at("/edit"))).toBe(false);
  });
});
