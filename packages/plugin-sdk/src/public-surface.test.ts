// SPDX-License-Identifier: MPL-2.0

/**
 * #1332 — the manifest lint of the public surface: every table has a kind,
 * and no public operation is declared to do what its tables' grants would
 * refuse at runtime (read an inbox, write a published table, …).
 */

import { describe, expect, it } from "bun:test";
import {
  manifestFromDefinition,
  type PluginTableKind,
  type PublicOperationDef,
  pluginManifest,
  z,
} from "./index.js";

const SCHEMA = {
  entries: { body: "text" },
  settings: { open: "bool" },
  sessions: { token: "string" },
  internal: { note: "text" },
};
const KINDS: Record<string, PluginTableKind> = {
  entries: "inbox",
  settings: "published",
  sessions: "visitor-state",
  internal: "private",
};

function manifest(
  ops: PublicOperationDef[],
  tableKinds: Record<string, PluginTableKind> = KINDS,
): ReturnType<typeof pluginManifest.safeParse> {
  const def = {
    slug: "probe",
    version: "1.0.0",
    tier: 1 as const,
    schema: SCHEMA,
    tableKinds,
    publicOperations: ops,
    operations: {
      noop: async () => null,
      ...Object.fromEntries(ops.map((o) => [o.name, async () => null])),
    },
  };
  try {
    return { success: true, data: manifestFromDefinition(def) } as ReturnType<
      typeof pluginManifest.safeParse
    >;
  } catch (e) {
    return { success: false, error: e } as ReturnType<typeof pluginManifest.safeParse>;
  }
}

function messages(r: ReturnType<typeof manifest>): string {
  return r.success ? "" : (r.error as z.ZodError).issues.map((i) => i.message).join("\n");
}

const op = (o: Partial<PublicOperationDef> & { name: string }): PublicOperationDef => ({
  kind: "write",
  input: z.object({}).strict(),
  ...o,
});

describe("public surface lint (#1332)", () => {
  it("accepts reads of published and visitor-state, writes of inbox and visitor-state", () => {
    const r = manifest([
      op({ name: "submit", reads: ["settings", "sessions"], writes: ["entries", "sessions"] }),
      op({ name: "show", kind: "read", captcha: "none", reads: ["settings"] }),
    ]);
    expect(messages(r)).toBe("");
  });

  it("refuses a public read of an inbox table", () => {
    expect(messages(manifest([op({ name: "peek", kind: "read", reads: ["entries"] })]))).toContain(
      'cannot read the inbox table "entries"',
    );
  });

  it("refuses reading private and writing published or private tables", () => {
    const text = messages(
      manifest([op({ name: "w", reads: ["internal"], writes: ["settings", "internal"] })]),
    );
    expect(text).toContain('cannot read the private table "internal"');
    expect(text).toContain('cannot write the published table "settings"');
    expect(text).toContain('cannot write the private table "internal"');
  });

  it("refuses a read operation that writes", () => {
    expect(messages(manifest([op({ name: "r", kind: "read", writes: ["entries"] })]))).toContain(
      'declare it kind "write"',
    );
  });

  it("refuses a table without a kind and a kind without a table", () => {
    const { internal: _dropped, ...partial } = KINDS;
    expect(messages(manifest([], partial))).toContain('table "internal" has no kind');
    expect(messages(manifest([], { ...KINDS, ghost: "inbox" }))).toContain(
      'tableKinds names "ghost"',
    );
  });

  it("records captcha required by default and the input as JSON Schema", () => {
    const r = manifest([
      op({
        name: "submit",
        input: z.object({ n: z.number().int() }).strict(),
        writes: ["entries"],
      }),
    ]);
    if (!r.success) throw new Error(messages(r));
    const entry = r.data.publicOperations?.[0];
    expect(entry?.captcha).toBe("required");
    expect(entry?.inputJsonSchema).toMatchObject({
      type: "object",
      properties: { n: { type: "integer" } },
      additionalProperties: false,
    });
  });

  it("accepts requires: [email] and refuses other requirements", () => {
    const base = manifest([]);
    if (!base.success) throw new Error(messages(base));
    expect(pluginManifest.safeParse({ ...base.data, requires: ["email"] }).success).toBe(true);
    expect(pluginManifest.safeParse({ ...base.data, requires: ["sms"] }).success).toBe(false);
  });
});
