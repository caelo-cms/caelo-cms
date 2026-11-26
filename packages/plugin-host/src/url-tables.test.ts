// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 (decision Q7 A) — declared URL slots: the checks a value passes
 * before it can shape an address, the write gate, and the claims a
 * runtime-installed plugin may make. The reads inside a composing
 * transaction and the collision with a page are covered by
 * admin-core's external-url-slots integration test.
 */

import { describe, expect, it } from "bun:test";
import { validateInstallationPolicy, validatePlugin } from "@caelo-cms/plugin-sandbox";
import type { PluginInvocation, PluginManifest, PluginUrlTables } from "@caelo-cms/plugin-sdk";
import {
  checkUrlTableWrite,
  type DeclaredUrlValue,
  declaredValuesProblems,
  decodeDeclaredPrefix,
  urlHostIssue,
  urlSegmentIssue,
} from "./url-tables.js";

const ID = "11111111-1111-4111-8111-111111111111";
const TABLES: PluginUrlTables = {
  pages: { table: "page_markets", valueColumn: "market" },
  values: { table: "markets", valueColumn: "code", segmentColumn: "segment", hostColumn: "host" },
};

const manifest: PluginManifest = {
  slug: "markets",
  version: "1.0.0",
  tier: 2,
  schema: {},
  adminSchema: {
    page_markets: { page_id: "uuid", market: "text" },
    markets: { code: "text", segment: "text", host: "text" },
  },
  indexes: { adminSchema: { page_markets: [["page_id"], ["market"]] } },
  operations: ["set_market"],
  urlTables: TABLES,
  urlContributions: [{ slot: "host" }, { slot: "path-prefix" }],
  requestedCapabilities: ["cms_admin_schema", "url_slots"],
  capabilityReasons: { cms_admin_schema: "markets", url_slots: "market prefixes" },
  hasStaticRender: false,
  hasBuildData: false,
  hasDeferrals: false,
  hasContentVariants: false,
  hasLinkResolve: false,
  hasShareImages: false,
  hasListResolve: false,
};
const source = `export default {slug:"markets",version:"1.0.0",tier:2,operations:{set_market:async()=>null}};`;

describe("#1729 — a URL segment is a page slug, never a path trick", () => {
  it("accepts a plain segment", () => {
    expect(urlSegmentIssue("de")).toBeNull();
    expect(urlSegmentIssue("en-gb")).toBeNull();
  });

  for (const bad of [
    "..",
    ".",
    "a/b",
    "//",
    "de/",
    "%2e%2e",
    "%2F",
    "de%00",
    "de\u0000",
    "de\n",
    "de\t",
    "‮de",
    "DE",
    "_caelo",
    ".well-known",
    "de.html",
    "-de",
    "de-",
    " de",
    "",
    "a".repeat(65),
  ]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(urlSegmentIssue(bad)).toContain("not a path segment");
    });
  }

  it("refuses a segment the site's own services answer under", () => {
    expect(urlSegmentIssue("api")).toContain("reserved");
  });
});

describe("#1729 — a host is one this install serves, written bare", () => {
  const served = new Set(["example.com", "de.example.com"]);
  it("accepts a served host", () => {
    expect(urlHostIssue("de.example.com", served)).toBeNull();
  });
  it("refuses a host the install does not serve", () => {
    expect(urlHostIssue("evil.example.net", served)).toContain("not a domain this install serves");
  });
  for (const bad of [
    "https://de.example.com",
    "de.example.com:8443",
    "user@de.example.com",
    "de.example.com/x",
    "DE.example.com",
    "de.example.com.",
    "de..example.com",
    "localhost",
  ]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(urlHostIssue(bad, served)).toContain("not a host name");
    });
  }
});

describe("#1729 — every address names one value", () => {
  const v = (value: string, segment: string | null, host: string | null): DeclaredUrlValue => ({
    id: value,
    value,
    segment,
    host,
  });
  it("accepts distinct values", () => {
    expect(declaredValuesProblems([v("de", "de", null), v("fr", "fr", null)])).toEqual([]);
  });
  it("refuses two values claiming one segment, host or name", () => {
    expect(declaredValuesProblems([v("de", "x", null), v("at", "x", null)])[0]).toContain(
      'both claim the segment "x"',
    );
    expect(declaredValuesProblems([v("de", null, "a.com"), v("at", null, "a.com")])[0]).toContain(
      'both claim the host "a.com"',
    );
    expect(declaredValuesProblems([v("de", "de", null), v("de", "at", null)])[0]).toContain(
      'value "de" has two rows',
    );
  });
  it("decodes a prefixed path back to its value, and nothing else", () => {
    const values = [v("de", "de", null), v("fr", "fr", null)];
    expect(decodeDeclaredPrefix(["de", "preise"], values)).toEqual({
      consumed: 1,
      annotations: { value: "de" },
    });
    expect(decodeDeclaredPrefix(["pricing"], values)).toBeNull();
    expect(decodeDeclaredPrefix([], values)).toBeNull();
  });
});

