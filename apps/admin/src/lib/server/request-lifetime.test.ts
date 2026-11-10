// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1361 — an admin request counts as in flight until its response
 * body is sent, or the client went away.
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

/** A body the test feeds chunk by chunk. */
function pushed(): {
  source: ReadableStream<Uint8Array>;
  push: (text: string) => void;
  end: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    source,
    push: (text) => controller.enqueue(new TextEncoder().encode(text)),
    end: () => controller.close(),
  };
}

describe("#1361 — releaseWhenSent", () => {
  it("releases at once when there is no body to wait for: none, or a page with an ETag", () => {
    const c = counter();
    const empty = new Response(null, { status: 204 });
    expect(releaseWhenSent(empty, c.release)).toBe(empty);
    expect(c.count()).toBe(1);
    // SvelteKit may swap this one for its own 304 after the hook, dropping
    // the body unread: wrapped, it would never release.
    const page = new Response("<html></html>", {
      headers: { "content-type": "text/html", etag: '"1a2b"' },
    });
    expect(releaseWhenSent(page, c.release)).toBe(page);
    expect(c.count()).toBe(2);
  });

  for (const type of ["text/event-stream", "text/html", "image/png"]) {
    it(`holds a ${type} body until its last chunk, keeping status, headers and data`, async () => {
      const c = counter();
      const body = pushed();
      const sent = releaseWhenSent(
        new Response(body.source, {
          status: 200,
          headers: { "content-type": type, "x-caelo-request-id": "r1" },
        }),
        c.release,
      );
      expect(sent.headers.get("x-caelo-request-id")).toBe("r1");
      const reader = (sent.body as ReadableStream<Uint8Array>).getReader();
      body.push("chunk 1");
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("chunk 1");
      expect(c.count()).toBe(0);
      body.end();
      expect((await reader.read()).done).toBe(true);
      expect(c.count()).toBe(1);
    });
  }

  it("lets a complete body settle before the next macrotask, as the adapter measures it", async () => {
    const c = counter();
    const sent = releaseWhenSent(Response.json({ ok: true }), c.release);
    const reader = (sent.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    let settled = false;
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      settled = true;
    })();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(true);
    expect(text).toBe('{"ok":true}');
    expect(c.count()).toBe(1);
  });

  it("keeps every Set-Cookie header, the status and its text", () => {
    const sent = releaseWhenSent(
      new Response("created", {
        status: 201,
        statusText: "Created",
        headers: [
          ["set-cookie", "a=1; Path=/"],
          ["set-cookie", "b=2; Path=/"],
        ],
      }),
      () => undefined,
    );
    expect(sent.status).toBe(201);
    expect(sent.statusText).toBe("Created");
    expect(sent.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("releases when the client goes away, and cancels the body behind it", async () => {
    const c = counter();
    let cancelled: unknown = null;
    const source = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelled = reason;
      },
    });
    const sent = releaseWhenSent(
      new Response(source, { headers: { "content-type": "image/png" } }),
      c.release,
    );
    await (sent.body as ReadableStream<Uint8Array>).cancel("client closed");
    expect(c.count()).toBe(1);
    expect(cancelled).toBe("client closed");
  });

  it("releases when the body fails", async () => {
    const c = counter();
    const source = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("storage went away");
      },
    });
    const sent = releaseWhenSent(new Response(source), c.release);
    const reader = (sent.body as ReadableStream<Uint8Array>).getReader();
    await expect(reader.read()).rejects.toThrow("storage went away");
    expect(c.count()).toBe(1);
  });
});
