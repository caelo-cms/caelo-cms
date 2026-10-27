// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { editorRefreshUrl, pinChatParam, unpinChatParam } from "./chat-pin.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function editUrl(chat?: string): URL {
  const url = new URL("http://localhost/edit?page=p1");
  if (chat) url.searchParams.set("chat", chat);
  return url;
}

describe("pinChatParam", () => {
  it("writes the chat when the URL names none or another one", () => {
    const empty = editUrl();
    expect(pinChatParam(empty, A)).toBe(true);
    expect(empty.searchParams.get("chat")).toBe(A);
    const other = editUrl(B);
    expect(pinChatParam(other, A)).toBe(true);
    expect(other.searchParams.get("chat")).toBe(A);
  });

  it("leaves a URL that already names the chat alone, and says so", () => {
    const url = editUrl(A);
    expect(pinChatParam(url, A)).toBe(false);
    expect(url.toString()).toBe(editUrl(A).toString());
  });
});

describe("unpinChatParam", () => {
  it("drops the chat the editor pinned", () => {
    const url = editUrl(A);
    unpinChatParam(url, A);
    expect(url.searchParams.has("chat")).toBe(false);
    expect(url.searchParams.get("page")).toBe("p1");
  });

  it("keeps a chat the operator chose after the editor pinned another (PR #1076 review)", () => {
    // A save pinned A; the operator then picked B in the overlay.
    const url = editUrl();
    expect(pinChatParam(url, A)).toBe(true);
    url.searchParams.set("chat", B);
    unpinChatParam(url, A);
    expect(url.searchParams.get("chat")).toBe(B);
  });

  it("keeps the chat when the editor pinned nothing", () => {
    const url = editUrl(B);
    unpinChatParam(url, null);
    expect(url.searchParams.get("chat")).toBe(B);
  });
});

describe("editorRefreshUrl", () => {
  it("follows the page the editor shows, keeping the chat pinned", () => {
    const r = editorRefreshUrl(editUrl(A).toString(), A, "p2");
    expect(r.url.searchParams.get("page")).toBe("p2");
    expect(r.url.searchParams.get("chat")).toBe(A);
    expect(r).toMatchObject({ pinned: false, changed: true });
  });

  it("pins the chat when the URL lacks it", () => {
    const r = editorRefreshUrl(editUrl().toString(), A, "p1");
    expect(r).toMatchObject({ pinned: true, changed: true });
    expect(r.url.searchParams.get("chat")).toBe(A);
  });

  it("reports an unchanged URL as a plain refresh", () => {
    expect(editorRefreshUrl(editUrl(A).toString(), A, "p1").changed).toBe(false);
    expect(editorRefreshUrl(editUrl(A).toString(), A, null).changed).toBe(false);
  });
});
