// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { classifyAuditRow } from "./render-change.js";

const ID = "00000000-0000-4000-8000-000000000001";

describe("classifyAuditRow (epic #1107)", () => {
  it("names the page of a page write", () => {
    expect(classifyAuditRow("pages.update_many", ID)).toEqual({ kind: "page", id: ID });
  });

  it("names the list or list type of a list-domain write", () => {
    expect(classifyAuditRow("lists.patch_items_many", ID)).toEqual({ kind: "list", id: ID });
    expect(classifyAuditRow("list_types.upsert_many", ID)).toEqual({ kind: "listType", id: ID });
  });

  it("asks for a full rebuild when a list-domain write names nothing, and for page types", () => {
    expect(classifyAuditRow("lists.upsert_many", null)).toEqual({ kind: "full" });
    expect(classifyAuditRow("list_types.delete_many", null)).toEqual({ kind: "full" });
    expect(classifyAuditRow("page_types.upsert_many", ID)).toEqual({ kind: "full" });
  });

  it("leaves every other write to the existing resolution", () => {
    expect(classifyAuditRow("comments.moderate", ID)).toEqual({ kind: "other" });
  });
});
