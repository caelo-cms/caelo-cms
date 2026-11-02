// SPDX-License-Identifier: MPL-2.0

/** readBodyWithCap stops at the first byte over the cap and never exceeds the hard ceiling. */

import { describe, expect, it } from "bun:test";
import { HARD_MAX_BODY_BYTES, readBodyWithCap } from "./body-cap.js";

function post(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("http://service.internal/x", { method: "POST", body, headers });
}

describe("readBodyWithCap", () => {
  it("returns a body within the cap", async () => {
    const r = await readBodyWithCap(post("hello"), 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(new TextDecoder().decode(r.body)).toBe("hello");
  });

  it("refuses a declared Content-Length over the cap without reading", async () => {
    const r = await readBodyWithCap(post("x", { "content-length": "999" }), 10);
    expect(r).toEqual({ ok: false, bytes: 999, limit: 10 });
  });

  it("refuses a streamed body that grows over the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(8));
        c.enqueue(new Uint8Array(8));
        c.close();
      },
    });
    const r = await readBodyWithCap(post(stream), 10);
    expect(r.ok).toBe(false);
  });

  it("clamps a caller's cap to the hard ceiling", async () => {
    const declared = String(HARD_MAX_BODY_BYTES + 1);
    const r = await readBodyWithCap(
      post("x", { "content-length": declared }),
      HARD_MAX_BODY_BYTES * 4,
    );
    expect(r).toEqual({ ok: false, bytes: HARD_MAX_BODY_BYTES + 1, limit: HARD_MAX_BODY_BYTES });
  });
});
