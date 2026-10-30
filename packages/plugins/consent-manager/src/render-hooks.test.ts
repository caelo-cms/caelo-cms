// SPDX-License-Identifier: MPL-2.0

/**
 * #1214 — the render hooks read stored verdicts, never the whole site.
 *
 * A fake context stands in for the host: private storage in memory with
 * the broker's filter semantics (equality, `anyOf`, `since`, `orderBy`,
 * at most 1000 rows per read), and a `cms` handle that records every
 * core operation called. The real-engine behaviour is pinned by
 * `admin-core/src/__tests__/consent-manager.integration.test.ts`; this
 * file pins what the render path may and may not read, at a scale (over
 * 1,000 guards) that test does not build.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { PluginContextTier1, PluginQueryFilter } from "@caelo-cms/plugin-sdk";
import { DEFAULT_CATEGORIES } from "./categories.js";
import { allGuards, guardsByModule } from "./guards.js";
import consentPlugin from "./index.js";

type Row = Record<string, unknown> & { id: string };

const RESERVED = new Set(["limit", "orderBy", "orderDir", "since", "before", "anyOf"]);

/** Private storage with the broker's filter semantics. */
class MemoryStore {
  readonly tables = new Map<string, Row[]>();
  reads = 0;
  #seq = 0;

