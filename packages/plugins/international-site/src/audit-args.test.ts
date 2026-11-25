// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { parseAuditArgs } from "./audit.js";

const pages = [{ pageId: "p-1", path: "/" }];
const facts = [{ pageId: "p-1", path: "/", alternates: [], links: [], texts: [] }];
// What admin-core's audit job adds to every plugin call (#1651).
const runId = "6f1c2f7e-3d1a-4c55-9b0e-2a7d4f8e9c10";

describe("audit_findings arguments", () => {
  it("accepts the first call and a facts batch as the audit job sends them, run id included", () => {
    expect(parseAuditArgs({ pages, runId }).pages).toEqual(pages);
    expect(parseAuditArgs({ pages, facts, runId }).facts).toHaveLength(1);
  });

  it("accepts a call without a run id", () => {
    expect(parseAuditArgs({ pages }).runId).toBeUndefined();
  });

  it("still refuses a key core does not send", () => {
    expect(() => parseAuditArgs({ pages, page: "p-1" })).toThrow(/Unrecognized key/);
  });
});
