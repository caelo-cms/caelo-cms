// SPDX-License-Identifier: MPL-2.0

/**
 * #1155 — visitor op events are untrusted hints. Forged, malformed or
 * undeclared rows mark nothing; the watermark cannot be pinned or pushed
 * past real events.
 */

import { describe, expect, it } from "bun:test";
import { advanceVisitorWatermark, hintsFromEvents } from "./visitor-hints.js";

const PLUGIN = "11111111-1111-4111-8111-111111111111";
const OTHER_PLUGIN = "22222222-2222-4222-8222-222222222222";
const PAGE = "33333333-3333-4333-8333-333333333333";

/** Only `guestbook.vote` of PLUGIN is a declared visitor trigger. */
const trigger = (pluginId: string, op: string) =>
  pluginId === PLUGIN && op === "vote" ? { slug: "guestbook" } : null;

const event = (over: Record<string, unknown>) => ({
  id: "1",
  plugin_id: PLUGIN,
  operation: "guestbook.vote",
  succeeded: true,
  page_id: PAGE,
  ...over,
});

describe("hintsFromEvents", () => {
  it("a declared visitor trigger of a running plugin marks its page", () => {
    const { byPlugin, dropped } = hintsFromEvents([event({})], trigger);
    expect([...(byPlugin.get(PLUGIN) ?? [])]).toEqual([PAGE]);
    expect(dropped).toEqual([]);
  });

  it("forged or undeclared events mark nothing", () => {
    const { byPlugin, dropped } = hintsFromEvents(
      [
        // an operation the plugin does not declare as a trigger
        event({ id: "2", operation: "guestbook.submit" }),
        // the declared op under another plugin's id
        event({ id: "3", plugin_id: OTHER_PLUGIN }),
        // the plugin's id with another plugin's slug
        event({ id: "4", operation: "comments.vote" }),
        // malformed rows
        event({ id: "5", page_id: "not-a-uuid" }),
        event({ id: "6", operation: "DROP TABLE pages" }),
        event({ id: "7", plugin_id: 42 }),
        "garbage",
      ],
      trigger,
    );
    expect(byPlugin.size).toBe(0);
    expect(dropped.map((d) => d.id)).toEqual(["2", "3", "4", "5", "6", "7", null]);
  });

  it("events without a page or that failed are not hints and not reported", () => {
    const { byPlugin, dropped } = hintsFromEvents(
      [event({ page_id: null }), event({ id: "2", succeeded: false })],
      trigger,
    );
    expect(byPlugin.size).toBe(0);
    expect(dropped).toEqual([]);
  });
});

describe("advanceVisitorWatermark", () => {
  const row = (id: string, settled = false) => ({ id, settled });

  it("moves through contiguous ids and stops at an unsettled gap", () => {
    const r = advanceVisitorWatermark([row("1"), row("2"), row("4")], "0", "4");
    expect(r.watermark).toBe("2");
    expect(r.covered).toHaveLength(2);
  });

  it("passes a gap once the row after it is settled", () => {
    expect(advanceVisitorWatermark([row("1"), row("4", true)], "0", "4").watermark).toBe("4");
  });

  it("never passes the sequence's last value (a forged id)", () => {
    const r = advanceVisitorWatermark([row("1"), row("9000000000", true)], "0", "1");
    expect(r.watermark).toBe("1");
  });

  it("covers malformed rows inside the run so they cannot pin it", () => {
    const r = advanceVisitorWatermark([{ id: "1", settled: false, junk: true }], "0", "1");
    expect(r.watermark).toBe("1");
  });
});
