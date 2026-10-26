// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "bun:test";
import { chatSendMessageInput } from "@caelo-cms/shared";
import { buildUserContent } from "./persistence.js";

const MODULE_ID = "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7";

function render(chips: unknown[]): string {
  return buildUserContent(
    chatSendMessageInput.parse({ chatSessionId: crypto.randomUUID(), content: "Shorter", chips }),
  );
}

describe("element references in the persisted user message (#916)", () => {
  test("carries the full module id, element path, selection and surrounding text", () => {
    const text = render([
      {
        moduleId: MODULE_ID,
        selector: "section.hero > h1",
        label: "section.hero “Welcome”",
        selectedText: "Welcome to\nour shop",
        context: 'Welcome to our shop, "est. 1990"',
      },
    ]);
    expect(text).toContain(`(module=${MODULE_ID}, element=section.hero > h1)`);
    expect(text).toContain('    selected text: "Welcome to\\nour shop"');
    expect(text).toContain('    surrounding text: "Welcome to our shop, \\"est. 1990\\""');
  });

  test("names the placement field a marked text comes from (#917)", () => {
    const text = render([
      {
        moduleId: MODULE_ID,
        selector: "nav > a",
        label: "nav",
        selectedText: "Docs",
        blockName: "header",
        position: 0,
        field: "links",
        item: "00000000-0000-4000-9000-000000000002",
        key: "label",
      },
    ]);
    expect(text).toContain(
      `(module=${MODULE_ID}, element=nav > a, placement=(blockName=header, position=0), field=links, entry=00000000-0000-4000-9000-000000000002, key=label)`,
    );
  });

  test("names the list entry the element sits in (epic #1107)", () => {
    const LIST = "11111111-1111-4111-8111-111111111111";
    const ITEM = "22222222-2222-4222-8222-222222222222";
    const CI = "33333333-3333-4333-8333-333333333333";
    const shared = render([
      {
        moduleId: MODULE_ID,
        selector: "nav > a",
        label: "Entry “About”",
        listItem: `${LIST}/${ITEM}`,
      },
    ]);
    expect(shared).toContain(`list entry=(shared list=${LIST}, entry=${ITEM})`);
    const local = render([
      {
        moduleId: MODULE_ID,
        selector: "ul > li",
        label: "Entry “Fast”",
        listItem: `instance/${CI}/features/${ITEM}`,
      },
    ]);
    expect(local).toContain(
      `list entry=(content instance=${CI}, list field=features, entry=${ITEM})`,
    );
    const chrome = render([
      { moduleId: MODULE_ID, selector: "a", label: "Entry", listItem: `local/nav_links/${ITEM}` },
    ]);
    expect(chrome).toContain(`list entry=(default of list field=nav_links, entry=${ITEM})`);
  });

  test("the schema refuses a list entry reference of any other shape", () => {
    const base = { chatSessionId: crypto.randomUUID(), content: "x" };
    const chip = { moduleId: MODULE_ID, selector: "a", label: "a" };
    for (const listItem of [
      "x/y",
      "instance/abc/f/def",
      `local/Bad-Name/${MODULE_ID}`,
      `${MODULE_ID}/${MODULE_ID}/x`,
    ]) {
      expect(
        chatSendMessageInput.safeParse({ ...base, chips: [{ ...chip, listItem }] }).success,
      ).toBe(false);
    }
  });

  test("a dropdown-picked module (no element) renders without an element path", () => {
    const text = render([{ moduleId: MODULE_ID, selector: "", label: "hero — Hero" }]);
    expect(text).toContain(`  - hero — Hero (module=${MODULE_ID})`);
    expect(text).not.toContain("element=");
    expect(text).not.toContain("selected text");
  });

  test("the schema rejects unknown chip fields and oversized selections", () => {
    const base = { chatSessionId: crypto.randomUUID(), content: "x" };
    const chip = { moduleId: MODULE_ID, selector: "h1", label: "h1" };
    expect(
      chatSendMessageInput.safeParse({ ...base, chips: [{ ...chip, html: "<b>" }] }).success,
    ).toBe(false);
    expect(
      chatSendMessageInput.safeParse({
        ...base,
        chips: [{ ...chip, selectedText: "a".repeat(2001) }],
      }).success,
    ).toBe(false);
  });
});
