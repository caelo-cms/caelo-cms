// SPDX-License-Identifier: MPL-2.0

import { describe, expect, test } from "bun:test";
import { refusePublicCall, runDeclaredPublicOperation } from "@caelo-cms/plugin-host";
import {
  indexCheckedQuery,
  type PluginContextTier1,
  type PublicOperationDef,
  publicOperationOf,
} from "@caelo-cms/plugin-sdk";
import newsletterPlugin from "../../newsletter/src/index.js";
import ratingsPlugin from "./index.js";

/**
 * #1340 — a visitor call as the host makes it: the declared input schema
 * first, then the operation's declaration (core code; no plugin handler).
 */
async function asVisitor(
  plugin: { publicOperations?: ReadonlyArray<PublicOperationDef> },
  name: string,
  ctx: PluginContextTier1,
  args: unknown,
): Promise<unknown> {
  const op = publicOperationOf(plugin.publicOperations, name);
  if (!op) throw new Error(`${name} missing`);
  const checked = refusePublicCall(op, { enforced: false, proofVerified: false }, args);
  if (!checked.ok) throw new Error(`${checked.error.kind}: ${checked.error.message}`);
  return runDeclaredPublicOperation(op, ctx, checked.args);
}

describe("ratings & newsletter plugin input & deduplication hardening", () => {
  test("ratings.submit rejects missing or empty pageId and only ever adds a vote (#1333)", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const ctx = {
      visitor: { id: "vis-1" },
      captcha: { requireProof: async () => true },
      query: indexCheckedQuery(ratingsPlugin, "schema", {
        list: async () => {
          throw new Error("submit must not read: votes are an inbox");
        },
        update: async () => {
          throw new Error("submit must not update a vote");
        },
        delete: async () => {
          throw new Error("submit must not delete a vote");
        },
        insert: async (_t: string, row: Record<string, unknown>) => {
          inserted.push(row);
          return { id: "row-new" };
        },
      }),
    } as unknown as PluginContextTier1;

    await expect(
      asVisitor(ratingsPlugin, "submit", ctx, { pageId: "   ", score: 5 }),
    ).rejects.toThrow(/InvalidInput: [\s\S]*pageId/);

    const res = await asVisitor(ratingsPlugin, "submit", ctx, { pageId: "page-1", score: 4 });
    expect(res).toEqual({ recorded: true, id: "row-new" });
    expect(inserted).toEqual([{ page_id: "page-1", visitor_id: "vis-1", score: 4 }]);
  });

  test("ratings._refresh counts a consented visitor's newest vote and prunes the older ones", async () => {
    const insertedAggs: Array<Record<string, unknown>> = [];
    const deleted: string[] = [];
    const ctx = {
      query: indexCheckedQuery(ratingsPlugin, "schema", {
        list: async (table: string) => {
          if (table === "ratings") {
            return [
              {
                id: "a",
                page_id: "p1",
                visitor_id: "v1",
                score: 1,
                created_at: "2026-11-01T10:00:00Z",
              },
              {
                id: "b",
                page_id: "p1",
                visitor_id: "v1",
                score: 5,
                created_at: "2026-11-01T11:00:00Z",
              },
              {
                id: "c",
                page_id: "p1",
                visitor_id: null,
                score: 3,
                created_at: "2026-11-01T09:00:00Z",
              },
            ];
          }
          return [];
        },
        insert: async (_t: string, row: Record<string, unknown>) => {
          insertedAggs.push(row);
          return { id: "agg-1" };
        },
        update: async () => {},
        delete: async (table: string, id: string) => {
          deleted.push(`${table}:${id}`);
        },
      }),
      imports: { rows: async () => [] },
    } as unknown as PluginContextTier1;

    const r = await ratingsPlugin.operations._refresh(ctx, {});
    expect(insertedAggs).toEqual([{ page_id: "p1", count: 2, sum: 8, average: 400 }]);
    expect(deleted).toEqual(["ratings:a"]);
    expect(r).toEqual({ refreshed: 1, pruned: 1 });
  });

  test("ratings._refresh adds imported totals to the votes (data imports)", async () => {
    const insertedAggs: Array<Record<string, unknown>> = [];
    const ctx = {
      query: indexCheckedQuery(ratingsPlugin, "schema", {
        list: async (table: string) =>
          table === "ratings"
            ? [
                {
                  id: "a",
                  page_id: "p1",
                  visitor_id: null,
                  score: 5,
                  created_at: "2026-11-01T10:00:00Z",
                },
              ]
            : [],
        insert: async (_t: string, row: Record<string, unknown>) => {
          insertedAggs.push(row);
          return { id: "agg" };
        },
        update: async () => {},
        delete: async () => {},
      }),
      imports: {
        rows: async (kind: string) =>
          kind === "rating_totals"
            ? [
                {
                  rowId: "r1",
                  sourceKey: "wp:1",
                  parentRowId: null,
                  pageId: "p1",
                  values: { votes: 9, starSum: 36 },
                },
                {
                  rowId: "r2",
                  sourceKey: "wp:2",
                  parentRowId: null,
                  pageId: "p2",
                  values: { votes: 2, starSum: 10 },
                },
              ]
            : [],
      },
    } as unknown as PluginContextTier1;
    await ratingsPlugin.operations._refresh(ctx, {});
    expect(insertedAggs).toEqual([
      { page_id: "p1", count: 10, sum: 41, average: 410 },
      { page_id: "p2", count: 2, sum: 10, average: 500 },
    ]);
  });

  test("check_rating_totals refuses a star sum no 1-5 votes can make", async () => {
    const row = (votes: number, starSum: number) => ({
      rowId: `11111111-1111-4111-8111-11111111111${votes}`,
      sourceKey: `k${votes}`,
      parentRowId: null,
      pageId: null,
      values: { page: "/x", votes, starSum },
      update: false,
    });
    const r = (await ratingsPlugin.operations.check_rating_totals({} as PluginContextTier1, {
      importId: "00000000-0000-0000-0000-000000000000",
      rows: [row(2, 10), row(3, 2), row(4, 21)],
    })) as { refused: { rowId: string }[] };
    expect(r.refused.map((x) => x.rowId)).toEqual([
      "11111111-1111-4111-8111-111111111113",
      "11111111-1111-4111-8111-111111111114",
    ]);
  });

  test("the recompute runs once per public database (#1333)", () => {
    const w = ratingsPlugin.workers?.find((x) => x.name === "refresh_aggregates");
    expect(w?.publicDatabases).toBe("each");
    expect(ratingsPlugin.tableKinds).toEqual({ ratings: "inbox", rating_aggregates: "published" });
  });

  test("newsletter.subscribe queues a fresh confirmation for an unconfirmed subscriber; confirm/unsubscribe validate the token", async () => {
    const queued: Array<{ template: string; to: string; token?: string }> = [];
    const updates: Array<Record<string, unknown>> = [];
    const ctx = {
      captcha: { requireProof: async () => true },
      email: {
        send: async () => {
          throw new Error("a visitor call queues, never sends");
        },
        queue: async (m: { template: string; to: string; token?: string }) => {
          queued.push(m);
        },
      },
      query: indexCheckedQuery(newsletterPlugin, "schema", {
        list: async () => [
          {
            id: "sub-1",
            confirmed_at: null,
            confirm_token: "11111111-2222-3333-4444-555555555555",
            confirm_expires_at: "2000-01-01T00:00:00Z",
          },
        ],
        insert: async () => ({ id: "sub-new" }),
        update: async (_t: string, _id: string, patch: Record<string, unknown>) => {
          updates.push(patch);
        },
      }),
    } as unknown as PluginContextTier1;

    const subRes = await asVisitor(newsletterPlugin, "subscribe", ctx, {
      email: "reader@example.com",
    });
    expect(subRes).toEqual({ awaitingConfirm: true });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.template).toBe("confirm_subscription");
    expect(queued[0]?.to).toBe("reader@example.com");
    // A new token replaces the old one, with a new expiry.
    expect(queued[0]?.token).not.toBe("11111111-2222-3333-4444-555555555555");
    expect(updates[0]?.confirm_token).toBe(queued[0]?.token);
    expect(typeof updates[0]?.confirm_expires_at).toBe("string");

    // The declared input refuses both before the block runs.
    await expect(asVisitor(newsletterPlugin, "confirm", ctx, { token: "" })).rejects.toThrow(
      "InvalidInput",
    );
    await expect(
      asVisitor(newsletterPlugin, "unsubscribe", ctx, { token: "short" }),
    ).rejects.toThrow("InvalidInput");
    // #1337 — a still valid link is mailed again unchanged, never voided.
    const validQueued: Array<{ token?: string }> = [];
    const validCtx = {
      captcha: { requireProof: async () => true },
      email: {
        queue: async (m: { token?: string }) => {
          validQueued.push(m);
        },
      },
      query: indexCheckedQuery(newsletterPlugin, "schema", {
        list: async () => [
          {
            id: "sub-2",
            confirmed_at: null,
            confirm_token: "99999999-2222-3333-4444-555555555555",
            confirm_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
        update: async () => {
          throw new Error("a valid link must not be replaced");
        },
      }),
    } as unknown as PluginContextTier1;
    await asVisitor(newsletterPlugin, "subscribe", validCtx, { email: "again@example.com" });
    expect(validQueued[0]?.token).toBe("99999999-2222-3333-4444-555555555555");
    // #1337 — an expired link is refused.
    await expect(
      asVisitor(newsletterPlugin, "confirm", ctx, {
        token: "11111111-2222-3333-4444-555555555555",
      }),
    ).rejects.toThrow("confirm: the link has expired");
  });
});
