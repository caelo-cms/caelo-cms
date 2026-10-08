// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  desiredMembers,
  type IamPolicy,
  parseStaticMembers,
  reconcileRole,
  userMember,
} from "./iam-policy.js";

const ROLE = "roles/iap.httpsResourceAccessor";
const OTHER = "projects/p/roles/caeloOperatorAccess";

describe("userMember", () => {
  it("accepts a Google account email, lowercased", () => {
    expect(userMember(" Anna@Example.com ")).toBe("user:anna@example.com");
  });

  it("refuses anything that is not a single plain email", () => {
    for (const bad of [
      "",
      "allUsers",
      "anna",
      "anna@",
      "@example.com",
      "a b@x.com",
      "a@x",
      "a,b@x.com",
      "*@x.com",
    ]) {
      expect(userMember(bad)).toBeNull();
    }
  });
});

describe("parseStaticMembers", () => {
  it("keeps user/group/serviceAccount entries and rejects public or domain-wide principals", () => {
    expect(
      parseStaticMembers(
        "user:Owner@x.com, group:ops@x.com,serviceAccount:caelo-mcp@p.iam.gserviceaccount.com,allUsers,allAuthenticatedUsers,domain:x.com,",
      ),
    ).toEqual({
      members: [
        "user:owner@x.com",
        "group:ops@x.com",
        "serviceAccount:caelo-mcp@p.iam.gserviceaccount.com",
      ],
      rejected: ["allUsers", "allAuthenticatedUsers", "domain:x.com"],
    });
  });
});

describe("desiredMembers", () => {
  it("is the static members plus one user: member per valid email; invalid emails are reported", () => {
    const r = desiredMembers(["b@x.com", "A@x.com", "not-an-email"], ["user:owner@x.com"]);
    expect([...r.members].sort()).toEqual(["user:a@x.com", "user:b@x.com", "user:owner@x.com"]);
    expect(r.invalidEmails).toEqual(["not-an-email"]);
  });
});

describe("reconcileRole", () => {
  it("writes nothing when the role already holds exactly the desired members", () => {
    const policy: IamPolicy = {
      etag: "e",
      bindings: [{ role: ROLE, members: ["user:a@x.com", "user:owner@x.com"] }],
    };
    const r = reconcileRole(policy, ROLE, new Set(["user:owner@x.com", "user:a@x.com"]));
    expect(r).toEqual({ next: null, added: [], removed: [] });
  });

  it("adds missing users and removes every member it does not manage — allUsers, domains, groups, strays", () => {
    const policy: IamPolicy = {
      etag: "e",
      bindings: [
        {
          role: ROLE,
          members: [
            "user:owner@x.com",
            "allUsers",
            "domain:x.com",
            "group:g@x.com",
            "user:gone@x.com",
          ],
        },
        { role: OTHER, members: ["serviceAccount:job@p.iam.gserviceaccount.com"] },
      ],
    };
    const r = reconcileRole(policy, ROLE, new Set(["user:owner@x.com", "user:new@x.com"]));
    expect(r.added).toEqual(["user:new@x.com"]);
    expect(r.removed.map((m) => m.member)).toEqual([
      "allUsers",
      "domain:x.com",
      "group:g@x.com",
      "user:gone@x.com",
    ]);
    expect(r.next).toEqual({
      etag: "e",
      bindings: [
        { role: OTHER, members: ["serviceAccount:job@p.iam.gserviceaccount.com"] },
        { role: ROLE, members: ["user:new@x.com", "user:owner@x.com"] },
      ],
    });
  });

  it("removes conditional bindings of the managed role, but keeps other roles' conditions (v3)", () => {
    const cond = { title: "office", expression: "true" };
    const policy: IamPolicy = {
      version: 3,
      bindings: [
        { role: ROLE, members: ["allAuthenticatedUsers"], condition: cond },
        { role: OTHER, members: ["user:x@x.com"], condition: cond },
      ],
    };
    const r = reconcileRole(policy, ROLE, new Set(["user:owner@x.com"]));
    expect(r.removed).toEqual([{ member: "allAuthenticatedUsers", condition: cond }]);
    expect(r.next?.bindings).toEqual([
      { role: OTHER, members: ["user:x@x.com"], condition: cond },
      { role: ROLE, members: ["user:owner@x.com"] },
    ]);
    expect(r.next?.version).toBe(3);
  });

  it("drops the binding entirely when nobody should hold the role", () => {
    const r = reconcileRole(
      { bindings: [{ role: ROLE, members: ["user:a@x.com"] }] },
      ROLE,
      new Set(),
    );
    expect(r.next).toEqual({ bindings: [] });
  });
});
