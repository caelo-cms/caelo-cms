// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { currentFor, errorFor, pageToFollow, pendingFor } from "./streamed-read.js";

const settled = (key: string, current: number | null, error: string | null = null) => ({
  current,
  error,
  loading: false,
  key,
});

describe("streamed parts of one chat (#1268)", () => {
  it("hands out a value only for the chat it was loaded for", () => {
    // Chat A's Stage list is still current when chat B's load arrived.
    const s = settled("chat-a", 3);
    expect(currentFor(s, "chat-a")).toBe(3);
    expect(currentFor(s, "chat-b")).toBeNull();
    expect(pendingFor(s, "chat-b")).toBe(true);
    expect(pendingFor(s, "chat-a")).toBe(false);
  });

  it("reports a failure only for its own chat", () => {
    const s = settled("chat-a", null, "The Stage list could not be loaded: timeout");
    expect(errorFor(s, "chat-a")).toBe("The Stage list could not be loaded: timeout");
    expect(errorFor(s, "chat-b")).toBeNull();
  });

  it("is pending before anything settled", () => {
    expect(pendingFor({ current: null, error: null, loading: true, key: null }, null)).toBe(true);
  });
});

describe("pageToFollow (#1268)", () => {
  it("follows the page the load opened when the shown page is gone", () => {
    // ?page=deleted asked; the load opened the home page instead.
    expect(pageToFollow("deleted", "deleted", "home")).toBe("home");
    // Nothing left to open: the editor shows no page.
    expect(pageToFollow("deleted", "deleted", null)).toBe("");
  });

  it("keeps the shown page while its own load is not in yet, or when the load opened it", () => {
    // The preview navigated to a new page; the load still answers the old ?page=.
    expect(pageToFollow("old", "new", "old")).toBeNull();
    expect(pageToFollow("same", "same", "same")).toBeNull();
    expect(pageToFollow(null, "", "home")).toBeNull();
  });
});
