// SPDX-License-Identifier: MPL-2.0

/**
 * issue #191 / PR #869 — fail-closed network egress for browser contexts
 * that render untrusted content (external captures and `query()` over a
 * cached third-party DOM).
 *
 * `ctx.route` sees HTTP requests only. Chromium has egress paths it never
 * routes: the speculative TCP preconnect it opens for every navigation
 * (iframes, meta refresh, `location` changes) BEFORE the route handler
 * aborts or fulfills it, WebRTC ICE/STUN traffic over UDP, and WebSockets
 * (handled separately by `routeWebSocket`). Each of those reached an
 * internal address in a real-Chromium probe even with the route guard in
 * place.
 *
 * The fix is a black-hole proxy pinned on the context: every connection
 * Chromium makes outside the route layer goes to a local listener that
 * destroys it without reading a byte. Requests the route guard fulfills
 * never touch the network, so the proxy changes nothing for them.
 * `<-loopback>` removes Chromium's implicit "localhost bypasses the proxy"
 * rule, which would otherwise let a page dial 127.0.0.1 / ::1 directly.
 * WebRTC ignores proxies for UDP unless the launch flag below forbids
 * non-proxied UDP, so the screenshotter's browser launches with it.
 */

import { createServer, type Server } from "node:net";

/**
 * Chromium switch that stops WebRTC from sending UDP outside the proxy.
 * With the black-hole proxy pinned, the only remaining WebRTC transport
 * (TCP via the proxy) is destroyed on connect. Note the spelling: the
 * similarly named `--force-webrtc-ip-handling-policy` is a different,
 * test-only switch and leaves STUN-over-UDP to a page-chosen address on
 * (verified against the bundled Chromium).
 */
export const NO_UNPROXIED_WEBRTC_UDP_ARG = "--webrtc-ip-handling-policy=disable_non_proxied_udp";

/** A running black-hole proxy. `server` is the proxy URL for Playwright. */
export interface BlackholeProxy {
  readonly server: string;
  close(): Promise<void>;
}

/**
 * Listen on an ephemeral 127.0.0.1 port and destroy every connection on
 * accept. Owned by the screenshotter; closed by its `dispose()`.
 */
export async function startBlackholeProxy(): Promise<BlackholeProxy> {
  const server: Server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  // The browser it serves already keeps the process alive; the black hole
  // itself must never be the reason a worker cannot exit.
  server.unref();
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("black-hole proxy did not bind a TCP port on 127.0.0.1");
  }
  return {
    server: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * `browser.newContext` options for a context that renders untrusted
 * content: all non-routed egress goes to the black hole (loopback
 * included) and service workers, whose fetches `ctx.route` cannot see,
 * are blocked. Pure (exported for the regression test).
 */
export function lockedDownContextOptions(proxyServer: string): {
  readonly proxy: { readonly server: string; readonly bypass: string };
  readonly serviceWorkers: "block";
} {
  return {
    proxy: { server: proxyServer, bypass: "<-loopback>" },
    serviceWorkers: "block",
  };
}