describe("#1729 — a URL table changes only in an Owner-approved call", () => {
  const list = async () => [];
  for (const origin of ["chat", "owner-panel", "worker", "system", "render", "batch"] as const) {
    it(`refuses a ${origin} write to either table`, async () => {
      const invocation = { origin, actorId: ID } as PluginInvocation;
      for (const table of ["page_markets", "markets"]) {
        await expect(
          checkUrlTableWrite({
            pluginSlug: "markets",
            tables: TABLES,
            invocation,
            write: { method: "insert", table, data: { code: "de" } },
            list,
          }),
        ).rejects.toThrow(/shapes page addresses .* only in a call the Owner approved/);
      }
    });
  }

  it("leaves the plugin's other tables alone", async () => {
    await checkUrlTableWrite({
      pluginSlug: "markets",
      tables: TABLES,
      invocation: { origin: "chat", actorId: ID } as PluginInvocation,
      write: { method: "insert", table: "notes", data: {} },
      list,
    });
  });

  it("refuses a page naming a value that does not exist, and bulk edits", async () => {
    const approved = { origin: "approved", actorId: ID } as PluginInvocation;
    await expect(
      checkUrlTableWrite({
        pluginSlug: "markets",
        tables: TABLES,
        invocation: approved,
        write: { method: "insert", table: "page_markets", data: { page_id: ID, market: "xx" } },
        list,
      }),
    ).rejects.toThrow(/value "xx" is not in markets/);
    await expect(
      checkUrlTableWrite({
        pluginSlug: "markets",
        tables: TABLES,
        invocation: approved,
        write: { method: "updateMany", table: "markets", data: { segment: "x" } },
        list,
      }),
    ).rejects.toThrow(/one at a time/);
  });

  it("refuses removing a value a page still names", async () => {
    const rows: Record<string, Record<string, unknown>[]> = {
      markets: [{ id: ID, code: "de", segment: "de", host: null }],
      page_markets: [{ id: "p", page_id: "22222222-2222-4222-8222-222222222222", market: "de" }],
    };
    await expect(
      checkUrlTableWrite({
        pluginSlug: "markets",
        tables: TABLES,
        invocation: { origin: "approved", actorId: ID } as PluginInvocation,
        write: { method: "delete", table: "markets", id: ID },
        list: (async (table: string) => rows[table] ?? []) as never,
      }),
    ).rejects.toThrow(/still shapes the address of page 22222222/);
  });

  it("refuses a segment that is no path segment before looking anything up", async () => {
    await expect(
      checkUrlTableWrite({
        pluginSlug: "markets",
        tables: TABLES,
        invocation: { origin: "approved", actorId: ID } as PluginInvocation,
        write: { method: "insert", table: "markets", data: { code: "de", segment: "../de" } },
        list,
      }),
    ).rejects.toThrow(/not a path segment/);
  });
});

describe("#1729 — what a runtime-installed plugin may claim", () => {
  it("stages host and path-prefix declared as tables", () => {
    const v = validatePlugin({ manifest, source, allowExternalCapabilities: true });
    expect(v.failures).toEqual([]);
    expect(() => validateInstallationPolicy(manifest)).not.toThrow();
  });

  for (const slot of ["slug-format", "full-path"] as const) {
    it(`refuses ${slot}, naming the slots it may claim`, () => {
      expect(() =>
        validateInstallationPolicy({ ...manifest, urlContributions: [{ slot }] }),
      ).toThrow(
        new RegExp(
          `"${slot}" is not available to runtime-installed plugins.*may claim host and path-prefix`,
        ),
      );
    });
  }

  it("refuses a claim without its tables", () => {
    const { urlTables: _omit, ...rest } = manifest;
    expect(() =>
      validateInstallationPolicy({ ...rest, urlContributions: [{ slot: "path-prefix" }] }),
    ).toThrow(/declare `urlTables`/);
  });

  it("refuses tables without the indexes the host reads by, or with the wrong claims", () => {
    const v = validatePlugin({
      manifest: { ...manifest, indexes: undefined, urlContributions: [{ slot: "host" }] },
      source,
      allowExternalCapabilities: true,
    });
    const hints = v.failures.map((f) => f.hint).join(" | ");
    expect(hints).toContain(
      'declare an index that starts with it — indexes: { adminSchema: { page_markets: [["page_id"]] } }',
    );
    expect(hints).toContain('[["market"]]');
    expect(hints).toContain("urlContributions must claim exactly those");
  });

  it("refuses tables whose columns are not declared with their types", () => {
    const v = validatePlugin({
      manifest: {
        ...manifest,
        adminSchema: {
          page_markets: { page_id: "text", market: "text" },
          markets: { code: "int" },
        },
      },
      source,
      allowExternalCapabilities: true,
    });
    const hints = v.failures.map((f) => f.hint).join(" | ");
    expect(hints).toContain(
      'page_markets.page_id (the page a row shapes) must be declared as "uuid"',
    );
    expect(hints).toContain("markets.code (the value) must be declared");
    expect(hints).toContain("markets.segment (the value's path segment)");
  });

  it("refuses URL claims without the url_slots grant", () => {
    const v = validatePlugin({
      manifest: {
        ...manifest,
        requestedCapabilities: ["cms_admin_schema"],
        capabilityReasons: { cms_admin_schema: "markets" },
      },
      source,
      allowExternalCapabilities: true,
    });
    expect(v.failures.map((f) => f.hint).join(" | ")).toContain("`url_slots` capability");
  });
});
