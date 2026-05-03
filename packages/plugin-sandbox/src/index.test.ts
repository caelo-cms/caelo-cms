// SPDX-License-Identifier: MPL-2.0

/**
 * Validator + schema emitter + manifest signature unit tests.
 * No DB; pure-function tier.
 */

import { describe, expect, it } from "bun:test";
import {
  generateManifestKeyPair,
  schemaFromSpec,
  signManifest,
  validateManifest,
  validatePlugin,
  validateSource,
  verifyManifestSignature,
} from "./index.js";

const helloWorldManifest = {
  slug: "hello-world",
  version: "0.0.1",
  tier: 2,
  schema: {
    greetings: {
      id: "uuid",
      page_id: "string",
      locale: "string",
      message: "string",
      created_at: "timestamp",
    },
  },
  operations: ["submit", "list"],
  hasStaticRender: true,
};

const helloWorldSource = `
import { definePlugin, defineComponent } from "@caelo/plugin-sdk";

export default definePlugin({
  slug: "hello-world",
  version: "0.0.1",
  tier: 2,
  schema: {
    greetings: {
      id: "uuid",
      page_id: "string",
      locale: "string",
      message: "string",
      created_at: "timestamp",
    },
  },
  operations: {
    submit: async ({ query }, data) => query.insert("greetings", data),
    list: async ({ query }, args) => query.list("greetings", args),
  },
  component: defineComponent({
    tag: "cms-hello-world",
    async mounted(host, { theme }) {
      const root = host.shadowRoot ?? host;
      root.innerHTML = "<p>Hello from " + theme.locale + "</p>";
    },
  }),
});
`;

describe("validateManifest", () => {
  it("accepts a well-formed Tier 2 manifest", () => {
    const r = validateManifest(helloWorldManifest);
    expect(r.failures).toHaveLength(0);
    expect(r.manifest).not.toBeNull();
  });

  it("rejects Tier 2 manifests that declare requestedCapabilities", () => {
    const r = validateManifest({
      ...helloWorldManifest,
      requestedCapabilities: ["cms_admin"],
    });
    expect(r.failures.some((f) => f.kind === "manifest-tier2-cap-leak")).toBe(true);
  });

  it("rejects schemas where a page_id table is missing locale", () => {
    const r = validateManifest({
      ...helloWorldManifest,
      schema: {
        greetings: { id: "uuid", page_id: "string", message: "string" },
      },
    });
    expect(r.failures.some((f) => f.kind === "schema-missing-locale")).toBe(true);
  });

  it("rejects manifests missing required fields", () => {
    const r = validateManifest({ slug: "x" });
    expect(r.failures.some((f) => f.kind === "manifest-shape")).toBe(true);
  });
});

describe("validateSource", () => {
  it("accepts the hello-world source", () => {
    const failures = validateSource({ filename: "hello-world.ts", source: helloWorldSource });
    expect(failures).toHaveLength(0);
  });

  it("rejects fetch() calls", () => {
    const src = `
      import { definePlugin } from "@caelo/plugin-sdk";
      export default definePlugin({
        slug: "x", version: "1.0.0", tier: 2,
        schema: {}, operations: {
          run: async () => { await fetch("https://evil.com"); }
        }
      });
    `;
    const failures = validateSource({ filename: "x.ts", source: src });
    expect(failures.some((f) => f.kind === "forbidden-call" && f.snippet === "fetch")).toBe(true);
  });

  it("rejects globalThis.fetch calls", () => {
    const src = `
      import { definePlugin } from "@caelo/plugin-sdk";
      const r = await globalThis.fetch("/x");
    `;
    const failures = validateSource({ filename: "x.ts", source: src });
    expect(failures.some((f) => f.kind === "forbidden-call")).toBe(true);
  });

  it("rejects Deno.* references", () => {
    const src = `
      import { definePlugin } from "@caelo/plugin-sdk";
      const x = Deno.readTextFile("/etc/passwd");
    `;
    const failures = validateSource({ filename: "x.ts", source: src });
    expect(failures.some((f) => f.kind === "forbidden-deno-access")).toBe(true);
  });

  it("rejects dynamic import()", () => {
    const src = `
      import { definePlugin } from "@caelo/plugin-sdk";
      const m = await import("./other.js");
    `;
    const failures = validateSource({ filename: "x.ts", source: src });
    expect(failures.some((f) => f.kind === "forbidden-dynamic-import")).toBe(true);
  });

  it("rejects imports from non-allowlisted modules", () => {
    const src = `
      import fs from "node:fs";
      import { definePlugin } from "@caelo/plugin-sdk";
    `;
    const failures = validateSource({ filename: "x.ts", source: src });
    expect(failures.some((f) => f.kind === "forbidden-import" && f.snippet === "node:fs")).toBe(
      true,
    );
  });

  it("rejects raw SQL in template literals", () => {
    const src = `
      import { definePlugin } from "@caelo/plugin-sdk";
      const q = \`SELECT * FROM users WHERE id = 1\`;
    `;
    const failures = validateSource({ filename: "x.ts", source: src });
    expect(failures.some((f) => f.kind === "forbidden-sql-template")).toBe(true);
  });

  it("rejects eval()", () => {
    const src = `
      import { definePlugin } from "@caelo/plugin-sdk";
      eval("1+1");
    `;
    const failures = validateSource({ filename: "x.ts", source: src });
    expect(failures.some((f) => f.kind === "forbidden-eval")).toBe(true);
  });

  it("rejects new Function()", () => {
    const src = `
      import { definePlugin } from "@caelo/plugin-sdk";
      const f = new Function("return 1");
    `;
    const failures = validateSource({ filename: "x.ts", source: src });
    expect(failures.some((f) => f.kind === "forbidden-eval")).toBe(true);
  });

  it("rejects globalThis.x = ... assignments", () => {
    const src = `
      import { definePlugin } from "@caelo/plugin-sdk";
      globalThis.x = 1;
    `;
    const failures = validateSource({ filename: "x.ts", source: src });
    expect(failures.some((f) => f.kind === "forbidden-globalthis-write")).toBe(true);
  });
});

