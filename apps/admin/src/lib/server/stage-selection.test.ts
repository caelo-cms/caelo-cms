// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { pickStageSelection, readStageSelection } from "./stage-selection.js";

function form(fields: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of fields) f.append(k, v);
  return f;
}

const STAGEABLE = new Set(["a", "b", "c"]);
const CTX = { actorId: "x", actorKind: "human" as const, requestId: "t" };

describe("Stage form selection", () => {
  it("Stage now takes the one conversation, whatever else is ticked", () => {
    expect(
      pickStageSelection(
        form([
          ["only", "b"],
          ["chatSessionId", "a"],
        ]),
        STAGEABLE,
      ),
    ).toEqual({
      ok: true,
      chatSessionIds: ["b"],
    });
  });

  it("Stage all takes every conversation with draft changes", () => {
    expect(pickStageSelection(form([["all", "1"]]), STAGEABLE)).toEqual({
      ok: true,
      chatSessionIds: ["a", "b", "c"],
    });
  });

  it("Stage selected takes the ticked ones and refuses an empty or stale selection", () => {
    expect(
      pickStageSelection(
        form([
          ["chatSessionId", "a"],
          ["chatSessionId", "c"],
        ]),
        STAGEABLE,
      ),
    ).toEqual({ ok: true, chatSessionIds: ["a", "c"] });
    expect(pickStageSelection(form([]), STAGEABLE)).toMatchObject({ ok: false, status: 400 });
    expect(pickStageSelection(form([["chatSessionId", "gone"]]), STAGEABLE)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Reload the page"),
    });
  });

  it("Stage again rebuilds for the chat on screen without draft changes (Codex #1643 P1)", async () => {
    // Answered before any list is read: a chat with nothing in draft is
    // exactly what Stage again is for (#835).
    expect(
      await readStageSelection(
        CTX,
        form([
          ["restage", "1"],
          ["chatSessionId", "quiet"],
        ]),
      ),
    ).toEqual({
      ok: true,
      chatSessionIds: ["quiet"],
    });
    expect(await readStageSelection(CTX, form([["restage", "1"]]))).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});
