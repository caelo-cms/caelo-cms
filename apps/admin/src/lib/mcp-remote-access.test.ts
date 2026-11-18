// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { type RemoteMcpState, remoteAccessView } from "./mcp-remote-access.js";

const ON: RemoteMcpState = {
  status: "on",
  urls: { chat: "https://viu.one/api/mcp/chat", power: "https://viu.one/api/mcp/power" },
  siteHost: "viu.one",
};
const MAY_WORK_THROUGH_AI = { chat: true, power: true };
const NO_AI_KEY = { chat: false, power: true };
const READ_ONLY = { chat: false, power: false };

describe("remoteAccessView (#968)", () => {
  it("never offers setup once remote MCP is on, and shows both addresses with their purpose", () => {
    const v = remoteAccessView(ON, MAY_WORK_THROUGH_AI, true);
    expect(v.setupHref).toBeNull();
    expect(v.surfaces.map((s) => [s.surface, s.url, s.connectorName])).toEqual([
      ["chat", "https://viu.one/api/mcp/chat", "Caelo viu.one (Chat)"],
      ["power", "https://viu.one/api/mcp/power", "Caelo viu.one (Power)"],
    ]);
    for (const s of v.surfaces) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.does.length).toBeGreaterThan(0);
      // #1636 — one permission for working through an AI, on both addresses.
      expect(s.who).toContain("content.write");
    }
  });

  it("shows an editor the same two addresses as an Owner (#1636)", () => {
    const owner = remoteAccessView(ON, MAY_WORK_THROUGH_AI, true);
    const editor = remoteAccessView(ON, MAY_WORK_THROUGH_AI, false);
    expect(editor.surfaces).toEqual(owner.surfaces);
    // The old name is neither an address on offer nor in any text.
    expect(JSON.stringify(editor)).not.toContain("admin");
  });

  it("shows only what the viewer may use: no chat address without an AI key, none for a read-only role", () => {
    expect(remoteAccessView(ON, NO_AI_KEY, true).surfaces.map((s) => s.surface)).toEqual(["power"]);
    expect(remoteAccessView(ON, READ_ONLY, false).surfaces).toEqual([]);
  });

  it("offers setup to an Owner only while remote MCP is off", () => {
    const off: RemoteMcpState = { status: "off", signInSettingsPath: "/settings/google-sign-in" };
    expect(remoteAccessView(off, MAY_WORK_THROUGH_AI, true).setupHref).toBe(
      "/settings/google-sign-in",
    );
    expect(remoteAccessView(off, MAY_WORK_THROUGH_AI, false).setupHref).toBeNull();
    const unavailable: RemoteMcpState = { status: "not-available", reason: "self-hosted" };
    expect(remoteAccessView(unavailable, MAY_WORK_THROUGH_AI, true)).toEqual({
      setupHref: null,
      surfaces: [],
    });
  });
});
