// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1361 — a publish notification that is still waiting when a
 * request starts must not let the request answer from the cache it drops.
 *
 * The gateway runs on request-billed CPU: between requests the instance has
 * no CPU, so a NOTIFY that arrives then is handled only once the next
 * request brings CPU back, possibly after that request read its cache. A
 * request that starts on an idle instance therefore confirms the published
 * state first (published-changes.ts `servePublishedRequest`). Here the
 * LISTEN is a fake that acknowledges the subscription and never delivers a
 * notification — the throttled instance, frozen at its worst moment.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DatabaseAdapter, ListenCallbacks } from "@caelo-cms/query-api";
import {
  CONFIRM_MAX_AGE_MS,
  listenForPublishedChanges,
  mayCacheRead,
  onPublishedChange,
  publishedCacheGeneration,
  publishedCacheUsable,
  resetPublishedStateConfirmation,
  servePublishedRequest,
} from "./published-changes.js";

let callbacks: ListenCallbacks | null = null;
/** A LISTEN that is acknowledged and then hears nothing (the notification waits in the socket). */
const silentListen = {
  listen: async (_pool: string, _channel: string, cb: ListenCallbacks) => {
    callbacks = cb;
    cb.onListen();
    return { unlisten: async () => undefined };
  },
} as unknown as DatabaseAdapter;

/** The published value, its section versions, and a cache built like server.ts's. */
let published = "gate: open";
let versions = "staging_site:100";
let versionReads = 0;
let sourceReads = 0;
let cached: string | null = null;
onPublishedChange(() => {
  cached = null;
});

const readVersions = async (): Promise<string> => {
  versionReads += 1;
  return versions;
};

async function readGate(): Promise<string> {
  if (cached !== null && publishedCacheUsable()) return cached;
  const startedAt = publishedCacheGeneration();
  sourceReads += 1;
  const value = published;
  if (mayCacheRead(startedAt)) cached = value;
  return value;
}

/** A publish: the source and its versions change; the notification never arrives here. */
function publishWithoutNotification(value: string, version: string): void {
  published = value;
  versions = version;
}

let clock = 1_000_000;
const now = () => clock;

beforeEach(async () => {
  resetPublishedStateConfirmation();
  published = "gate: open";
  versions = "staging_site:100";
  versionReads = 0;
  sourceReads = 0;
  cached = null;
  clock = 1_000_000;
  await listenForPublishedChanges(silentListen);
});

afterEach(() => {
  callbacks = null;
});

describe("#1361 — a request after an idle stretch confirms the published state", () => {
  it("drops a cache whose notification is still waiting, and reads the new state", async () => {
    expect(await servePublishedRequest(readVersions, readGate, now)).toBe("gate: open");
    // Nothing published since: the next request (idle again) serves the cache.
    expect(await servePublishedRequest(readVersions, readGate, now)).toBe("gate: open");
    expect(sourceReads).toBe(1);
    expect(versionReads).toBe(2);

    publishWithoutNotification("gate: closed", "staging_site:101");
    // Without the confirmation this answered "gate: open" from the cache.
    expect(await servePublishedRequest(readVersions, readGate, now)).toBe("gate: closed");
    expect(sourceReads).toBe(2);
  });

  it("a section the publish removed changes the versions too", async () => {
    versions = "settings:7,staging_site:100";
    await servePublishedRequest(readVersions, readGate, now);
    publishWithoutNotification("no settings", "staging_site:100");
    expect(await servePublishedRequest(readVersions, readGate, now)).toBe("no settings");
  });

  it("a request that starts while another is in flight trusts the LISTEN until the confirmation ages", async () => {
    await servePublishedRequest(readVersions, readGate, now);
    let release = (): void => undefined;
    const long = servePublishedRequest(
      readVersions,
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("long done");
        }),
      now,
    );
    await Bun.sleep(0);
    const before = versionReads;
    // The instance has CPU while `long` runs: notifications are handled.
    expect(await servePublishedRequest(readVersions, readGate, now)).toBe("gate: open");
    expect(versionReads).toBe(before);
    // A LISTEN that died without a word hides a publish at most this long.
    clock += CONFIRM_MAX_AGE_MS;
    publishWithoutNotification("gate: closed", "staging_site:102");
    expect(await servePublishedRequest(readVersions, readGate, now)).toBe("gate: closed");
    expect(versionReads).toBe(before + 1);
    release();
    expect(await long).toBe("long done");
  });

  it("requests that start together wait for one confirmation", async () => {
    await servePublishedRequest(readVersions, readGate, now);
    publishWithoutNotification("gate: closed", "staging_site:103");
    let answer = (_v: string): void => undefined;
    const slowVersions = () =>
      new Promise<string>((resolve) => {
        versionReads += 1;
        answer = resolve;
      });
    const first = servePublishedRequest(slowVersions, readGate, now);
    // Starts while the first is in flight, before its confirmation came back.
    const second = servePublishedRequest(slowVersions, readGate, now);
    await Bun.sleep(0);
    expect(versionReads).toBe(2); // the setup request's, then the shared one
    answer(versions);
    expect(await first).toBe("gate: closed");
    expect(await second).toBe("gate: closed");
  });

  it("a confirmation that fails drops the caches: the request reads through", async () => {
    await servePublishedRequest(readVersions, readGate, now);
    published = "gate: closed";
    const failing = async (): Promise<string> => {
      throw new Error("database unreachable");
    };
    expect(await servePublishedRequest(failing, readGate, now)).toBe("gate: closed");
  });

  it("confirms nothing for a request that reads no published state, or while the LISTEN is down", async () => {
    await servePublishedRequest(null, async () => "healthz", now);
    expect(versionReads).toBe(0);
    callbacks?.onLost(new Error("connection reset"));
    expect(publishedCacheUsable()).toBe(false);
    await servePublishedRequest(readVersions, readGate, now);
    expect(versionReads).toBe(0);
  });
});
