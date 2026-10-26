// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { manifestFromDefinition, type PluginAdminPanel, pluginManifest } from "./index.js";

const base = {
  slug: "inbox",
  version: "1.0.0",
  tier: 2 as const,
  schema: {},
  operations: ["list", "archive", "bulk_archive", "export", "stats", "read_settings", "save"],
  hasStaticRender: false,
};

/** A panel covering every section kind, shaped like a consent-log panel. */
const panel: PluginAdminPanel = {
  slug: "log",
  title: "Consent log",
  description: "Who consented to what, and when.",
  icon: "shield-check",
  permission: "privacy.view",
  sections: [
    {
      kind: "stats",
      id: "summary",
      title: "This month",
      operation: "stats",
      entriesKey: "categories",
    },
    {
      kind: "table",
      id: "records",
      title: "Records",
      operation: "list",
      rowsKey: "records",
      rowKey: "id",
      emptyMessage: "No consent recorded yet.",
      columns: [
        { key: "recorded_at", label: "Recorded", format: "datetime" },
        { key: "visitor_id", label: "Visitor", format: "code" },
        { key: "ip_hash", label: "IP hash", format: "code" },
        { key: "policy_version", label: "Policy", format: "number" },
        { key: "granted", label: "Granted", format: "list" },
      ],
      filters: [
        {
          arg: "status",
          label: "Status",
          allLabel: "All",
          options: [{ value: "new", label: "New" }],
        },
      ],
      paging: {
        pageSize: 50,
        limitArg: "limit",
        cursor: { arg: "before", key: "recorded_at" },
        hasMoreKey: "truncated",
      },
      rowActions: [
        {
          id: "archive",
          label: "Archive",
          operation: "archive",
          variant: "outline",
          rowArgs: { id: "id" },
          when: [{ key: "status", notIn: ["archived"] }],
          successMessage: "Archived.",
        },
      ],
      bulkActions: [
        {
          id: "archive-all",
          label: "Archive selected",
          operation: "bulk_archive",
          idsArg: "ids",
          variant: "outline",
          confirm: { title: "Archive these?", confirmLabel: "Archive" },
          successMessage: "Archived {updated}.",
        },
      ],
      download: { label: "Export CSV", operation: "export", csvKey: "csv", filename: "log.csv" },
    },
    {
      kind: "settings",
      id: "retention",
      title: "Retention",
      readOperation: "read_settings",
      writeOperation: "save",
      submitLabel: "Save",
      successMessage: "Saved.",
      fields: [
        {
          arg: "retentionDays",
          valueKey: "retentionDays",
          label: "Keep records for (days)",
          input: "number",
          required: true,
          integer: true,
          min: 1,
          max: 3650,
        },
        {
          arg: "placeholderModuleSlug",
          valueKey: "placeholderModuleSlug",
          label: "Placeholder module",
          input: "text",
          required: true,
          maxLength: 120,
        },
      ],
    },
  ],
};

function issues(manifest: unknown): string[] {
  const r = pluginManifest.safeParse(manifest);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("adminPanels in the manifest", () => {
  it("accepts a panel using every section kind", () => {
    expect(issues({ ...base, adminPanels: [panel] })).toEqual([]);
  });

  it("refuses an operation the plugin does not declare, naming where", () => {
    const bad = {
      ...panel,
      sections: [{ ...panel.sections[1], operation: "list_everything" }],
    };
    expect(issues({ ...base, adminPanels: [bad] })).toEqual([
      'adminPanels.0.sections.0.operation: operation "list_everything" is not one of the plugin\'s operations',
    ]);
  });

  it("refuses duplicate panel slugs, section ids and action ids", () => {
    const table = panel.sections[1];
    if (table?.kind !== "table") throw new Error("fixture");
    const dupAction = {
      ...table,
      bulkActions: [{ ...table.bulkActions?.[0], id: "archive" }],
    };
    const found = issues({
      ...base,
      adminPanels: [
        { ...panel, sections: [dupAction, { ...dupAction }] },
        { ...panel, sections: [panel.sections[0]] },
      ],
    });
    expect(found).toContain('adminPanels.1.slug: admin panel "log" is declared twice');
    expect(found).toContain('adminPanels.0.sections.1.id: section "records" is declared twice');
    expect(found).toContain(
      'adminPanels.0.sections.0.bulkActions.0.id: action "archive" is declared twice in section "records"',
    );
  });

  it("refuses row actions without a rowKey", () => {
    const table = panel.sections[1];
    if (table?.kind !== "table") throw new Error("fixture");
    const { rowKey: _rowKey, ...withoutKey } = table;
    expect(
      issues({ ...base, adminPanels: [{ ...panel, sections: [withoutKey] }] }).join(),
    ).toContain("row and bulk actions need a rowKey");
  });

  it("refuses an argument that is both fixed and operator-supplied", () => {
    const table = panel.sections[1];
    if (table?.kind !== "table") throw new Error("fixture");
    const clash = {
      ...table,
      rowActions: [{ ...table.rowActions?.[0], args: { id: "fixed" } }],
    };
    expect(issues({ ...base, adminPanels: [{ ...panel, sections: [clash] }] }).join()).toContain(
      'argument "id" is both fixed and taken from the operator',
    );
  });

  it("refuses a permission outside the admin's catalog and an unknown icon", () => {
    expect(
      issues({ ...base, adminPanels: [{ ...panel, permission: "everything" }] }).length,
    ).toBeGreaterThan(0);
    expect(issues({ ...base, adminPanels: [{ ...panel, icon: "skull" }] }).length).toBeGreaterThan(
      0,
    );
  });

  it("refuses markup-bearing ids that would reach URLs", () => {
    expect(issues({ ...base, adminPanels: [{ ...panel, slug: "<b>" }] }).length).toBeGreaterThan(0);
  });
});

describe("manifestFromDefinition", () => {
  const def = {
    ...base,
    operations: Object.fromEntries(base.operations.map((o) => [o, () => null])),
  };

  it("carries the panels into the signed/approved manifest", () => {
    expect(manifestFromDefinition({ ...def, adminPanels: [panel] }).adminPanels).toEqual([panel]);
  });

  it("omits the field for a plugin without panels", () => {
    expect("adminPanels" in manifestFromDefinition({ ...def, adminPanels: [] })).toBe(false);
  });
});
