// SPDX-License-Identifier: MPL-2.0

import { describe, expect, test } from "bun:test";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import newsletterPlugin from "../../newsletter/src/index.js";
import ratingsPlugin from "./index.js";

describe("ratings & newsletter plugin input & deduplication hardening", () => {
  test("ratings.submit rejects missing or empty pageId and cleans up duplicate visitor rows", async () => {
    const deletedIds: string[] = [];
    const updatedIds: string[] = [];
    const ctx = {
      visitor: { id: "vis-1" },
      captcha: { requireProof: async () => true },
      query: {
        list: async () => [{ id: "row-1" }, { id: "row-2" }],
        update: async (_t: string, id: string) => {
          updatedIds.push(id);
        },
        delete: async (_t: string, id: string) => {
          deletedIds.push(id);
        },
        insert: async () => ({ id: "row-new" }),
      },
    } as unknown as PluginContextTier1;

    await expect(ratingsPlugin.operations.submit(ctx, { pageId: "   ", score: 5 })).rejects.toThrow(
      "pageId",
    );

    const res = await ratingsPlugin.operations.submit(ctx, { pageId: "page-1", score: 4 });
    expect(res).toEqual({ recorded: true, id: "row-1", mode: "updated" });
    expect(updatedIds).toEqual(["row-1"]);
    expect(deletedIds).toEqual(["row-2"]);
  });

  test("ratings._refresh deduplicates concurrent votes from the same consented visitor", async () => {
    const insertedAggs: Array<Record<string, unknown>> = [];
    const ctx = {
      query: {
        list: async (table: string) => {
          if (table === "ratings") {
            return [
              { page_id: "p1", visitor_id: "v1", score: 5 },
              { page_id: "p1", visitor_id: "v1", score: 5 }, // duplicate concurrent row
              { page_id: "p1", visitor_id: null, score: 3 }, // anonymous vote (kept)
            ];
          }
          return [];
        },
        insert: async (_t: string, row: Record<string, unknown>) => {
          insertedAggs.push(row);
          return { id: "agg-1" };
        },
        update: async () => {},
        delete: async () => {},
      },
    } as unknown as PluginContextTier1;

    await ratingsPlugin.operations._refresh(ctx, {});
    expect(insertedAggs).toEqual([
      {
        page_id: "p1",
        count: 2,
        sum: 8,
        average: 400,
      },
    ]);
  });

  test("newsletter.subscribe resends confirmation email for unconfirmed subscriber and confirm/unsubscribe validate token", async () => {
    const sentEmails: Array<{ to: string; html: string }> = [];
    const ctx = {
      captcha: { requireProof: async () => true },
      email: {
        send: async (msg: { to: string; html: string }) => {
          sentEmails.push(msg);
        },
      },
      query: {
        list: async () => [
          {
            id: "sub-1",
            confirmed_at: null,
            confirm_token: "11111111-2222-3333-4444-555555555555",
          },
        ],
        insert: async () => ({ id: "sub-new" }),
        update: async () => {},
      },
    } as unknown as PluginContextTier1;

    const subRes = await newsletterPlugin.operations.subscribe(ctx, {
      email: "reader@example.com",
    });
    expect(subRes).toEqual({ id: "sub-1", awaitingConfirm: true });
    expect(sentEmails.length).toBe(1);
    expect(sentEmails[0]?.html).toContain("11111111-2222-3333-4444-555555555555");

    await expect(newsletterPlugin.operations.confirm(ctx, { token: "" })).rejects.toThrow(
      "confirm: invalid token",
    );
    await expect(newsletterPlugin.operations.unsubscribe(ctx, { token: "short" })).rejects.toThrow(
      "unsubscribe: invalid token",
    );
  });
});
