// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { isExternallyBrokered, pluginCapability, pluginManifest } from "@caelo-cms/plugin-sdk";
import { validateInstallationPolicy, validateSelectedGrants } from "./installation-policy.js";

function manifest() {
  return pluginManifest.parse({
    slug: "external-notes",
    version: "1.0.0",
    tier: 2,
    schema: {},
    adminSchema: { notes: { body: "text" } },
    operations: ["save"],
    requestedCapabilities: ["cms_admin_schema"],
    capabilityReasons: { cms_admin_schema: "Store private authoring notes" },
  });
}
describe("explicit external installation grants", () => {
  it("does not treat a declaration as approval", () => {
    expect(() => validateSelectedGrants(manifest(), [])).toThrow("explicitly");
    expect(() => validateSelectedGrants(manifest(), ["cms_admin_schema"])).not.toThrow();
    expect(() => validateSelectedGrants(manifest(), ["cms_admin_schema", "email"])).toThrow(
      "explicitly",
    );
  });
  it("requires reasons and operation scopes", () => {
    expect(() => validateInstallationPolicy({ ...manifest(), capabilityReasons: {} })).toThrow(
      "Explain",
    );
    // The allowlist rule applies once cms_admin is brokered (#1729); until
    // then the refusal of an unbrokered capability comes first.
    expect(() =>
      validateInstallationPolicy({
        ...manifest(),
        requestedCapabilities: ["cms_admin"],
        adminSchema: {},
        capabilityReasons: { cms_admin: "Edit pages" },
      }),
    ).toThrow(isExternallyBrokered("cms_admin") ? "allowlist" : "not available");
  });
  it("refuses the part of url_slots no runtime-installed plugin can have, naming what it may claim (#1729 Q7 A)", () => {
    // Independent of which capabilities are still planned: the slots that
    // map every slug through code are never offered to an installed plugin.
    for (const slot of ["slug-format", "full-path"] as const) {
      const refused = () =>
        validateInstallationPolicy({
          ...manifest(),
          requestedCapabilities: ["cms_admin_schema", "url_slots"],
          capabilityReasons: { cms_admin_schema: "Notes", url_slots: "Shape slugs" },
          urlContributions: [{ slot }],
        });
      expect(refused).toThrow(
        `URL slot "${slot}" is not available to runtime-installed plugins: it maps every page's slug through code`,
      );
      expect(refused).toThrow(/may claim host and path-prefix, declared as tables \(`urlTables`\)/);
      expect(refused).toThrow(`Remove "${slot}" from \`urlContributions\``);
    }
  });
  it("refuses a capability still planned, naming its issue and what can be requested (#1729)", () => {
    // Vacuous once every capability is brokered; the parity test then still
    // checks that each one is brokered or planned with an issue.
    for (const capability of pluginCapability.options.filter((c) => !isExternallyBrokered(c))) {
      const refused = () =>
        validateInstallationPolicy({
          ...manifest(),
          requestedCapabilities: ["cms_admin_schema", capability],
          capabilityReasons: { cms_admin_schema: "Notes", [capability]: "Probe" },
        });
      expect(refused).toThrow(
        new RegExp(`\`${capability}\`.*not available to runtime-installed plugins yet \\(#\\d+\\)`),
      );
      expect(refused).toThrow(/can request: .*cms_admin_schema/);
    }
  });
  it("ai_provider needs the daily cap the Owner approves, and only ai_provider takes one (#1729 Q8 A)", () => {
    const ai = (capabilityConstraints?: Record<string, unknown>) =>
      validateInstallationPolicy({
        ...manifest(),
        requestedCapabilities: ["cms_admin_schema", "ai_provider"],
        capabilityReasons: { cms_admin_schema: "Notes", ai_provider: "Summaries" },
        ...(capabilityConstraints ? { capabilityConstraints } : {}),
      });
    expect(() => ai()).toThrow("`ai_provider` needs a daily AI spending cap");
    expect(() => ai({ ai_provider: {} })).toThrow("needs a daily AI spending cap");
    expect(() => ai({ ai_provider: { maxDailyCostMicrocents: 500_000_000 } })).not.toThrow();
    expect(() =>
      ai({
        ai_provider: { maxDailyCostMicrocents: 1 },
        cms_admin_schema: { maxDailyCostMicrocents: 1 },
      }),
    ).toThrow("limits `ai_provider` only");
  });
  it("requires reviewed capabilities for browser assets", () => {
    expect(() =>
      validateInstallationPolicy({ ...manifest(), clientFiles: { "runtime.js": "x" } }),
    ).toThrow("client_assets");
  });
});

