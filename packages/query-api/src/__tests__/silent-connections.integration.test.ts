// SPDX-License-Identifier: MPL-2.0

/**
 * Regression test for the production admin wedge (2026-10-22): the network
 * dropped the flows of every pooled connection without a reset, and with
 * Bun's default of no idle timeout each query handed to such a connection
 * waited forever — the admin hung on every database request for a day
 * while `/_caelo/health` (built on the remembered `verifyRoles`) said ok.
 *
 * A TCP proxy between the adapter and Postgres reproduces it: after
 * `silenceExisting()` it forwards nothing on the connections it already
 * holds, yet still serves new ones — exactly what the pool saw.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "bun";
import { DatabaseAdapter, DatabaseUnresponsiveError, POOL_IDLE_TIMEOUT_SECONDS } from "../index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("ADMIN_DATABASE_URL + PUBLIC_DATABASE_URL required");

interface Flow {
  silent: boolean;
  upstream: Socket<undefined> | null;
  pending: Uint8Array[];
}

interface SilencingProxy {
  /** `upstreamUrl` with host + port pointed at the proxy. */
  readonly url: string;
  /** Stop forwarding on every connection opened so far; later ones still work. */
  silenceExisting(): void;
  stop(): void;
}

function silencingProxy(upstreamUrl: string): SilencingProxy {
  const target = new URL(upstreamUrl);
  const flows: Flow[] = [];
  const server = Bun.listen<Flow>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(client) {
        const flow: Flow = { silent: false, upstream: null, pending: [] };
        client.data = flow;
        flows.push(flow);
        flow.upstream = await Bun.connect({
          hostname: target.hostname,
          port: Number(target.port || 5432),
          socket: {
            data(_s, chunk) {
              if (!flow.silent) client.write(chunk);
            },
            close() {
              if (!flow.silent) client.end();
            },
          },
        });
        for (const chunk of flow.pending) flow.upstream.write(chunk);
        flow.pending = [];
      },
      data(client, chunk) {
        const flow = client.data;
        if (flow.silent) return;
        if (flow.upstream) flow.upstream.write(chunk);
        else flow.pending.push(new Uint8Array(chunk));
      },
      close(client) {
        if (!client.data.silent) client.data.upstream?.end();
      },
    },
  });
  const proxied = new URL(upstreamUrl);
  proxied.hostname = "127.0.0.1";
  proxied.port = String(server.port);
  return {
    url: proxied.toString(),
    silenceExisting() {
      for (const flow of flows) flow.silent = true;
    },
    stop() {
      for (const flow of flows) flow.upstream?.end();
      server.stop(true);
    },
  };
}

/** Settles with the query outcome, or "hang" when it is still pending after `ms`. */
async function outcome(query: Promise<unknown>, ms: number): Promise<string> {
  return Promise.race([
    query.then(
      () => "ok",
      (e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`,
    ),
    Bun.sleep(ms).then(() => "hang"),
  ]);
}

describe("pooled connections whose network flow went silent", () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  function setup(poolIdleTimeoutSeconds?: number) {
    const admin = silencingProxy(ADMIN_URL as string);
    const pub = silencingProxy(PUBLIC_URL as string);
    const adapter = new DatabaseAdapter({
      adminDatabaseUrl: admin.url,
      publicDatabaseUrl: pub.url,
      poolMax: 2,
      ...(poolIdleTimeoutSeconds === undefined ? {} : { poolIdleTimeoutSeconds }),
    });
    // close() would wait on the silenced sockets; ending the proxies frees them.
    cleanup.push(() => {
      admin.stop();
      pub.stop();
    });
    cleanup.push(() => outcome(adapter.close(), 2000).then(() => undefined));
    return { adapter, admin, pub };
  }

  it("the pool recovers on its own once the idle timeout closes the dead connections", async () => {
    const { adapter, admin } = setup(1);
    const raw = adapter.rawAdmin();
    await Promise.all([raw`SELECT 1`, raw`SELECT 1`]);
    admin.silenceExisting();

    // The query on a dead connection fails loudly instead of waiting forever…
    expect(await outcome(raw`SELECT 1`, 5000)).toMatch(/^error: .*[Ii]dle timeout/);
    // …and the pool then opens a working connection.
    await Bun.sleep(1200);
    expect(await outcome(raw`SELECT 1`, 5000)).toBe("ok");
  });

  it("ping() reports a pool whose connections hang, where verifyRoles still passes", async () => {
    const { adapter, pub } = setup();
    await adapter.verifyRoles();
    await adapter.ping(2000);
    pub.silenceExisting();

    await adapter.verifyRoles(); // remembered — this is why health needed ping()
    const err = await adapter.ping(300).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DatabaseUnresponsiveError);
    expect((err as Error).message).toContain("public database pool");
  });

  it("the production idle timeout outlasts the advisory-lock waits during a site publish", () => {
    // Bun counts silence while a transaction waits on a lock too; a short
    // value would abort legitimate Stage / Publish live waits.
    expect(POOL_IDLE_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(600);
  });
});
