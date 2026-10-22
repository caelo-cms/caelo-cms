// SPDX-License-Identifier: MPL-2.0

/**
 * #741 — translation work items over the Power-MCP: delegated calls hand
 * the prompt out instead of calling ctx.ai, apply_translations writes the
 * agent's answer exactly as the install-side path writes the model's, and
 * an answer for content that changed since is refused. Runs the plugin's
 * operations against an in-memory plugin store + core fake (pure logic —
 * the store and core ops are exercised by the integration suite).
 */

import { describe, expect, it } from "bun:test";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import { applyTranslationsArgs } from "./apply-translations.js";
import plugin from "./index.js";
import { buildFullTranslationPrompt } from "./translation.js";

const SRC = "11111111-1111-4111-8111-111111111111";
const DE = "22222222-2222-4222-8222-222222222222";
const LAYOUT = "33333333-3333-4333-8333-333333333333";
const NAV_KEY = `layout:${LAYOUT}:header:0`;

type Row = Record<string, unknown> & { id: string };
interface Placement {
  blockName: string;
  position: number;
  moduleSlug: string;
  values: Record<string, unknown>;
}

/** A plugin store + the core ops the translation flow calls. */
function world() {
  let nextId = 0;
  const tables: Record<string, Row[]> = {
    locales: [
      {
        id: "l-en",
        code: "en",
        display_name: "English",
        url_strategy: "subdirectory",
        url_host: null,
        is_default: true,
      },
      {
        id: "l-de",
        code: "de",
        display_name: "German",
        url_strategy: "subdirectory",
        url_host: null,
        is_default: false,
      },
    ],
    settings: [],
    page_variants: [
      {
        id: "v-src",
        group_id: "g1",
        page_id: SRC,
        locale_code: "en",
        translation_status: "source",
      },
      {
        id: "v-de",
        group_id: "g1",
        page_id: DE,
        locale_code: "de",
        translation_status: "needs_update",
      },
    ],
    glossary: [],
    style_guides: [],
    chrome_variants: [],
  };
  const titles: Record<string, string> = { [SRC]: "Pricing", [DE]: "Pricing" };
  const meta: Record<string, string> = { [SRC]: "Fair plans for every team", [DE]: "" };
  const placements: Record<string, Placement[]> = {
    [SRC]: [
      { blockName: "main", position: 0, moduleSlug: "hero", values: { hero_title: "Hello" } },
    ],
    [DE]: [{ blockName: "main", position: 0, moduleSlug: "hero", values: { hero_title: "Hello" } }],
  };
  const nav = { nav: [{ label: "About", href: "/about" }] };
  /** Every write, in order — the equivalence check compares these. */
  const writes: unknown[] = [];

  const q = {
    insert: async (table: string, data: Record<string, unknown>) => {
      const id = `row-${nextId++}`;
      const rows = tables[table] ?? [];
      tables[table] = rows;
      rows.push({ ...data, id });
      writes.push(["insert", table, data]);
      return { id };
    },
    list: async (table: string, filter: Record<string, unknown> = {}) => {
      const { limit, orderBy: _o, orderDir: _d, ...where } = filter;
      return (tables[table] ?? [])
        .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
        .slice(0, typeof limit === "number" ? limit : undefined);
    },
    update: async (table: string, id: string, patch: Record<string, unknown>) => {
      const row = (tables[table] ?? []).find((r) => r.id === id);
      if (!row) throw new Error(`no ${table} row ${id}`);
      Object.assign(row, patch);
      writes.push(["update", table, id, patch]);
    },
    delete: async () => {
      throw new Error("not used");
    },
    compareAndSwap: async () => {
      throw new Error("not used");
    },
  };

  const cms = {
    call: async <O>(op: string, input: unknown): Promise<O> => {
      const i = input as Record<string, unknown>;
      switch (op) {
        case "pages.list":
          return {
            pages: Object.entries(titles).map(([id, title]) => ({ id, title })),
          } as O;
        case "pages_seo.get": {
          const m = meta[i.pageId as string] ?? "";
          return { seo: m ? { metaDescription: m } : null } as O;
        }
        case "page_module_content.list_for_page":
          return { placements: structuredClone(placements[i.pageId as string] ?? []) } as O;
        case "pages.list_shared_content":
          return {
            layoutPlacements: [
              {
                layoutId: LAYOUT,
                layoutSlug: "default",
                blockName: "header",
                index: 0,
                moduleName: "Main menu",
                fields: [{ name: "nav", kind: "link-list" }],
                values: structuredClone(nav),
              },
            ],
            sharedInstances: [],
          } as O;
        case "page_module_content.set":
        case "pages.update":
          writes.push([op, input]);
          return {} as O;
        case "pages_seo.apply_translation":
          writes.push([op, input]);
          return { outcome: "filled" } as O;
        // #724 D — a translated chrome variant goes through core's link
        // canonicalisation; the fake echoes the values back unchanged.
        case "links.canonicalise_values":
          return { values: (i as { values: unknown }).values } as O;
        default:
          throw new Error(`unexpected core op ${op}`);
      }
    },
  };

  let aiCalls = 0;
  const ctx = (opts: { delegated: boolean; answer?: string }) =>
    ({
      invocation: { origin: "chat", actorId: "a", aiDelegated: opts.delegated },
      adminQuery: q,
      cms,
      ai: {
        complete: async () => {
          aiCalls += 1;
          if (opts.delegated)
            throw new Error("AiDelegated: test ctx — the plugin must not call ai");
          if (opts.answer === undefined) throw new Error("test ctx has no scripted answer");
          return { text: opts.answer, inputTokens: 1, outputTokens: 1 };
        },
      },
    }) as unknown as PluginContextTier1;

  return {
    tables,
    titles,
    placements,
    nav,
    writes,
    ctx,
    aiCalls: () => aiCalls,
  };
}

