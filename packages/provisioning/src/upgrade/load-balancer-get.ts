// SPDX-License-Identifier: MPL-2.0

/**
 * A GET to one of the `gcp` load balancer's hosts, connected through another
 * of its names (#1459).
 *
 * The load balancer routes by Host header, not by the name the connection
 * was opened to, and every host of an install shares its address. So the
 * health check reaches the site's `/api/*` before the site's domain has any
 * record: it connects to `admin.<domain>`, whose record and certificate the
 * install needs anyway, verifies that certificate as usual, and asks for the
 * site's host. The site's own certificate cannot serve here: Google issues it
 * only once the domain points at the load balancer.
 *
 * `node:https` because `fetch` may not set the Host header (undici), and this
 * runs under Bun in the ops image and under either runtime from a terminal.
 */

import { request } from "node:https";

/** One GET through the load balancer. */
export interface LoadBalancerRequest {
  /** The name to connect to and verify the certificate against. */
  readonly connectHost: string;
  /** The host the URL map routes on. */
  readonly hostHeader: string;
  /** Path and query. */
  readonly path: string;
}

/** Sends a {@link LoadBalancerRequest}; rejects when no HTTP answer came. */
export type LoadBalancerGet = (
  req: LoadBalancerRequest,
) => Promise<{ readonly status: number; readonly text: string }>;

const TIMEOUT_MS = 30_000;

/** {@link LoadBalancerGet} over HTTPS, with the default certificate checks. */
export const httpsLoadBalancerGet: LoadBalancerGet = (req) =>
  new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: req.connectHost,
        servername: req.connectHost,
        path: req.path,
        method: "GET",
        headers: { Host: req.hostHeader },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    outgoing.on("timeout", () =>
      outgoing.destroy(new Error(`no answer from ${req.connectHost} in ${TIMEOUT_MS / 1000} s`)),
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
