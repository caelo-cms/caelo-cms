// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { hasUnconditionalMember, withMember } from "./iam-policy.js";

const ROLE = "roles/iap.httpsResourceAccessor";

describe("withMember", () => {
  it("adds to the existing unconditional binding, keeping etag and other roles", () => {
    const next = withMember(
      {
        etag: "e1",
        bindings: [
          { role: ROLE, members: ["user:owner@x.com"] },
          { role: "roles/other", members: ["user:a@x.com"] },
        ],
      },
      ROLE,
      "user:new@x.com",
      true,
    );
    expect(next).toEqual({
      etag: "e1",
      bindings: [
        { role: ROLE, members: ["user:owner@x.com", "user:new@x.com"] },
        { role: "roles/other", members: ["user:a@x.com"] },
      ],
    });
  });

  it("creates the binding when the role has none, and returns null when nothing changes", () => {
    expect(withMember({}, ROLE, "user:a@x.com", true)).toEqual({
      bindings: [{ role: ROLE, members: ["user:a@x.com"] }],
    });
    const has = { bindings: [{ role: ROLE, members: ["user:a@x.com"] }] };
    expect(withMember(has, ROLE, "user:a@x.com", true)).toBeNull();
    expect(withMember({}, ROLE, "user:a@x.com", false)).toBeNull();
  });

  it("removes the member and drops a binding left empty", () => {
    expect(
      withMember(
        { bindings: [{ role: ROLE, members: ["user:a@x.com"] }] },
        ROLE,
        "user:a@x.com",
        false,
      ),
    ).toEqual({ bindings: [] });
  });

  it("never touches a conditional binding, and writes v3 when one exists", () => {
    const conditional = { role: ROLE, members: ["user:a@x.com"], condition: { title: "office" } };
    expect(hasUnconditionalMember({ bindings: [conditional] }, ROLE, "user:a@x.com")).toBe(false);
    // Revoking leaves the operator's conditional grant alone.
    expect(withMember({ bindings: [conditional] }, ROLE, "user:a@x.com", false)).toBeNull();
    const granted = withMember({ version: 1, bindings: [conditional] }, ROLE, "user:a@x.com", true);
    expect(granted).toEqual({
      version: 3,
      bindings: [conditional, { role: ROLE, members: ["user:a@x.com"] }],
    });
  });
});
