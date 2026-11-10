// SPDX-License-Identifier: MPL-2.0

/**
 * #1332 (M3) — a submission is checked against the form's own fields, and
 * #1336 (P6) — no refusal names the form's slug, so a visitor learns
 * nothing about which forms a site has.
 */

import { describe, expect, it } from "bun:test";
import {
  indexCheckedQuery,
  isPublicOperationError,
  type PluginContextTier1,
} from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";

const SLUG = "secret-partner-intake";

const FORM = {
  slug: SLUG,
  schema_json: {
    fields: [
      { name: "name", label: "Your name", type: "text", required: true },
      { name: "email", label: "Your email", type: "email", required: true },
      { name: "message", label: "Message", type: "textarea" },
    ],
  },
};

function harness(form: typeof FORM | null) {
  const inserted: unknown[] = [];
  const ctx = {
    invocation: { origin: "visitor", actorId: "v" },
    query: indexCheckedQuery(plugin, "schema", {
      list: async () => (form ? [form] : []),
      insert: async (_table: string, row: unknown) => {
        inserted.push(row);
        return { id: "44444444-4444-4444-8444-444444444444" };
      },
    }),
  } as unknown as PluginContextTier1;
  return { ctx, inserted };
}

async function refusal(form: typeof FORM | null, data: Record<string, unknown>): Promise<Error> {
  const op = plugin.operations.submit;
  if (!op) throw new Error("submit missing");
  try {
    await op(harness(form).ctx, { formSlug: SLUG, data });
  } catch (e) {
    return e as Error;
  }
  throw new Error("submit accepted what it should refuse");
}

describe("forms submit refusals", () => {
  const cases: [string, typeof FORM | null, Record<string, unknown>][] = [
    ["an unknown form", null, { name: "A" }],
    ["a field the form does not have", FORM, { name: "A", email: "a@x.io", phone: "1" }],
    ["a missing required field", FORM, { email: "a@x.io" }],
    ["an invalid email", FORM, { name: "A", email: "not-an-address" }],
  ];
  for (const [label, form, data] of cases) {
    it(`refuses ${label} in words for the visitor, without the slug`, async () => {
      const e = await refusal(form, data);
      expect(isPublicOperationError(e)).toBe(true);
      expect(e.message).not.toContain(SLUG);
    });
  }

  it("stores a submission that matches the form's fields", async () => {
    const op = plugin.operations.submit;
    if (!op) throw new Error("submit missing");
    const h = harness(FORM);
    const r = await op(h.ctx, { formSlug: SLUG, data: { name: "A", email: "a@x.io" } });
    expect(r).toEqual({ submissionId: "44444444-4444-4444-8444-444444444444" });
    expect(h.inserted).toHaveLength(1);
  });
});