const op = (name: string) => {
  const fn = (plugin.operations as Record<string, (c: unknown, a: unknown) => Promise<unknown>>)[
    name
  ];
  if (!fn) throw new Error(`no operation ${name}`);
  return fn;
};

const PAGE_ANSWER = {
  title: "Preise",
  metaDescription: "Faire Tarife für jedes Team",
  slots: [{ slot: "s0", values: { hero_title: "Hallo" } }],
};
const CHROME_ANSWER = { targets: [{ target: "c0", strings: { "nav[0].label": "Über uns" } }] };

interface WorkItemResult {
  workItem: {
    kind: string;
    task: string;
    instructions: { system: string; user: string };
    responseFormat: string;
    apply: {
      tool: string;
      args: { items: Array<Record<string, unknown>> };
      resultArg: string;
    };
  };
}

/** The apply_translations entry for a work item plus an answer. */
const answerFor = (r: WorkItemResult, result: unknown) => ({
  ...r.workItem.apply.args.items[0],
  result,
});

describe("delegated translate_variant", () => {
  it("returns the exact prompt as a work item and never touches ctx.ai or writes", async () => {
    const w = world();
    const r = (await op("translate_variant")(w.ctx({ delegated: true }), {
      variantPageId: DE,
    })) as WorkItemResult;
    expect(w.aiCalls()).toBe(0);
    expect(w.writes).toEqual([]);
    expect(r.workItem.kind).toBe("ai_work_item");
    expect(r.workItem.responseFormat).toBe("json");
    expect(r.workItem.task).toContain("German");
    expect(r.workItem.instructions).toEqual(
      buildFullTranslationPrompt({
        sourceLocale: "en",
        targetLocale: "de",
        targetLocaleDisplayName: "German",
        sourceTitle: "Pricing",
        sourceMetaDescription: "Fair plans for every team",
        sourceSlots: w.placements[SRC] as Placement[],
        glossary: [],
        styleGuide: null,
      }),
    );
    expect(r.workItem.apply.tool).toBe("apply_translations");
    expect(r.workItem.apply.resultArg).toBe("items[0].result");
    const item = r.workItem.apply.args.items[0];
    expect(item).toMatchObject({ kind: "page", variantPageId: DE, mode: "full" });
    expect(item?.basis).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("applying the agent's answer writes exactly what the install-side pass writes", async () => {
    const delegated = world();
    const r = (await op("translate_variant")(delegated.ctx({ delegated: true }), {
      variantPageId: DE,
    })) as WorkItemResult;
    const applied = (await op("apply_translations")(delegated.ctx({ delegated: true }), {
      items: [answerFor(r, JSON.stringify(PAGE_ANSWER))],
    })) as { applied: number; failed: number; results: Array<Record<string, unknown>> };
    expect(delegated.aiCalls()).toBe(0);
    expect(applied.applied).toBe(1);
    expect(applied.results[0]).toMatchObject({
      kind: "page",
      status: "applied",
      mode: "full",
      slotsApplied: 1,
      titleApplied: true,
      seo: "filled",
    });

    const install = world();
    const direct = await op("translate_variant")(
      install.ctx({
        delegated: false,
        answer: `\`\`\`json\n${JSON.stringify(PAGE_ANSWER)}\n\`\`\``,
      }),
      { variantPageId: DE },
    );
    expect(install.aiCalls()).toBe(1);
    expect(direct).toEqual({ mode: "full", slotsApplied: 1, titleApplied: true, seo: "filled" });
    expect(delegated.writes).toEqual(install.writes);
    expect(delegated.tables.page_variants?.find((v) => v.id === "v-de")?.translation_status).toBe(
      "up_to_date",
    );
  });

  it("refuses an answer once the page changed since the work item, writing nothing", async () => {
    const w = world();
    const r = (await op("translate_variant")(w.ctx({ delegated: true }), {
      variantPageId: DE,
    })) as WorkItemResult;
    (w.placements[SRC] as Placement[])[0] = {
      blockName: "main",
      position: 0,
      moduleSlug: "hero",
      values: { hero_title: "Hello again" },
    };
    await expect(
      op("apply_translations")(w.ctx({ delegated: true }), {
        items: [answerFor(r, PAGE_ANSWER)],
      }),
    ).rejects.toThrow(/changed since the work item was issued — call translate_variant/);
    expect(w.writes).toEqual([]);
  });

  it("refuses a pass with a different mode than the work item was issued for", async () => {
    const w = world();
    const r = (await op("translate_variant")(w.ctx({ delegated: true }), {
      variantPageId: DE,
    })) as WorkItemResult;
    await expect(
      op("apply_translations")(w.ctx({ delegated: true }), {
        items: [{ ...answerFor(r, PAGE_ANSWER), mode: "update" }],
      }),
    ).rejects.toThrow(/changed since/);
  });
});

describe("apply_translations validation", () => {
  it("rejects malformed input at the boundary", () => {
    expect(applyTranslationsArgs.safeParse({ items: [] }).success).toBe(false);
    expect(
      applyTranslationsArgs.safeParse({
        items: [{ kind: "page", variantPageId: DE, mode: "auto", basis: "x", result: "{}" }],
      }).success,
    ).toBe(false);
    expect(
      applyTranslationsArgs.safeParse({
        items: [{ kind: "chrome", localeCode: "de", basis: `sha256:${"a".repeat(64)}` }],
      }).success,
    ).toBe(false);
    expect(
      applyTranslationsArgs.safeParse({
        items: [
          { kind: "chrome", localeCode: "de", basis: `sha256:${"a".repeat(64)}`, result: {} },
        ],
      }).success,
    ).toBe(true);
  });

  it("names the problem when the input is invalid", async () => {
    const w = world();
    await expect(
      op("apply_translations")(w.ctx({ delegated: true }), { items: [{ kind: "page" }] }),
    ).rejects.toThrow(/apply_translations input is invalid: .*apply\.args\.items\[0\]/);
  });

  it("refuses the whole batch when one item breaks its contract — nothing half-applies", async () => {
    const w = world();
    const page = (await op("translate_variant")(w.ctx({ delegated: true }), {
      variantPageId: DE,
    })) as WorkItemResult;
    const chrome = (await op("translate_chrome")(w.ctx({ delegated: true }), {
      localeCode: "de",
    })) as WorkItemResult;
    const err = await op("apply_translations")(w.ctx({ delegated: true }), {
      items: [
        answerFor(chrome, CHROME_ANSWER),
        answerFor(page, { ...PAGE_ANSWER, slots: [{ slot: "hero", values: { hero_title: "x" } }] }),
      ],
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /nothing was written.*items\[1\] \(page .*structural lock/,
    );
    expect(w.writes).toEqual([]);
  });

  it("refuses two answers to the same work item", async () => {
    const w = world();
    const r = (await op("translate_variant")(w.ctx({ delegated: true }), {
      variantPageId: DE,
    })) as WorkItemResult;
    await expect(
      op("apply_translations")(w.ctx({ delegated: true }), {
        items: [answerFor(r, PAGE_ANSWER), answerFor(r, PAGE_ANSWER)],
      }),
    ).rejects.toThrow(/duplicates items\[0\]/);
  });

  it("reports an unparseable answer with the next step", async () => {
    const w = world();
    const r = (await op("translate_variant")(w.ctx({ delegated: true }), {
      variantPageId: DE,
    })) as WorkItemResult;
    await expect(
      op("apply_translations")(w.ctx({ delegated: true }), {
        items: [answerFor(r, "Sure! Here is the translation")],
      }),
    ).rejects.toThrow(/did not match the contract.*Fix your answer/);
  });
});

describe("delegated chrome", () => {
  it("translate_chrome hands out one work item and apply writes the variant", async () => {
    const w = world();
    const r = (await op("translate_chrome")(w.ctx({ delegated: true }), {
      localeCode: "de",
    })) as WorkItemResult & { offered: number };
    expect(w.aiCalls()).toBe(0);
    expect(r.offered).toBe(1);
    expect(r.workItem.apply.args.items[0]).toMatchObject({ kind: "chrome", localeCode: "de" });
    expect(r.workItem.instructions.user).toContain("nav[0].label");

    const out = (await op("apply_translations")(w.ctx({ delegated: true }), {
      items: [answerFor(r, CHROME_ANSWER)],
    })) as { results: unknown[] };
    expect(out.results).toEqual([
      { kind: "chrome", localeCode: "de", status: "applied", translated: 1 },
    ]);
    const row = w.tables.chrome_variants?.[0];
    expect(row).toMatchObject({
      target_key: NAV_KEY,
      locale_code: "de",
      mode: "translated",
      module_id: null,
      translation_status: "up_to_date",
      values: { nav: [{ label: "Über uns", href: "/about" }] },
    });

    // Up to date now: nothing to hand out.
    const again = (await op("translate_chrome")(w.ctx({ delegated: true }), {
      localeCode: "de",
    })) as Record<string, unknown>;
    expect(again.workItem).toBeUndefined();
    expect(again.translated).toBe(0);
    expect(again.upToDate).toBe(1);
  });

  it("refuses a chrome answer after the glossary changed", async () => {
    const w = world();
    const r = (await op("translate_chrome")(w.ctx({ delegated: true }), {
      localeCode: "de",
    })) as WorkItemResult;
    w.tables.glossary?.push({
      id: "g",
      term: "About",
      locale_code: "de",
      translation: "Über",
      context: null,
    });
    await expect(
      op("apply_translations")(w.ctx({ delegated: true }), {
        items: [answerFor(r, CHROME_ANSWER)],
      }),
    ).rejects.toThrow(/changed since the work item was issued — call translate_chrome/);
    expect(w.tables.chrome_variants).toEqual([]);
  });

  it("the install-side translate_chrome still runs on the install's AI", async () => {
    const w = world();
    const r = await op("translate_chrome")(
      w.ctx({ delegated: false, answer: JSON.stringify(CHROME_ANSWER) }),
      { localeCode: "de" },
    );
    expect(w.aiCalls()).toBe(1);
    expect(r).toEqual({ translated: 1, upToDate: 0, skippedIndependent: 0, nothingToTranslate: 0 });
  });

  it("delegated reattach flips the entry without translating; translate_chrome then offers it", async () => {
    const w = world();
    w.tables.chrome_variants?.push({
      id: "cv",
      target_key: NAV_KEY,
      locale_code: "de",
      mode: "independent",
      module_id: "44444444-4444-4444-8444-444444444444",
      values: { nav: [{ label: "Firma", href: "/about" }] },
      translation_status: "up_to_date",
      source_hash: null,
    });
    const r = (await op("reattach_chrome_variant")(w.ctx({ delegated: true }), {
      targetKey: NAV_KEY,
      localeCode: "de",
    })) as Record<string, unknown>;
    expect(w.aiCalls()).toBe(0);
    expect(r).toMatchObject({ reattached: true, translated: 0 });
    expect(r.nextStep).toContain('translate_chrome({ localeCode: "de" })');
    // The language keeps its own module + content until the answer lands.
    expect(w.tables.chrome_variants?.[0]).toMatchObject({
      mode: "translated",
      translation_status: "needs_update",
      module_id: "44444444-4444-4444-8444-444444444444",
    });

    const item = (await op("translate_chrome")(w.ctx({ delegated: true }), {
      localeCode: "de",
    })) as WorkItemResult;
    await op("apply_translations")(w.ctx({ delegated: true }), {
      items: [answerFor(item, CHROME_ANSWER)],
    });
    expect(w.tables.chrome_variants?.[0]).toMatchObject({
      mode: "translated",
      translation_status: "up_to_date",
      module_id: null,
      values: { nav: [{ label: "Über uns", href: "/about" }] },
    });
  });
});

describe("delegated translate_all_stale", () => {
  it("returns every stale page and every language's chrome as independent work items", async () => {
    const w = world();
    const r = (await op("translate_all_stale")(w.ctx({ delegated: true }), {})) as {
      workItems: WorkItemResult["workItem"][];
      pages: number;
      chromeLocales: number;
      failed: unknown[];
    };
    expect(w.aiCalls()).toBe(0);
    expect(w.writes).toEqual([]);
    expect(r.pages).toBe(1);
    expect(r.chromeLocales).toBe(1);
    expect(r.failed).toEqual([]);
    expect(r.workItems.map((i) => i.apply.args.items[0]?.kind)).toEqual(["page", "chrome"]);

    const answers = [PAGE_ANSWER, CHROME_ANSWER];
    const out = (await op("apply_translations")(w.ctx({ delegated: true }), {
      items: r.workItems.map((i, n) => ({ ...i.apply.args.items[0], result: answers[n] })),
    })) as { applied: number; failed: number };
    expect(out).toMatchObject({ applied: 2, failed: 0 });
  });
});
