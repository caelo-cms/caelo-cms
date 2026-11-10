// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1361 — a publish notification that is still waiting when a
 * request starts must not let the request answer from the cache it drops.
 *
 * The gateway runs on request-billed CPU: between requests the instance has
 * no CPU, so a NOTIFY that arrives then is handled only once the next
 * request brings CPU back, possibly after that request read its cache. A
 * request that starts on an idle instance therefore marks the published
 * state unconfirmed, and the request confirms it before its first read of
 * cached state (published-changes.ts). Here the LISTEN is a fake that
 * acknowledges the subscription and never delivers a notification — the
 * throttled instance, frozen at its worst moment.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { DatabaseAdapter, ListenCallbacks } from "@caelo-cms/query-api";
import {
  CONFIRM_MAX_AGE_MS,
  confirmOffAnswer,
  confirmPublishedState,
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

let clock = 1_000_000;

/** One gateway request: the cheap gates pass, then confirm, then the cached read. */
function request(
  read: () => Promise<string> = readVersions,
  serve: () => Promise<string> = readGate,
): Promise<string> {
  return servePublishedRequest(async () => {
    await confirmPublishedState(read, clock);
    return serve();
  });
}

/** A publish: the source and its versions change; the notification never arrives here. */
function publishWithoutNotification(value: string, version: string): void {
  published = value;
  versions = version;
}

beforeEach(async () => {
  resetPublishedStateConfirmation();
  published = "gate: open";
  versions = "staging_site:100";
  versionReads = 0;
  sourceReads = 0;
  cached = null;
  clock = 1_000_000;
  callbacks = null;
  await listenForPublishedChanges(silentListen);
});

describe("#1361 — a request after an idle stretch confirms the published state", () => {
  it("drops a cache whose notification is still waiting, and reads the new state", async () => {
    expect(await request()).toBe("gate: open");
    // Nothing published since: the next request (idle again) serves the cache.
    expect(await request()).toBe("gate: open");
    expect(sourceReads).toBe(1);
    expect(versionReads).toBe(2);

    publishWithoutNotification("gate: closed", "staging_site:101");
    // Without the confirmation this answered "gate: open" from the cache.
    expect(await request()).toBe("gate: closed");
    expect(sourceReads).toBe(2);
  });

  it("a section the publish removed changes the versions too", async () => {
    versions = "settings:7,staging_site:100";
    await request();
    publishWithoutNotification("no settings", "staging_site:100");
    expect(await request()).toBe("no settings");
  });

  it("while requests keep coming the LISTEN is trusted, until the confirmation ages", async () => {
    let release = (): void => undefined;
    // A long request (a stream) starts on an idle instance and reads no
    // published state itself.
    const long = servePublishedRequest(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("long done");
        }),
    );
    // The first request that reads published state after that idle start
    // confirms it; the next ones, with CPU all along, trust the LISTEN.
    expect(await request()).toBe("gate: open");
    const confirmed = versionReads;
    expect(confirmed).toBe(1);
    expect(await request()).toBe("gate: open");
    expect(versionReads).toBe(confirmed);
    // A LISTEN that died without a word hides a publish at most this long.
    clock += CONFIRM_MAX_AGE_MS;
    publishWithoutNotification("gate: closed", "staging_site:102");
    expect(await request()).toBe("gate: closed");
    expect(versionReads).toBe(confirmed + 1);
    release();
    expect(await long).toBe("long done");
  });

  it("a request that joins one which started on an idle instance confirms too, before its own read", async () => {
    await request();
    publishWithoutNotification("gate: closed", "staging_site:103");
    // The first request starts on an idle instance and is still in its cheap
    // gates when the second one starts.
    let pass = (): void => undefined;
    const gates = new Promise<void>((resolve) => {
      pass = resolve;
    });
    const first = servePublishedRequest(async () => {
      await gates;
      await confirmPublishedState(readVersions, clock);
      return readGate();
    });
    // Not idle any more, but the published state is still unconfirmed.
    expect(await request()).toBe("gate: closed");
    pass();
    expect(await first).toBe("gate: closed");
  });

  it("requests that confirm together wait for one read", async () => {
    await request();
    publishWithoutNotification("gate: closed", "staging_site:104");
    let answer = (_v: string): void => undefined;
    const slowVersions = () =>
      new Promise<string>((resolve) => {
        versionReads += 1;
        answer = resolve;
      });
    const before = versionReads;
    const first = request(slowVersions);
    const second = request(slowVersions);
    await Bun.sleep(0);
    expect(versionReads).toBe(before + 1);
    answer(versions);
    expect(await first).toBe("gate: closed");
    expect(await second).toBe("gate: closed");
  });

  it("a confirmation that fails drops the caches: the request reads through, the next one tries again", async () => {
    await request();
    published = "gate: closed";
    const failing = async (): Promise<string> => {
      throw new Error("database unreachable");
    };
    expect(await request(failing)).toBe("gate: closed");
    const before = versionReads;
    await request();
    expect(versionReads).toBe(before + 1);
  });

  it("a feature switched on while the instance idled is served from the first request (Copilot review of #1557)", async () => {
    // The off answer comes from memory before every gate (E14 a): "gate"
    // stands for the staging host here, "off" for none set.
    published = "off";
    const offRequest = () =>
      servePublishedRequest(async () => {
        const known = await readGate();
        if (known !== "off") return known;
        await confirmOffAnswer(readVersions, clock);
        return readGate();
      });
    expect(await offRequest()).toBe("off");
    // The Owner sets a staging host while the instance idles: its
    // notification waits in the socket.
    clock += CONFIRM_MAX_AGE_MS;
    publishWithoutNotification("on", "staging_site:105");
    // Without the confirmation this was the fixed 404 again.
    expect(await offRequest()).toBe("on");
  });

  it("junk on an off feature costs at most one read per CONFIRM_MAX_AGE_MS, idle or not", async () => {
    published = "off";
    const offAnswer = () =>
      servePublishedRequest(async () => {
        await readGate();
        await confirmOffAnswer(readVersions, clock);
        return readGate();
      });
    await offAnswer();
    const reads = versionReads;
    expect(reads).toBe(1);
    // Every one of these starts on an idle instance.
    for (let i = 0; i < 20; i += 1) {
      clock += 1_000;
      await offAnswer();
    }
    expect(versionReads).toBe(reads);
    clock += CONFIRM_MAX_AGE_MS;
    await offAnswer();
    expect(versionReads).toBe(reads + 1);
    // A request whose feature turned out on goes on to its gates, and the
    // confirmation there stands on the one its off answer just made.
    clock += CONFIRM_MAX_AGE_MS;
    await servePublishedRequest(async () => {
      await confirmOffAnswer(readVersions, clock);
      await confirmPublishedState(readVersions, clock);
    });
    expect(versionReads).toBe(reads + 2);
  });

  it("confirms nothing for a request that reads no published state, or while the LISTEN is down", async () => {
    await servePublishedRequest(async () => "healthz");
    expect(versionReads).toBe(0);
    callbacks?.onLost(new Error("connection reset"));
    expect(publishedCacheUsable()).toBe(false);
    await request();
    expect(versionReads).toBe(0);
  });
});
