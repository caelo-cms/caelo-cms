// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  checkImportRow,
  type ImportFieldMap,
  importFieldMap,
  unknownImportFields,
} from "./fields.js";
import { importKindBase } from "./kind.js";
import { ImportProblems, MAX_PROBLEM_EXAMPLES } from "./report.js";

const FIELDS: ImportFieldMap = {
  page: { type: "pageRef" },
  authorName: { type: "string", maxLength: 10 },
  content: { type: "text", maxLength: 100 },
  submittedAt: { type: "datetime" },
  stars: { type: "int", min: 1, max: 5, optional: true },
  share: { type: "number", optional: true },
  pinned: { type: "bool", optional: true },
  status: { type: "enum", values: ["approved", "pending"], optional: true },
  target: { type: "path", optional: true },
  site: { type: "url", optional: true },
};

const ROW = {
  sourceKey: "wp:1",
  page: "/blog/hello",
  authorName: "Anna",
  content: "Hi\r\nthere",
  submittedAt: "2019-05-04 12:15:00+02:00",
};

describe("checkImportRow", () => {
  it("reads strings into typed values and normalises dates and line ends", () => {
    const r = checkImportRow(FIELDS, true, {
      ...ROW,
      parentKey: 7,
      stars: "4",
      share: "0.5",
      pinned: "1",
      status: "approved",
      target: "/new",
      site: "https://old.example.com/x",
    });
    expect(r).toEqual({
      ok: true,
      row: {
        sourceKey: "wp:1",
        parentKey: "7",
        values: {
          page: "/blog/hello",
          authorName: "Anna",
          content: "Hi\nthere",
          submittedAt: "2019-05-04T10:15:00.000Z",
          stars: 4,
          share: 0.5,
          pinned: true,
          status: "approved",
          target: "/new",
          site: "https://old.example.com/x",
        },
      },
    });
  });

  it("treats empty values as absent and refuses missing required ones", () => {
    const r = checkImportRow(FIELDS, false, { ...ROW, authorName: "  ", stars: "" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.sourceKey).toBe("wp:1");
    expect(r.problems).toEqual([
      { reason: "missing-value", field: "authorName", detail: "authorName is required" },
    ]);
  });

  it("refuses values that do not read cleanly, never guessing", () => {
    const bad = (patch: Record<string, unknown>) => {
      const r = checkImportRow(FIELDS, true, { ...ROW, ...patch });
      return r.ok ? [] : r.problems.map((p) => p.field);
    };
    expect(bad({ submittedAt: "2019-05-04 12:15:00" })).toEqual(["submittedAt"]);
    expect(bad({ submittedAt: "2019-02-31T00:00:00Z" })).toEqual(["submittedAt"]);
    expect(bad({ submittedAt: "2020-02-29T00:00:00Z" })).toEqual([]);
    expect(bad({ stars: "4.5" })).toEqual(["stars"]);
    expect(bad({ stars: "9" })).toEqual(["stars"]);
    expect(bad({ share: "0,5" })).toEqual(["share"]);
    expect(bad({ pinned: "yes" })).toEqual(["pinned"]);
    expect(bad({ status: "Approved" })).toEqual(["status"]);
    expect(bad({ target: "//evil.example" })).toEqual(["target"]);
    expect(bad({ site: "javascript:alert(1)" })).toEqual(["site"]);
    expect(bad({ authorName: "Anna\nBen" })).toEqual(["authorName"]);
    expect(bad({ authorName: "a".repeat(11) })).toEqual(["authorName"]);
    expect(bad({ sourceKey: "" })).toEqual(["sourceKey"]);
    expect(bad({ sourceKey: "a\u0001" })).toEqual(["sourceKey"]);
    expect(bad({ parentKey: "wp:1" })).toEqual(["parentKey"]);
  });

  it("ignores parentKey on kinds without parents", () => {
    const r = checkImportRow(FIELDS, false, { ...ROW, parentKey: "wp:0" });
    expect(r.ok && r.row.parentKey).toBeNull();
  });
});

describe("unknownImportFields", () => {
  it("names every column the kind does not take", () => {
    expect(
      unknownImportFields(FIELDS, false, ["sourceKey", "page", "parentKey", "email", "email"]),
    ).toEqual(["parentKey", "email"]);
    expect(unknownImportFields(FIELDS, true, ["parentKey"])).toEqual([]);
  });
});

describe("declarations", () => {
  it("refuses reserved, badly named and inconsistent fields", () => {
    expect(importFieldMap.safeParse({ sourceKey: { type: "string", maxLength: 5 } }).success).toBe(
      false,
    );
    expect(
      importFieldMap.safeParse({ author_name: { type: "string", maxLength: 5 } }).success,
    ).toBe(false);
    expect(importFieldMap.safeParse({ a: { type: "string" } }).success).toBe(false);
    expect(importFieldMap.safeParse({ a: { type: "int", maxLength: 3 } }).success).toBe(false);
    expect(importFieldMap.safeParse({ a: { type: "enum" } }).success).toBe(false);
    expect(importFieldMap.safeParse({}).success).toBe(false);
    expect(importFieldMap.safeParse(FIELDS).success).toBe(true);
  });

  it("checks a kind's name", () => {
    const kind = {
      kind: "comments",
      label: "Comments",
      description: "d",
      fields: FIELDS,
      release: "stage",
    };
    expect(importKindBase.safeParse(kind).success).toBe(true);
    expect(importKindBase.safeParse({ ...kind, kind: "Comments" }).success).toBe(false);
  });
});

describe("ImportProblems", () => {
  it("counts every problem, keeps a few examples, counts rows once", () => {
    const p = new ImportProblems();
    for (let i = 0; i < MAX_PROBLEM_EXAMPLES + 5; i++)
      p.add("invalid-value", `r${i}`, {
        sourceKey: `k${i}`,
        at: `line ${i}`,
        detail: "x".repeat(500),
      });
    p.add("page-not-found", "r0", { sourceKey: "k0", at: "line 0", detail: "no page" });
    const groups = p.groups();
    expect(groups.map((g) => [g.reason, g.count, g.examples.length])).toEqual([
      ["invalid-value", MAX_PROBLEM_EXAMPLES + 5, MAX_PROBLEM_EXAMPLES],
      ["page-not-found", 1, 1],
    ]);
    expect(groups[0]?.examples[0]?.detail.length).toBe(200);
    expect(p.rowCount).toBe(MAX_PROBLEM_EXAMPLES + 5);
    expect(p.has("r3")).toBe(true);
  });
});
