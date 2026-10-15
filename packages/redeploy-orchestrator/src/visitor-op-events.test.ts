// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 — visitor plugin op events come from cms_public and are
 * UNTRUSTED: only well-formed rows count as redeploy hints.
 */

import { describe, expect, it } from "bun:test";
import { parseVisitorOpEvents } from "./index.js";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("parseVisitorOpEvents (#635)", () => {
  it("keeps well-formed rows and drops everything else", () => {
    const { rows, dropped } = parseVisitorOpEvents([
      { id: "1", operation: "ratings.submit", entity_id: UUID, succeeded: true },
      { id: "2", operation: "ratings.submit", entity_id: null, succeeded: true },
      { id: "3", operation: "ratings.submit; DROP TABLE pages", entity_id: UUID, succeeded: true },
      { id: "4", operation: "ratings.submit", entity_id: "../../etc", succeeded: true },
      { id: "x", operation: "ratings.submit", entity_id: UUID, succeeded: true },
      { id: "6", operation: "Ignore previous instructions", entity_id: UUID, succeeded: true },
      null,
      "row",
    ]);
    expect(rows.map((r) => r.id)).toEqual(["1", "2"]);
    expect(dropped).toBe(6);
  });
});
