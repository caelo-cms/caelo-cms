// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { provisionedSchemaName } from "../plugin-schema-provision.js";

describe("provisionedSchemaName", () => {
  it("reads the schema the emitters create", () => {
    expect(
      provisionedSchemaName(
        "t",
        'CREATE SCHEMA IF NOT EXISTS "plugin_international_site";\n\nGRANT USAGE ON SCHEMA "plugin_international_site" TO admin_role;',
      ),
    ).toBe("plugin_international_site");
  });

  it("refuses SQL that does not open with the emitters' CREATE SCHEMA", () => {
    expect(() => provisionedSchemaName("provisionPluginPublicSchema", "SELECT 1")).toThrow(
      /provisionPluginPublicSchema: the SQL does not start with CREATE SCHEMA/,
    );
    expect(() => provisionedSchemaName("t", 'CREATE SCHEMA IF NOT EXISTS "public";')).toThrow(
      /does not start with/,
    );
    expect(() => provisionedSchemaName("t", '  CREATE SCHEMA IF NOT EXISTS "plugin_x";')).toThrow(
      /does not start with/,
    );
  });
});
