// SPDX-License-Identifier: MPL-2.0

/**
 * #1375 — a 429 from a saturated admin reaches the agent as "not run, wait
 * N s, send the same call again unchanged", not as a raw HTTP body.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { postAdmin } from "./http.js";

let stub: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  stub = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/api/mcp/tool") {
        return new Response(
          JSON.stringify({
            message:
              "Caelo is at capacity right now: … Wait 7 s, then send the same call again unchanged.",
            retryAfterSeconds: 7,
          }),
          { status: 429, headers: { "retry-after": "7", "content-type": "application/json" } },
        );
      }
      // A proxy in front of the admin answered with its own body.
      return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "9" } });
    },
  });
});

afterAll(() => {
  stub.stop(true);
});

const post = (path: string) =>
  postAdmin({
    adminUrl: `http://localhost:${stub.port}`,
    token: "t",
    path,
    body: {},
    timeoutMs: 5_000,
  });

describe("#1375 — the bridge on a 429", () => {
  it("hands the admin's message to the agent", async () => {
    await expect(post("/api/mcp/tool")).rejects.toThrow(
      "Wait 7 s, then send the same call again unchanged.",
    );
  });

  it("falls back to Retry-After when the body is not the admin's", async () => {
    await expect(post("/api/mcp/session")).rejects.toThrow(
      "Caelo is at capacity right now (HTTP 429), so this call was not run. Wait 9 s, then send the same call again unchanged.",
    );
  });
});
