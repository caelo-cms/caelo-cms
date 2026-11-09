// SPDX-License-Identifier: MPL-2.0

/**
 * #847 — `submit` judges the honeypot server-side under the kit's field
 * name: a bot that POSTs directly gets the same answer as a real visitor
 * and nothing reaches the moderation inbox.
 *
 * #1511 — the visitor contract stores what it accepts: an over-long name or
 * comment, or a page that is no page id, is refused at the contract instead
 * of being cut or stored where moderation can never archive it. Moderation
 * input is validated too, and a bulk decision says which comments failed.
 */

import { describe, expect, it } from "bun:test";
import { HONEYPOT_FIELD_NAME } from "@caelo-cms/plugin-component-kit";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";

const PAGE = "11111111-1111-4111-8111-111111111111";

function harness() {
  const state = { inserts: [] as Record<string, unknown>[], captchaCalls: 0 };
  const ctx = {
    invocation: { origin: "visitor", actorId: "v" },
    captcha: {
      requireProof: async () => {
        state.captchaCalls += 1;
        return true;
      },
    },
    query: {
      list: async () => [],
      insert: async (_table: string, row: Record<string, unknown>) => {
        state.inserts.push(row);
        return { id: "c1" };
      },
    },
  } as unknown as PluginContextTier1;
  return { ctx, state };
}

const submit = (ctx: PluginContextTier1, args: unknown) => {
  const op = plugin.operations.submit;
  if (!op) throw new Error("submit missing");
  return op(ctx, args);
};

/** The declared visitor contract the host parses with before `submit` runs. */
const contract = () => {
  const input = plugin.publicOperations?.find((o) => o.name === "submit")?.input;
  if (!input) throw new Error("submit contract missing");
  return input;
};

const COMMENT = { pageId: PAGE, authorName: "Ann", content: "Nice post" };

describe("comments submit honeypot", () => {
  it("fakes success for a filled honeypot without inserting", async () => {
    const h = harness();
    const r = await submit(h.ctx, { ...COMMENT, [HONEYPOT_FIELD_NAME]: "bot was here" });
    expect(r).toEqual({ commentId: "00000000-0000-0000-0000-000000000000", status: "pending" });
    expect(h.state.inserts).toHaveLength(0);
  });

  it("accepts an empty honeypot and stores the comment pending", async () => {
    const h = harness();
    const r = await submit(h.ctx, { ...COMMENT, [HONEYPOT_FIELD_NAME]: "" });
    expect(r).toEqual({ commentId: "c1", status: "pending" });
    expect(h.state.inserts).toHaveLength(1);
    // #1332 — the captcha is the host's: dispatch refuses a visitor call
    // without a proof bound to comments.submit before this handler runs.
    expect(h.state.captchaCalls).toBe(0);
    expect(plugin.publicOperations?.find((o) => o.name === "submit")?.captcha).not.toBe("none");
  });
});

describe("the submit contract (#1511)", () => {
  it("refuses what it would otherwise have cut or could never archive", () => {
    for (const bad of [
      { ...COMMENT, authorName: "x".repeat(81) },
      { ...COMMENT, content: "x".repeat(4001) },
      { ...COMMENT, pageId: "not-a-page" },
      { ...COMMENT, pageId: "../../etc" },
      { ...COMMENT, parentId: "<script>" },
      { ...COMMENT, captchaToken: "x" },
      { ...COMMENT, extra: true },
    ]) {
      expect(contract().safeParse(bad).success).toBe(false);
    }
    expect(contract().safeParse({ ...COMMENT, content: "x".repeat(4000) }).success).toBe(true);
  });

  it("stores the text as written, trimmed, never shortened", async () => {
    const h = harness();
    await submit(h.ctx, { ...COMMENT, authorName: "  Ann  ", content: ` ${"y".repeat(3998)} ` });
    expect(h.state.inserts[0]).toMatchObject({ author_name: "Ann", content: "y".repeat(3998) });
  });

  it("refuses an empty name or comment as a visitor refusal", async () => {
    const h = harness();
    await expect(submit(h.ctx, { ...COMMENT, content: "   " })).rejects.toThrow(/content empty/);
    await expect(submit(h.ctx, { ...COMMENT, authorName: " " })).rejects.toThrow(/authorName/);
    expect(h.state.inserts).toHaveLength(0);
  });
});

describe("moderation input (#1511)", () => {
  it("refuses a decision that is not one of the three, and a malformed id", async () => {
    const moderate = plugin.operations.moderate;
    if (!moderate) throw new Error("moderate missing");
    const ctx = { cms: { call: async () => ({}) }, query: { list: async () => [] } };
    await expect(
      moderate(ctx as unknown as PluginContextTier1, { commentId: PAGE, decision: "publish" }),
    ).rejects.toThrow();
    await expect(
      moderate(ctx as unknown as PluginContextTier1, { commentId: "1; drop", decision: "spam" }),
    ).rejects.toThrow();
  });

  it("decides a batch, names each comment that failed, and marks only approved pages", async () => {
    const ok = "22222222-2222-4222-8222-222222222222";
    const broken = "33333333-3333-4333-8333-333333333333";
    const deleted: string[] = [];
    const ctx = {
      cms: {
        call: async (_op: string, input: { publicRowId: string }) => {
          if (input.publicRowId === broken) throw new Error("archive refused");
          return { archiveId: "a" };
        },
      },
      query: {
        list: async (_t: string, f: { id: string }) => [
          {
            id: f.id,
            page_id: PAGE,
            parent_id: "",
            author_name: "A",
            content: "c",
            status: "pending",
            submitted_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        delete: async (_t: string, id: string) => {
          deleted.push(id);
        },
      },
    } as unknown as PluginContextTier1;
    const bulk = plugin.operations.bulk_moderate;
    if (!bulk) throw new Error("bulk_moderate missing");
    const r = (await bulk(ctx, { commentIds: [ok, broken, ok], decision: "approved" })) as {
      updated: number;
      failed: { commentId: string; error: string }[];
      pageIds: string[];
    };
    expect(r.updated).toBe(1);
    expect(r.failed).toEqual([{ commentId: broken, error: "archive refused" }]);
    expect(r.pageIds).toEqual([PAGE]);
    expect(deleted).toEqual([ok]);
    await expect(bulk(ctx, { commentIds: [], decision: "spam" })).rejects.toThrow();
  });
});

describe("what the Owner approves (#1511)", () => {
  it("declares the site-wide runtime and the skill it ships", () => {
    expect(plugin.requestedCapabilities).toEqual(
      expect.arrayContaining(["client_assets", "companion_skills"]),
    );
    expect(plugin.skills?.map((s) => s.slug)).toEqual(["comments-setup"]);
  });

  it("lets a Reviewer moderate: the panel needs plugins.approve, not settings", () => {
    expect(plugin.adminPanels?.[0]?.permission).toBe("plugins.approve");
  });

  it("offers a bulk moderation tool next to the single one", () => {
    const tools = plugin.tools?.map((t) => t.name) ?? [];
    expect(tools).toContain("bulk_moderate_comments");
    const single = plugin.tools?.find((t) => t.name === "moderate_comment");
    expect(single?.description).toContain("bulk_moderate_comments");
    for (const allowed of plugin.skills?.[0]?.allowlistedTools ?? []) {
      if (allowed.includes("comment")) expect(tools).toContain(allowed);
    }
  });

  it("no longer declares the Web Component nothing mounted (#455)", () => {
    expect(plugin.component).toBeUndefined();
  });
});
