// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { type RemoteMcpState, remoteAccessView } from "./mcp-remote-access.js";

const ON: RemoteMcpState = {
  status: "on",
  urls: { chat: "https://viu.one/api/mcp/chat", admin: "https://viu.one/api/mcp/admin" },
  siteHost: "viu.one",
};
const OWNER = { chat: true, admin: true };
const EDITOR = { chat: true, admin: false };

describe("remoteAccessView (#968)", () => {
  it("never offers setup once remote MCP is on, and shows an Owner both addresses with their purpose", () => {
    const v = remoteAccessView(ON, OWNER, true);
    expect(v.setupHref).toBeNull();
    expect(v.surfaces.map((s) => [s.surface, s.url, s.connectorName])).toEqual([
      ["chat", "https://viu.one/api/mcp/chat", "Caelo viu.one (Chat)"],
      ["admin", "https://viu.one/api/mcp/admin", "Caelo viu.one (Admin)"],
    ]);
    for (const s of v.surfaces) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.does.length).toBeGreaterThan(0);
      expect(s.who).toContain(s.surface === "admin" ? "settings.write" : "content.write");
    }
    expect(v.adminHint).toBeNull();
  });

  it("shows an editor only the chat address, and says what admin access needs", () => {
    const v = remoteAccessView(ON, EDITOR, false);
    expect(v.surfaces.map((s) => s.surface)).toEqual(["chat"]);
    expect(JSON.stringify(v)).not.toContain("/api/mcp/admin");
    expect(v.adminHint).toContain("settings.write");
  });

  it("offers setup to an Owner only while remote MCP is off", () => {
    const off: RemoteMcpState = { status: "off", signInSettingsPath: "/settings/google-sign-in" };
    expect(remoteAccessView(off, OWNER, true).setupHref).toBe("/settings/google-sign-in");
    expect(remoteAccessView(off, EDITOR, false).setupHref).toBeNull();
    const unavailable: RemoteMcpState = { status: "not-available", reason: "self-hosted" };
    expect(remoteAccessView(unavailable, OWNER, true)).toEqual({
      setupHref: null,
      surfaces: [],
      adminHint: null,
    });
  });
});
