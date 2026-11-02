// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  readSessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_ENTRY,
  type SessionEntry,
  sessionCookieValue,
  sessionSetCookieHeader,
} from "./session-cookie.js";

const NOW = 1_800_000_000;
const SIGNED_VID = "0b1c2d3e-4f50-4617-8899-aabbccddeeff.1799999000.ab12";
const STAGING = "session.1800003600.Zm9v-_bar";

function entries(o: Record<string, SessionEntry>): Map<string, SessionEntry> {
  return new Map(Object.entries(o));
}

/** The Cookie header a browser sends back for a Set-Cookie value. */
function cookieFor(setCookie: string, others = ""): string {
  return `${others}${setCookie.split(";")[0]}`;
}

describe("__session container (#1343)", () => {
  it("is named __session: the only cookie Firebase Hosting forwards", () => {
    expect(SESSION_COOKIE_NAME).toBe("__session");
  });

  it("round-trips several owners' entries without one clobbering another", () => {
    const written = entries({
      [SESSION_ENTRY.visitorId]: { value: SIGNED_VID, expiresAt: NOW + 100 },
      [SESSION_ENTRY.staging]: { value: STAGING, expiresAt: NOW + 3600 },
    });
    const header = sessionSetCookieHeader(written, { nowSeconds: NOW, secure: true });
    const read = readSessionCookie(cookieFor(header, "other=1; "), NOW);
    expect([...read]).toEqual([...written].sort(([a], [b]) => a.localeCompare(b)));
  });

  it("sets HttpOnly, SameSite=Lax, Secure and the longest entry's Max-Age", () => {
    const header = sessionSetCookieHeader(
      entries({
        vid: { value: SIGNED_VID, expiresAt: NOW + 100 },
        login: { value: "a.1.b", expiresAt: NOW + 50 },
      }),
      { nowSeconds: NOW, secure: true },
    );
    expect(header).toStartWith("__session=");
    expect(header).toContain("; Path=/; HttpOnly; SameSite=Lax; Max-Age=100; Secure");
    expect(sessionSetCookieHeader(new Map(), { nowSeconds: NOW, secure: false })).toBe(
      "__session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    );
  });

  it("leaves out expired, malformed and unknown-shaped entries", () => {
    const value = encodeURIComponent(
      new URLSearchParams([
        ["vid", `${NOW - 1}.${SIGNED_VID}`],
        ["login", "notanumber.abc"],
        ["Bad-Key", `${NOW + 9}.x`],
        ["staging", `${NOW + 9}.has space`],
        ["ok", `${NOW + 9}.fine`],
      ]).toString(),
    );
    expect([...readSessionCookie(`__session=${value}`, NOW).keys()]).toEqual(["ok"]);
    expect(readSessionCookie("__session=%E0%A4%A", NOW).size).toBe(0);
    expect(readSessionCookie("caelo_visitor_id=x", NOW).size).toBe(0);
    expect(readSessionCookie(null, NOW).size).toBe(0);
  });

  it("refuses to write what it could not read back", () => {
    expect(() => sessionCookieValue(entries({ vid: { value: "a;b", expiresAt: NOW } }))).toThrow(
      "invalid value",
    );
    expect(() => sessionCookieValue(entries({ "x-y": { value: "a", expiresAt: NOW } }))).toThrow(
      "invalid entry key",
    );
  });
});