describe("validatePlugin", () => {
  it("returns the manifest on full success", () => {
    const r = validatePlugin({ manifest: helloWorldManifest, source: helloWorldSource });
    expect(r.ok).toBe(true);
    expect(r.failures).toHaveLength(0);
    expect(r.manifest?.slug).toBe("hello-world");
  });

  it("aggregates manifest + source failures", () => {
    const r = validatePlugin({
      manifest: { ...helloWorldManifest, requestedCapabilities: ["cms_admin"] },
      source: `import f from "node:fs"; const x = Deno.x;`,
    });
    expect(r.ok).toBe(false);
    const kinds = r.failures.map((f) => f.kind);
    expect(kinds).toContain("manifest-tier2-cap-leak");
    expect(kinds).toContain("forbidden-import");
    expect(kinds).toContain("forbidden-deno-access");
  });
});

describe("schemaFromSpec", () => {
  it("emits a schema name from the slug", () => {
    const out = schemaFromSpec({
      pluginId: "00000000-0000-0000-0000-000000000001",
      slug: "hello-world",
      schema: { greetings: { id: "uuid", page_id: "string", locale: "string", message: "string" } },
    });
    expect(out.schemaName).toBe("plugin_hello_world");
    expect(out.sql).toContain('CREATE SCHEMA IF NOT EXISTS "plugin_hello_world"');
    expect(out.sql).toContain('CREATE TABLE IF NOT EXISTS "plugin_hello_world"."greetings"');
    expect(out.sql).toContain("FORCE  ROW LEVEL SECURITY");
    expect(out.sql).toContain(
      "current_setting('caelo.plugin_id', true) = '00000000-0000-0000-0000-000000000001'",
    );
  });

  it("emits enum CHECK constraints", () => {
    const out = schemaFromSpec({
      pluginId: "00000000-0000-0000-0000-000000000002",
      slug: "comments",
      schema: { comments: { status: "enum:pending,approved,rejected" } },
    });
    expect(out.sql).toContain("CHECK (\"status\" IN ('pending', 'approved', 'rejected'))");
  });

  it("auto-adds an id column when not declared", () => {
    const out = schemaFromSpec({
      pluginId: "00000000-0000-0000-0000-000000000003",
      slug: "empty",
      schema: { rows: { name: "string" } },
    });
    expect(out.sql).toContain("id uuid PRIMARY KEY DEFAULT gen_random_uuid()");
  });
});

describe("manifest signing + verification", () => {
  it("round-trips a generated key pair against a manifest", async () => {
    const keys = await generateManifestKeyPair();
    const m = { ...helloWorldManifest, tier: 1 } as const;
    const { signatureHex } = await signManifest({
      manifest: m as never,
      privateKeyHex: keys.privateKeyHex,
    });
    const r = await verifyManifestSignature({
      manifest: m as never,
      signatureHex,
      publicKeyHex: keys.publicKeyHex,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a tampered manifest", async () => {
    const keys = await generateManifestKeyPair();
    const m = { ...helloWorldManifest, tier: 1 } as const;
    const { signatureHex } = await signManifest({
      manifest: m as never,
      privateKeyHex: keys.privateKeyHex,
    });
    const tampered = { ...m, version: "9.9.9" } as const;
    const r = await verifyManifestSignature({
      manifest: tampered as never,
      signatureHex,
      publicKeyHex: keys.publicKeyHex,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a wrong-length signature", async () => {
    const m = { ...helloWorldManifest, tier: 1 } as const;
    const r = await verifyManifestSignature({
      manifest: m as never,
      signatureHex: "00",
    });
    expect(r.ok).toBe(false);
  });

  it("refuses to verify a Tier 2 manifest", async () => {
    const r = await verifyManifestSignature({
      manifest: helloWorldManifest as never,
      signatureHex: "00".repeat(64),
    });
    expect(r.ok).toBe(false);
  });
});
