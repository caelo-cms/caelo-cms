// SPDX-License-Identifier: MPL-2.0

/**
 * #769 — which Owner `auth.issue_owner_reset` resets, and the refusals that
 * tell the operator what to pass instead.
 */

import { describe, expect, it } from "bun:test";
import { pickOwnerToReset } from "../auth.js";

const A = { id: "1", email: "a@example.com" };
const B = { id: "2", email: "b@example.com" };

describe("pickOwnerToReset", () => {
  it("takes the only Owner when no email is named", () => {
    expect(pickOwnerToReset([A], undefined)).toEqual({ ok: true, owner: A });
  });

  it("asks for --email and lists the Owners when there are several", () => {
    const r = pickOwnerToReset([A, B], undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.summary).toBe("several-owners");
    expect(r.message).toContain("--email");
    expect(r.message).toContain("a@example.com, b@example.com");
  });

  it("matches the named Owner case-insensitively", () => {
    expect(pickOwnerToReset([A, B], "B@Example.com")).toEqual({ ok: true, owner: B });
  });

  it("refuses a non-Owner and names the Owners", () => {
    const r = pickOwnerToReset([A], "editor@example.com");
    expect(r).toMatchObject({ ok: false, summary: "not-an-owner" });
    if (!r.ok) expect(r.message).toContain("Owners: a@example.com");
  });

  it("points at /setup when the install has no Owner yet", () => {
    for (const email of [undefined, "a@example.com"]) {
      const r = pickOwnerToReset([], email);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("/setup");
    }
  });
});
