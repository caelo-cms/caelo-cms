// SPDX-License-Identifier: MPL-2.0

/**
 * PR #869 — regression tests for the browser egress paths `ctx.route`
 * never sees. The live suite renders local fixtures in the repo's
 * Playwright Chromium and counts every TCP connection / UDP datagram that
 * reaches a canary on a BLOCKED address (`localhost:<port>`, the page
 * itself is served from the allow-listed 127.0.0.1). Before the fix the
 * canary saw a navigation preconnect for iframes and meta refresh,
 * STUN datagrams from WebRTC, and a full WebSocket `GET` from
 * `query()`. No external host is contacted. When Chromium is not
 * installed the live suite skips LOUDLY, same contract as
 * hidden-elements.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { connect, createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { lockedDownContextOptions, startBlackholeProxy } from "./browser-egress.js";
import { createPlaywrightScreenshotter, type Screenshotter } from "./screenshot.js";

describe("lockedDownContextOptions", () => {
  it("pins the black-hole proxy, removes the implicit loopback bypass, and blocks service workers", () => {
    expect(lockedDownContextOptions("http://127.0.0.1:4242")).toEqual({
      proxy: { server: "http://127.0.0.1:4242", bypass: "<-loopback>" },
      serviceWorkers: "block",
    });
  });
});

describe("startBlackholeProxy", () => {
  it("accepts on 127.0.0.1 and destroys the connection without answering", async () => {
    const proxy = await startBlackholeProxy();
    try {
      const port = Number(new URL(proxy.server).port);
      expect(new URL(proxy.server).hostname).toBe("127.0.0.1");
      const received = await new Promise<string>((resolve) => {
        const sock = connect(port, "127.0.0.1", () => {
          sock.write("CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n");
        });
        let data = "";
        sock.on("data", (d: Buffer) => {
          data += d.toString();
        });
        sock.on("close", () => resolve(data));
        // A reset (ECONNRESET) is the destroy-on-accept arriving; the
        // assertion is on what came back, which must be nothing.
        sock.on("error", () => undefined);
      });
      expect(received).toBe("");
    } finally {
      await proxy.close();
    }
  });
});

describe("external capture egress (live Chromium)", () => {
  const hits: string[] = [];
  let canaryTcp: TcpServer;
  let canaryUdp: UdpSocket;
  let canaryPort = 0;
  let pageServer: ReturnType<typeof Bun.serve>;
  let pageHtml = "";
  let screenshotter: Screenshotter | null = null;

  beforeAll(async () => {
    canaryTcp = createTcpServer((socket) => {
      hits.push("tcp-connect");
      socket.once("data", (d: Buffer) => hits.push(`tcp:${d.toString("latin1").split("\r\n")[0]}`));
      socket.on("error", () => undefined);
      setTimeout(() => socket.destroy(), 100);
    });
    await new Promise<void>((resolve) => canaryTcp.listen(0, "127.0.0.1", () => resolve()));
    const addr = canaryTcp.address();
    if (addr === null || typeof addr === "string") throw new Error("canary did not bind");
    canaryPort = addr.port;
    canaryUdp = createSocket("udp4");
    canaryUdp.on("message", (m: Buffer) => hits.push(`udp:${m.length}`));
    await new Promise<void>((resolve) => canaryUdp.bind(canaryPort, "127.0.0.1", () => resolve()));
    pageServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(pageHtml, { headers: { "content-type": "text/html" } }),
    });
    screenshotter = await createPlaywrightScreenshotter({ allowedHosts: ["127.0.0.1"] });
    if (screenshotter === null) {
      console.warn(
        "[browser-egress.test] Playwright Chromium unavailable — SKIPPING the live egress assertions. Install with `bun node_modules/playwright/cli.js install chromium`.",
      );
    }
  });

  afterAll(async () => {
    await screenshotter?.dispose();
    pageServer.stop(true);
    canaryTcp.close();
    canaryUdp.close();
  });

  /** Render `body` as an external page, then give stray egress time to land. */
  async function renderAndCollect(body: string): Promise<{ html: string; hits: string[] }> {
    if (screenshotter === null) throw new Error("unreachable: guarded by the caller");
    hits.length = 0;
    pageHtml = `<!doctype html><html><head></head><body><h1>EgressFixture</h1>${body}</body></html>`;
    const r = await screenshotter.renderHtml(`http://127.0.0.1:${pageServer.port}/`, {
      external: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return { html: r.html, hits: [...hits] };
  }

  const blocked = () => `http://localhost:${canaryPort}`;
  // [label, page body, does the fixture document stay rendered?]
  const cases: Array<[string, () => string, boolean]> = [
    [
      "an iframe navigation (speculative preconnect)",
      () => `<iframe src="${blocked()}/if"></iframe>`,
      true,
    ],
    [
      "a meta refresh navigation (speculative preconnect)",
      () => `<meta http-equiv="refresh" content="0;url=${blocked()}/refresh">`,
      false,
    ],
    [
      "WebRTC STUN over UDP",
      () =>
        `<script>const pc=new RTCPeerConnection({iceServers:[{urls:"stun:127.0.0.1:${canaryPort}"}]});pc.createDataChannel("x");pc.createOffer().then((o)=>pc.setLocalDescription(o));</script>`,
      true,
    ],
    [
      "a WebSocket",
      () => `<script>new WebSocket("ws://localhost:${canaryPort}/ws")</script>`,
      true,
    ],
    ["a preconnect hint", () => `<link rel="preconnect" href="${blocked()}">`, true],
    ["a subresource", () => `<img src="${blocked()}/img">`, true],
  ];

  it.each(cases)("never reaches a blocked address via %s", async (_label, body, staysOnPage) => {
    if (screenshotter === null) return; // loud skip in beforeAll
    const r = await renderAndCollect(body());
    if (staysOnPage) expect(r.html).toContain("EgressFixture");
    expect(r.hits).toEqual([]);
  });

  it("query() over cached third-party HTML runs no script and opens no socket", async () => {
    if (screenshotter === null) return; // loud skip in beforeAll
    hits.length = 0;
    const html = `<!doctype html><html><body><p class="x">hi</p><script>new WebSocket("ws://localhost:${canaryPort}/latest/meta-data")</script><iframe src="${blocked()}/if"></iframe></body></html>`;
    const matches = await screenshotter.query(html, { cssSelector: "p.x" });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(matches).toEqual(['<p class="x">hi</p>']);
    expect([...hits]).toEqual([]);
  });
});
