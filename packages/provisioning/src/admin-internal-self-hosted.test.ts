// SPDX-License-Identifier: MPL-2.0

/**
 * #770 — the script `docker compose exec caelo-admin bun -e …` runs, executed
 * here by a real bun against a stand-in admin on 127.0.0.1:$PORT: it reads
 * the request from stdin, sends the token in `x-caelo-internal-token` and
 * prints the admin's answer as one JSON line.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { IN_CONTAINER_FETCH } from "./admin-internal-self-hosted.js";

let server: ReturnType<typeof Bun.serve>;
const received: { path: string; token: string | null; body: unknown }[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      received.push({
        path: new URL(req.url).pathname,
        token: req.headers.get("x-caelo-internal-token"),
        body: await req.json(),
      });
      return Response.json({ ok: true, echoed: true }, { status: 201 });
    },
  });
});
afterAll(() => server.stop(true));

async function runScript(stdin: string, port: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, "-e", IN_CONTAINER_FETCH], {
    env: { PATH: process.env.PATH ?? "", PORT: port },
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out;
}

describe("IN_CONTAINER_FETCH", () => {
  it("POSTs the stdin request to the admin's own port and prints its answer", async () => {
    const out = await runScript(
      JSON.stringify({ endpoint: "/api/internal/owner-reset", token: "t.sig", body: { a: 1 } }),
      String(server.port),
    );
    expect(JSON.parse(out)).toEqual({ status: 201, text: '{"ok":true,"echoed":true}' });
    expect(received).toEqual([
      { path: "/api/internal/owner-reset", token: "t.sig", body: { a: 1 } },
    ]);
  });

  it("reports an admin that does not answer instead of failing silently", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = String(closed.port);
    closed.stop(true);
    const out = await runScript(
      JSON.stringify({ endpoint: "/api/internal/x", token: "t", body: {} }),
      port,
    );
    expect(Object.keys(JSON.parse(out))).toEqual(["unreachable"]);
  });

  it("holds no secret: it is visible in the host's process list", () => {
    expect(IN_CONTAINER_FETCH).not.toMatch(/CAELO_INTERNAL_SECRET|[0-9a-f]{32}/);
  });
});
