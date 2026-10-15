// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 — a plugin's `visitorProjection`: the manifest accepts only
 * what its private storage declares, and the provisioning DDL keeps the
 * projected tables (and only those) wired to the publisher's outbox.
 */

import { describe, expect, it } from "bun:test";
import { manifestFromDefinition, pluginManifest } from "@caelo-cms/plugin-sdk";
import { adminSchemaFromSpec } from "./schema.js";

const PLUGIN_ID = "11111111-2222-4333-8444-555555555555";
const base = {
  slug: "probe",
  version: "1.0.0",
  tier: 1 as const,
  schema: {},
  adminSchema: { settings: { label: "string", secret: "string" }, drafts: { body: "string" } },
  operations: ["read"],
};

describe("manifest visitorProjection (#635)", () => {
  it("accepts declared tables and columns", () => {
    expect(
      pluginManifest.safeParse({ ...base, visitorProjection: { settings: ["id", "label"] } })
        .success,
    ).toBe(true);
  });

  it("rejects a table or column private storage does not declare", () => {
    const table = pluginManifest.safeParse({ ...base, visitorProjection: { nope: ["label"] } });
    expect(table.success).toBe(false);
    expect(JSON.stringify(table.error?.issues)).toContain("not in adminSchema");
    const column = pluginManifest.safeParse({ ...base, visitorProjection: { settings: ["x"] } });
    expect(column.success).toBe(false);
  });

  it("rejects host-owned columns", () => {
    expect(
      pluginManifest.safeParse({
        ...base,
        visitorProjection: { settings: ["caelo_chat_branch_id"] },
      }).success,
    ).toBe(false);
  });

  it("is carried from the definition into the signed manifest", () => {
    const m = manifestFromDefinition({
      ...base,
      operations: { read: async () => null },
      visitorProjection: { settings: ["label"] },
    });
    expect(m.visitorProjection).toEqual({ settings: ["label"] });
  });
});

describe("adminSchemaFromSpec projection triggers (#635)", () => {
  it("wires each projected table to the outbox and unwires the rest", () => {
    const { sql } = adminSchemaFromSpec({
      pluginId: PLUGIN_ID,
      slug: "probe",
      adminSchema: base.adminSchema,
      projectedTables: ["settings"],
    });
    expect(sql).toContain(
      `CREATE TRIGGER caelo_projection AFTER INSERT OR UPDATE OR DELETE ON "plugin_probe"."settings"`,
    );
    expect(sql).toContain(`caelo_mark_public_projection('plugin:${PLUGIN_ID}')`);
    expect(sql).toContain(`DROP TRIGGER IF EXISTS caelo_projection ON "plugin_probe"."drafts";`);
    expect(sql).not.toContain(`ON "plugin_probe"."drafts"\n      FOR EACH STATEMENT`);
  });

  it("refuses a projected table that is not in the schema", () => {
    expect(() =>
      adminSchemaFromSpec({
        pluginId: PLUGIN_ID,
        slug: "probe",
        adminSchema: base.adminSchema,
        projectedTables: ["ghost"],
      }),
    ).toThrow(/not in adminSchema/);
  });
});