  rows(table: string): Row[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  /** Insert with an explicit creation time, so ties can be staged. */
  seed(table: string, data: Record<string, unknown>, createdAt?: string): Row {
    this.#seq += 1;
    const row: Row = {
      id: `00000000-0000-4000-8000-${String(this.#seq).padStart(12, "0")}`,
      created_at: createdAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, 0, this.#seq)).toISOString(),
      ...data,
    };
    this.rows(table).push(row);
    return row;
  }

  readonly query = {
    insert: async (table: string, data: Record<string, unknown>) => ({
      id: this.seed(table, data).id,
    }),
    list: async (table: string, filter: PluginQueryFilter = {}) => {
      this.reads += 1;
      const limit = (filter.limit as number | undefined) ?? 100;
      if (limit <= 0 || limit > 1000) throw new Error("limit must be 1..1000");
      let rows = this.rows(table).filter((r) => {
        if (typeof filter.since === "string" && !(String(r.created_at) > filter.since))
          return false;
        for (const [k, v] of Object.entries(filter)) {
          if (RESERVED.has(k)) continue;
          if (r[k] !== v) return false;
        }
        for (const [k, vs] of Object.entries(filter.anyOf ?? {})) {
          if (vs.length === 0 || vs.length > 1000) throw new Error("anyOf must list 1..1000");
          if (!vs.includes(r[k] as string)) return false;
        }
        return true;
      });
      if (typeof filter.orderBy === "string") {
        const key = filter.orderBy;
        const dir = filter.orderDir === "desc" ? -1 : 1;
        rows = [...rows].sort((a, b) => dir * String(a[key]).localeCompare(String(b[key])));
      }
      return rows.slice(0, limit).map((r) => ({ ...r }));
    },
    update: async (table: string, id: string, patch: Record<string, unknown>) => {
      const row = this.rows(table).find((r) => r.id === id);
      if (!row) throw new Error(`no ${table} row ${id}`);
      Object.assign(row, patch);
    },
    delete: async (table: string, id: string) => {
      this.tables.set(
        table,
        this.rows(table).filter((r) => r.id !== id),
      );
    },
    compareAndSwap: async () => false,
  };
}

interface ModuleFixture {
  id: string;
  slug: string;
  kind: string;
  html: string;
  css: string;
  js: string;
  fields: unknown[];
}

let store: MemoryStore;
let cmsCalls: string[];
let modules: ModuleFixture[];

function moduleId(n: number): string {
  return `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function makeCtx(): PluginContextTier1 {
  return {
    adminQuery: store.query,
    consentPurposes: { list: async () => [] },
    cms: {
      call: async (op: string, input: { moduleIds?: string[] }) => {
        cmsCalls.push(op);
        if (op === "modules.list") {
          return {
            modules: input.moduleIds
              ? modules.filter((m) => input.moduleIds?.includes(m.id))
              : modules,
          };
        }
        if (op === "content_instances.list") return { instances: [] };
        if (op === "pages.list") return { pages: [] };
        throw new Error(`unexpected core op ${op}`);
      },
    },
  } as unknown as PluginContextTier1;
}

type Op = (ctx: PluginContextTier1, args?: unknown) => Promise<unknown>;
const ops = consentPlugin.operations as unknown as Record<string, Op>;
const buildAssets = consentPlugin.buildAssets as unknown as (
  ctx: PluginContextTier1,
) => Promise<Record<string, string>>;

function seedPluginRows(): void {
  store.seed("settings", {
    policy_version: 3,
    retention_days: 365,
    placeholder_module_slug: "consent-placeholder",
    declaration_updated_at: "2026-01-01T00:00:00.000Z",
  });
  for (const c of DEFAULT_CATEGORIES) {
    store.seed("categories", {
      key: c.key,
      display_name: c.displayName,
      description: c.description,
      required: c.required,
      position: c.position,
    });
  }
}

function guard(n: number, status: string, category: string, hosts: string[], createdAt?: string) {
  store.seed(
    "module_guards",
    {
      module_id: moduleId(n),
      category_key: category,
      detected_hosts: hosts,
      status,
      decided_by: status === "gated" ? "vendor-table" : "",
    },
    createdAt,
  );
}

const YOUTUBE = '<iframe src="https://www.youtube.com/embed/x"></iframe>';
const UNKNOWN = '<iframe src="https://widgets.unknown-vendor.example/x"></iframe>';

function candidate(n: number, html: string) {
  return { moduleId: moduleId(n), html, css: "", js: "", fields: [], contentValues: [] };
}

beforeEach(() => {
  store = new MemoryStore();
  cmsCalls = [];
  modules = [];
  seedPluginRows();
});

describe("render hooks read verdicts only (#1214)", () => {
  it("never list modules or content instances", async () => {
    guard(1, "gated", "marketing", ["www.youtube.com"]);
    const ctx = makeCtx();
    await buildAssets(ctx);
    await ops.consent_data_lists?.(ctx, { pageIds: ["p1"] });
    await ops.consent_deferrals?.(ctx, { modules: [candidate(1, YOUTUBE)] });
    expect(cmsCalls).not.toContain("modules.list");
    expect(cmsCalls).not.toContain("content_instances.list");
  });

  it("offers a category a stored verdict gates, and only that one", async () => {
    guard(1, "gated", "marketing", ["www.youtube.com"]);
    const ctx = makeCtx();
    const lists = (await ops.consent_data_lists?.(ctx, { pageIds: ["p1"] })) as {
      sources: Record<string, { consent_categories: Array<{ id: string }> }>;
    };
    expect(lists.sources.p1?.consent_categories.map((c) => c.id)).toEqual([
      "necessary",
      "marketing",
    ]);
    const js = (await buildAssets(ctx))["runtime.js"] ?? "";
    expect(js).toContain('"key":"marketing"');
    expect(js).not.toContain('"key":"analytics"');
  });

  it("keeps an unclassified vendor withheld without offering a category for it", async () => {
    guard(2, "pending", "marketing", ["widgets.unknown-vendor.example"]);
    const ctx = makeCtx();
    const lists = (await ops.consent_data_lists?.(ctx, { pageIds: ["p1"] })) as {
      sources: Record<string, { consent_categories: Array<{ id: string }> }>;
    };
    // Pending is a decision nobody made: no category is on offer for it.
    expect(lists.sources.p1?.consent_categories.map((c) => c.id)).toEqual(["necessary"]);
    const d = (await ops.consent_deferrals?.(ctx, { modules: [candidate(2, UNKNOWN)] })) as {
      deferrals: Record<string, { reason: string }>;
    };
    // …and the visitor still gets nothing from the vendor.
    expect(d.deferrals[moduleId(2)]?.reason).toBe("unclassified");
  });

  it("withholds an edit the verdicts have not caught up with", async () => {
    // A stored verdict about other hosts says nothing about these.
    guard(3, "allowed", "marketing", ["player.vimeo.com"]);
    const d = (await ops.consent_deferrals?.(makeCtx(), {
      modules: [candidate(3, UNKNOWN)],
    })) as { deferrals: Record<string, { reason: string }> };
    expect(d.deferrals[moduleId(3)]?.reason).toBe("unclassified");
  });

  it("reads the guards of a whole render pass at once", async () => {
    for (let n = 1; n <= 50; n += 1) guard(n, "gated", "marketing", ["www.youtube.com"]);
    store.reads = 0;
    const d = (await ops.consent_deferrals?.(makeCtx(), {
      modules: Array.from({ length: 50 }, (_, i) => candidate(i + 1, YOUTUBE)),
    })) as { deferrals: Record<string, { reason: string }> };
    expect(Object.keys(d.deferrals)).toHaveLength(50);
    // settings + categories + ONE guard read, not one per module.
    expect(store.reads).toBe(3);
  });
});

describe("more than 1,000 guards (#1214, CLAUDE.md §2)", () => {
  beforeEach(() => {
    // 1,500 allowed guards with ties straddling every 1,000-row page
    // boundary, and one gated verdict past the old 1,000-row cap.
    // Guard n is the (n + 5)th row seeded (settings + 4 categories first),
    // so this is guard 995's own creation time: the tie group sits where
    // the first 1,000-row page ends.
    const tie = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 995 + 5)).toISOString();
    for (let n = 1; n <= 1500; n += 1) {
      guard(
        n,
        "allowed",
        "marketing",
        ["www.youtube.com"],
        n >= 995 && n <= 1010 ? tie : undefined,
      );
    }
    guard(1501, "gated", "analytics", ["www.google-analytics.com"]);
  });

  it("pages through every guard, ties at the page boundary included", async () => {
    const all = await allGuards(store.query as never);
    expect(all).toHaveLength(1501);
    expect(new Set(all.map((g) => g.id)).size).toBe(1501);
  });

  it("finds a guard of a render pass past the first thousand", async () => {
    const ids = Array.from({ length: 1501 }, (_, i) => moduleId(i + 1));
    const found = await guardsByModule(store.query as never, ids);
    expect(found.size).toBe(1501);
    expect(found.get(moduleId(1501))?.status).toBe("gated");
  });

  it("offers the category of the gated verdict however many guards precede it", async () => {
    const js = (await buildAssets(makeCtx()))["runtime.js"] ?? "";
    expect(js).toContain('"key":"analytics"');
    expect(js).not.toContain('"key":"marketing"');
  });
});

describe("module_changes keeps verdicts current on writes (#1214, change journal #1267)", () => {
  it("records a new embed and drops the verdict of one that stopped reaching out", async () => {
    modules = [
      {
        id: moduleId(1),
        slug: "video",
        kind: "content",
        html: YOUTUBE,
        css: "",
        js: "",
        fields: [],
      },
      {
        id: moduleId(2),
        slug: "was-map",
        kind: "content",
        html: "<p>plain now</p>",
        css: "",
        js: "",
        fields: [],
      },
    ];
    guard(2, "gated", "functional", ["www.openstreetmap.org"]);
    // Module 3 was deleted: modules.list no longer returns it.
    guard(3, "gated", "analytics", ["www.google-analytics.com"]);
    const out = await ops.module_changes?.(makeCtx(), {
      chatBranchId: null,
      changes: [1, 2, 3].map((n) => ({
        kind: "module",
        op: n === 3 ? "delete" : "update",
        rowId: moduleId(n),
        parentId: null,
      })),
    });
    expect(out).toEqual({ flagged: 1, cleared: 2 });
    const guards = await allGuards(store.query as never);
    expect(guards.map((g) => [g.module_id, g.status, g.category_key])).toEqual([
      [moduleId(1), "gated", "marketing"],
    ]);
    // Only the changed modules were read, never the whole site.
    expect(cmsCalls).toEqual(["modules.list", "content_instances.list"]);
  });

  it("keeps the operator's ruling while the hosts are unchanged", async () => {
    modules = [
      { id: moduleId(4), slug: "w", kind: "content", html: UNKNOWN, css: "", js: "", fields: [] },
    ];
    store.seed("module_guards", {
      module_id: moduleId(4),
      category_key: "functional",
      detected_hosts: ["widgets.unknown-vendor.example"],
      status: "gated",
      decided_by: "operator",
    });
    expect(
      await ops.module_changes?.(makeCtx(), {
        chatBranchId: null,
        changes: [{ kind: "module", op: "update", rowId: moduleId(4), parentId: null }],
      }),
    ).toEqual({
      flagged: 0,
      cleared: 0,
    });
  });
});