it("refuses unbounded host-side tool schemas and ambiguous approval declarations", () => {
  const tool = {
    name: "external_notes__save",
    operationName: "save",
    description: "Save notes",
    inputJsonSchema: { type: "object", additionalProperties: false } as Record<string, unknown>,
  };
  const withTools = {
    ...manifest(),
    requestedCapabilities: ["cms_admin_schema", "chat_runner_tools"] as const,
    capabilityReasons: {
      cms_admin_schema: "Private notes",
      chat_runner_tools: "Author notes in chat",
    },
    tools: [tool],
  };
  const check = (tools: (typeof tool)[]) =>
    validateInstallationPolicy(pluginManifest.parse({ ...withTools, tools }));
  expect(() => check([tool])).not.toThrow();
  expect(() => check([tool, { ...tool, name: "external_notes__other" }])).toThrow("exactly one");
  expect(() =>
    check([{ ...tool, inputJsonSchema: { type: "string", pattern: "(a+)+$" } }]),
  ).toThrow("keyword");
  expect(() => check([{ ...tool, inputJsonSchema: { $ref: "#" } }])).toThrow("keyword");
  for (const schema of [
    { type: "not-a-json-schema-type" },
    { type: "object", enum: "invalid" },
    { type: "object", minimum: "zero" },
    { type: "object", required: "body" },
    { type: "object", required: ["missing"], properties: {} },
    { type: "object", properties: { list: { type: "array" } } },
    { type: "object", properties: { text: { type: "string", minLength: -1 } } },
    { type: "object", properties: { n: { type: "number", minimum: 3, maximum: 2 } } },
  ])
    expect(() => check([{ ...tool, inputJsonSchema: schema }])).toThrow();
  expect(() => check([{ ...tool, inputJsonSchema: { type: "string" } }])).toThrow("object root");
  expect(() =>
    check([{ ...tool, inputJsonSchema: { type: "object", additionalProperties: true } }]),
  ).toThrow("object root");
  let nested: Record<string, unknown> = { type: "object" };
  for (let depth = 0; depth < 15; depth++) nested = { type: "object", properties: { nested } };
  expect(() => check([{ ...tool, inputJsonSchema: nested }])).toThrow("schema shape");
});

describe("installed plugins stay inside their own namespace (#515 review)", () => {
  it("refuses foreign keys into core tables", () => {
    expect(() =>
      validateInstallationPolicy({
        ...manifest(),
        adminSchema: { notes: { body: "text", page_id: "ref:pages" } },
      }),
    ).toThrow("cannot reference core tables");
  });

  it("refuses a slug whose schema name Postgres would truncate", () => {
    expect(() => pluginManifest.parse({ ...manifest(), slug: `a${"b".repeat(55)}` })).toThrow();
    expect(() => pluginManifest.parse({ ...manifest(), slug: `a${"b".repeat(54)}` })).not.toThrow();
  });

  it("keeps tool names in an unambiguous per-slug namespace", () => {
    const withTool = (name: string) => ({
      ...manifest(),
      requestedCapabilities: ["cms_admin_schema", "chat_runner_tools"] as const,
      capabilityReasons: { cms_admin_schema: "notes", chat_runner_tools: "save notes" },
      tools: [
        {
          name,
          description: "Save a note",
          operationName: "save",
          inputJsonSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    expect(() => validateInstallationPolicy(withTool("external_notes__save"))).not.toThrow();
    // "external_notes___save" belongs to slug "external-notes-".
    expect(() => validateInstallationPolicy(withTool("external_notes___save"))).toThrow(
      "starting with a letter",
    );
  });
});

describe("tool names the model provider accepts", () => {
  const withTools = (...names: string[]) => ({
    ...manifest(),
    operations: names.map((_, i) => `op${i}`),
    requestedCapabilities: ["cms_admin_schema", "chat_runner_tools"] as const,
    capabilityReasons: { cms_admin_schema: "notes", chat_runner_tools: "tools" },
    tools: names.map((name, i) => ({
      name,
      description: "A tool",
      operationName: `op${i}`,
      inputJsonSchema: { type: "object", properties: {}, additionalProperties: false },
    })),
  });

  it("refuses duplicate tool names", () => {
    expect(() =>
      validateInstallationPolicy(withTools("external_notes__a", "external_notes__a")),
    ).toThrow("Duplicate tool name");
  });

  it("refuses names outside a-z0-9_ or longer than 64", () => {
    expect(() => validateInstallationPolicy(withTools("external_notes__a b"))).toThrow("1-64");
    expect(() =>
      validateInstallationPolicy(withTools(`external_notes__${"a".repeat(60)}`)),
    ).toThrow("1-64");
  });
});

it("requires scoped, explicitly granted companion skill declarations", () => {
  const guide = {
    slug: "external-notes-guide",
    displayName: "Guide",
    description: "Author notes",
    body: "Use the notes tools.",
  };
  const base = manifest();
  const check = (skills: (typeof guide)[]) =>
    validateInstallationPolicy(
      pluginManifest.parse({
        ...base,
        skills,
        requestedCapabilities: ["cms_admin_schema", "companion_skills"],
        capabilityReasons: { ...base.capabilityReasons, companion_skills: "Teach note authoring" },
      }),
    );
  expect(() => validateInstallationPolicy({ ...base, skills: [guide] })).toThrow(
    "companion_skills",
  );
  expect(() => check([guide])).not.toThrow();
  expect(() => check([{ ...guide, slug: "another-plugin-guide" }])).toThrow("must start with");
  expect(() => check([guide, guide])).toThrow("Duplicate companion");
  expect(() =>
    check(Array.from({ length: 21 }, (_, i) => ({ ...guide, slug: `${guide.slug}-${i}` }))),
  ).toThrow("at most 20");
});
