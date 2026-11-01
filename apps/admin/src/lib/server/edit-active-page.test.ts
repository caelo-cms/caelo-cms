// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  activePageScope,
  branchPageScope,
  type EditPage,
  pickActivePage,
  pickScopedPage,
} from "./edit-active-page.js";

const ID = "7299af9b-f8a8-4f3b-9ddd-e1ee97f9e20c";
const page = (id: string, currentPath: string): EditPage => ({
  id,
  slug: currentPath.slice(1) || "home",
  title: currentPath,
  status: "published",
  currentPath,
});

describe("activePageScope (#1268)", () => {
  it("asks for the ?page= page and the home page", () => {
    expect(activePageScope(ID)).toEqual({ pageIds: [ID], paths: ["/"] });
  });

  it("asks only for the home page without a usable ?page=", () => {
    expect(activePageScope(null)).toEqual({ paths: ["/"] });
    expect(activePageScope("not-a-uuid")).toEqual({ paths: ["/"] });
  });
});

describe("pickActivePage (#1268)", () => {
  const home = page("home-id", "/");
  const about = page(ID, "/about");

  it("prefers the ?page= page over the home page", () => {
    expect(pickActivePage([home, about], ID)).toBe(about);
  });

  it("opens the home page when ?page= names no listed page", () => {
    expect(pickActivePage([home], ID)).toBe(home);
    expect(pickActivePage([about, home], null)).toBe(home);
  });

  it("opens the first page of a site without a home page, and none of an empty site", () => {
    expect(pickActivePage([about], null)).toBe(about);
    expect(pickActivePage([], null)).toBeNull();
  });
});

describe("branchPageScope (#1268)", () => {
  const mainHome = page("main-home", "/");

  it("asks the chat's view for the ?page= page and main's home page by id", () => {
    expect(branchPageScope(ID, [mainHome])).toEqual({ pageIds: [ID, "main-home"] });
    expect(branchPageScope(null, [mainHome, page(ID, "/about")])).toEqual({
      pageIds: ["main-home"],
    });
  });

  it("has no bounded lookup without either candidate", () => {
    expect(branchPageScope(null, [])).toBeNull();
    expect(branchPageScope("not-a-uuid", [page(ID, "/about")])).toBeNull();
  });
});

describe("pickScopedPage (#1268)", () => {
  it("finds the ?page= page or the page at /, nothing else", () => {
    const home = page("home-id", "/");
    const moved = page("old-home", "/old-home");
    expect(pickScopedPage([moved, home], null)).toBe(home);
    expect(pickScopedPage([moved], "old-home")).toBe(moved);
    // Main's home renamed away in the draft: not a match, the caller reads the list.
    expect(pickScopedPage([moved], null)).toBeNull();
  });
});
