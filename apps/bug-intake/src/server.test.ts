// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #901 (#903) — the intake's HTTP contract: only the install that
 * pinned a key can send as that install, a captured request cannot be
 * replayed elsewhere or later, and every refusal tells the install whether
 * to retry.
 */

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  BUG_INTAKE_HEADERS,
  type BugIntakeReport,
  bugIntakeErrorResponse,
  bugIntakeSigningString,
} from "@caelo-cms/shared";
import { RateLimiter } from "./rate-limit.js";
import { createIntakeHandler } from "./server.js";
import { IntakeService, type IssueTracker } from "./service.js";
import { MemoryStore } from "./store.js";

const INSTALL = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;
let keys: { publicKey: string; privateKey: CryptoKey };
let otherKey: CryptoKey;

const tracker: IssueTracker = {
  createIssue: async () => ({ number: 1, url: "https://github.com/caelo-cms/caelo-cms/issues/1" }),
  updateIssue: async () => {},
  getIssue: async () => {
    throw new Error("not used");
  },
  addComment: async () => {},
  recentCommentBodies: async () => [],
  releases: async () => [],
};

const report: BugIntakeReport = {
  protocolVersion: 1,
  reportId: "00000000-0000-4000-8000-000000000001",
  caeloVersion: "0.10.55",
  fingerprint: "a".repeat(64),
  source: "auto",
  severity: "degraded",
  blockedTask: false,
  suspectedTool: "build_page",
  title: "Tool build_page returned an error",
  whatHappened: "boom",
  expected: "ok",
  evidence: null,
};

let store: MemoryStore;
let handler: (req: Request) => Promise<Response>;

async function signed(
  path: string,
  body: string,
  opts: { key?: CryptoKey; timestamp?: number; signPath?: string } = {},
): Promise<Request> {
  const timestamp = String(opts.timestamp ?? NOW);
  const message = await bugIntakeSigningString({
    method: "POST",
    path: opts.signPath ?? path,
    timestamp,
    body,
  });
  const sig = await crypto.subtle.sign(
    "Ed25519",
    opts.key ?? keys.privateKey,
    new TextEncoder().encode(message),
  );
  return new Request(`https://bugs.test${path}`, {
    method: "POST",
    body,
    headers: {
      [BUG_INTAKE_HEADERS.installId]: INSTALL,
      [BUG_INTAKE_HEADERS.timestamp]: timestamp,
      [BUG_INTAKE_HEADERS.signature]: Buffer.from(sig).toString("base64"),
    },
  });
}

const register = (publicKey: string, ip = "203.0.113.1") =>
  handler(
    new Request("https://bugs.test/v1/installs", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
      body: JSON.stringify({
        protocolVersion: 1,
        installId: INSTALL,
        publicKey,
        caeloVersion: "0.10.55",
      }),
    }),
  );

async function errorOf(res: Response) {
  return bugIntakeErrorResponse.parse(await res.json());
}

beforeAll(async () => {
  const gen = async () =>
    (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
  const pair = await gen();
  keys = {
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64"),
    privateKey: pair.privateKey,
  };
  otherKey = (await gen()).privateKey;
});

beforeEach(() => {
  store = new MemoryStore();
  const service = new IntakeService({
    store,
    tracker,
    matcher: { match: async () => null },
    issueThresholdInstalls: 1,
    maxNewIssuesPerDay: 100,
    issuesPaused: false,
  });
  handler = createIntakeHandler({
    service,
    store,
    now: () => NOW,
    installLimiter: new RateLimiter(3, 60_000),
    globalRegisterLimiter: new RateLimiter(4, 60 * 60_000),
  });
});

describe("bug intake HTTP", () => {
  it("answers liveness on /health (external checks) and /healthz (container probes)", async () => {
    for (const path of ["/health", "/healthz"]) {
      const res = await handler(new Request(`https://bugs.test${path}`));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    }
  });

  it("answers the post-deploy smoke check: a never-registered install gets a retryable 401", async () => {
    const res = await handler(
      await signed("/v1/clusters/status", JSON.stringify({ clusterIds: [] })),
    );
    expect(res.status).toBe(401);
    const err = await errorOf(res);
    expect(err.error).toStartWith("Unknown install");
    expect(err.retryable).toBe(true);
  });

  it("accepts a signed report from a registered install and answers with its cluster", async () => {
    expect((await register(keys.publicKey)).status).toBe(204);
    const res = await handler(await signed("/v1/reports", JSON.stringify(report)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; issueUrl: string };
    expect(body.status).toBe("open");
    expect(body.issueUrl).toContain("/issues/1");

    const status = await handler(
      await signed(
        "/v1/clusters/status",
        JSON.stringify({ protocolVersion: 1, clusterIds: [`c_${"a".repeat(20)}`] }),
      ),
    );
    expect(((await status.json()) as { clusters: unknown[] }).clusters.length).toBe(1);
  });

  it("asks an unknown install to register (retryable) and refuses a foreign key for good", async () => {
    let res = await handler(await signed("/v1/reports", JSON.stringify(report)));
    expect(res.status).toBe(401);
    expect((await errorOf(res)).retryable).toBe(true);

    await register(keys.publicKey);
    res = await handler(await signed("/v1/reports", JSON.stringify(report), { key: otherKey }));
    expect(res.status).toBe(401);
    expect((await errorOf(res)).retryable).toBe(false);
  });

  it("refuses replays: stale timestamps and signatures made for another path", async () => {
    await register(keys.publicKey);
    const stale = await handler(
      await signed("/v1/reports", JSON.stringify(report), { timestamp: NOW - 10 * 60_000 }),
    );
    expect(stale.status).toBe(401);
    const moved = await handler(
      await signed("/v1/reports", JSON.stringify(report), { signPath: "/v1/clusters/status" }),
    );
    expect(moved.status).toBe(401);
  });

  it("refuses a second key for a registered install id", async () => {
    await register(keys.publicKey);
    const res = await register(Buffer.alloc(32, 7).toString("base64"));
    expect(res.status).toBe(409);
    expect((await errorOf(res)).retryable).toBe(false);
  });

  it("rejects malformed reports permanently and rate-limits per install (retryable)", async () => {
    await register(keys.publicKey);
    const bad = await handler(
      await signed("/v1/reports", JSON.stringify({ ...report, siteUrl: "https://leak" })),
    );
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).retryable).toBe(false);

    // The malformed request counted; two more fit the window of three.
    for (let i = 0; i < 2; i++) await handler(await signed("/v1/reports", JSON.stringify(report)));
    const limited = await handler(await signed("/v1/reports", JSON.stringify(report)));
    expect(limited.status).toBe(429);
    expect((await errorOf(limited)).retryable).toBe(true);
  });

  it("limits registrations across all addresses, not only per address (retryable)", async () => {
    for (let i = 1; i <= 4; i++) {
      expect((await register(keys.publicKey, `198.51.100.${i}`)).status).toBe(204);
    }
    const res = await register(keys.publicKey, "198.51.100.99");
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toMatchObject({ retryable: true });
  });

  it("refuses oversized bodies before parsing", async () => {
    const res = await handler(
      new Request("https://bugs.test/v1/installs", { method: "POST", body: "x".repeat(70_000) }),
    );
    expect(res.status).toBe(413);
  });
});
