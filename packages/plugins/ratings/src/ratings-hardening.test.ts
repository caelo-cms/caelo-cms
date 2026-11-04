// SPDX-License-Identifier: MPL-2.0

import { describe, expect, test } from "bun:test";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import newsletterPlugin from "../../newsletter/src/index.js";
import ratingsPlugin from "./index.js";

describe("ratings & newsletter plugin input & deduplication hardening", () => {
  test("ratings.submit rejects missing or empty pageId and only ever adds a vote (#1333)", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const ctx = {
      visitor: { id: "vis-1" },
      captcha: { requireProof: async () => true },
      query: {
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
      },
    } as unknown as PluginContextTier1;

    await expect(ratingsPlugin.operations.submit(ctx, { pageId: "   ", score: 5 })).rejects.toThrow(
      "pageId",
    );

    const res = await ratingsPlugin.operations.submit(ctx, { pageId: "page-1", score: 4 });
    expect(res).toEqual({ recorded: true, id: "row-new" });
    expect(inserted).toEqual([{ page_id: "page-1", visitor_id: "vis-1", score: 4 }]);
  });

  test("ratings._refresh counts a consented visitor's newest vote and prunes the older ones", async () => {
    const insertedAggs: Array<Record<string, unknown>> = [];
    const deleted: string[] = [];
    const ctx = {
      query: {
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
      },
    } as unknown as PluginContextTier1;

    const r = await ratingsPlugin.operations._refresh(ctx, {});
    expect(insertedAggs).toEqual([{ page_id: "p1", count: 2, sum: 8, average: 400 }]);
    expect(deleted).toEqual(["ratings:a"]);
    expect(r).toMatchObject({ refreshed: 1, pruned: 1, truncated: false });
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
      query: {
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
      },
    } as unknown as PluginContextTier1;

    const subRes = await newsletterPlugin.operations.subscribe(ctx, {
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

    await expect(newsletterPlugin.operations.confirm(ctx, { token: "" })).rejects.toThrow(
      "confirm: invalid token",
    );
    await expect(newsletterPlugin.operations.unsubscribe(ctx, { token: "short" })).rejects.toThrow(
      "unsubscribe: invalid token",
    );
    // #1337 — an expired link is refused.
    await expect(
      newsletterPlugin.operations.confirm(ctx, { token: "11111111-2222-3333-4444-555555555555" }),
    ).rejects.toThrow("confirm: the link has expired");
  });
});
