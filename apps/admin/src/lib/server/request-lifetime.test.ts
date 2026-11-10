// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1361 — an admin request counts as in flight until its response is
 * sent, an event stream until its last chunk or the client's disconnect.
 */

import { describe, expect, it } from "bun:test";
import { releaseWhenSent } from "./request-lifetime.js";

function counter() {
  let releases = 0;
  return {
    release: () => {
      releases += 1;
    },
    count: () => releases,
  };
}

describe("#1361 — releaseWhenSent", () => {
  it("releases at once for a complete body, and passes the response through", () => {
    const c = counter();
    const response = Response.json({ ok: true });
    expect(releaseWhenSent(response, c.release)).toBe(response);
    expect(c.count()).toBe(1);
    const empty = new Response(null, { status: 204 });
    expect(releaseWhenSent(empty, c.release)).toBe(empty);
    expect(c.count()).toBe(2);
  });

  it("holds an event stream until its last chunk, keeping status, headers and data", async () => {
    const c = counter();
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        push = controller;
      },
    });
    const sent = releaseWhenSent(
      new Response(source, {
        status: 200,
        headers: { "content-type": "text/event-stream", "x-caelo-request-id": "r1" },
      }),
      c.release,
    );
    expect(sent.headers.get("x-caelo-request-id")).toBe("r1");
    const reader = (sent.body as ReadableStream<Uint8Array>).getReader();
    push.enqueue(new TextEncoder().encode("data: 1\n\n"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 1\n\n");
    expect(c.count()).toBe(0);
    push.close();
    expect((await reader.read()).done).toBe(true);
    expect(c.count()).toBe(1);
  });

  it("releases when the client goes away, and cancels the stream behind it", async () => {
    const c = counter();
    let cancelled: unknown = null;
    const source = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelled = reason;
      },
    });
    const sent = releaseWhenSent(
      new Response(source, { headers: { "content-type": "text/event-stream" } }),
      c.release,
    );
    await (sent.body as ReadableStream<Uint8Array>).cancel("client closed");
    expect(c.count()).toBe(1);
    expect(cancelled).toBe("client closed");
  });
});
