// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #901 — how the bug-intake client classifies answers. `retry` keeps a
 * report queued with backoff; `failed` stops it. Getting this wrong either
 * drops reports on a transient outage or retries a permanent refusal forever.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { BugIntakeReport } from "@caelo-cms/shared";
import {
  BugIntakeClient,
  bugIntakeUrl,
  DEFAULT_BUG_INTAKE_URL,
  type IntakeIdentity,
} from "./client.js";

let identity: IntakeIdentity;
const report: BugIntakeReport = {
  protocolVersion: 1,
  reportId: "00000000-0000-4000-8000-000000000002",
  caeloVersion: "0.10.55",
  fingerprint: "a".repeat(64),
  source: "ai",
  severity: "degraded",
  blockedTask: false,
  suspectedTool: null,
  title: "t",
  whatHappened: "w",
  expected: "e",
  evidence: null,
};

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  identity = {
    installId: "00000000-0000-4000-8000-000000000001",
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64"),
    privateKeyPkcs8: Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
      "base64",
    ),
  };
});

function clientAnswering(res: () => Response | Promise<Response>) {
  return new BugIntakeClient({
    baseUrl: "https://intake.test/",
    fetchImpl: (async () => res()) as unknown as typeof fetch,
  });
}

describe("BugIntakeClient", () => {
  it.each([
    ["503 without a body", () => new Response("down", { status: 503 }), "retry"],
    ["429", () => new Response("", { status: 429 }), "retry"],
    ["400 without a body", () => new Response("nope", { status: 400 }), "failed"],
    [
      "400 the intake marked retryable",
      () => Response.json({ error: "key not pinned yet", retryable: true }, { status: 400 }),
      "retry",
    ],
    [
      "500 the intake marked permanent",
      () =>
        Response.json({ error: "protocol version unsupported", retryable: false }, { status: 500 }),
      "failed",
    ],
    ["a 200 that is not a cluster", () => Response.json({ hello: 1 }), "failed"],
  ] as const)("classifies %s", async (_label, res, kind) => {
    const out = await clientAnswering(res).sendReport(identity, report);
    expect(out.kind).toBe(kind);
  });

  it("treats a network error as retryable", async () => {
    const out = await clientAnswering(() => {
      throw new TypeError("fetch failed");
    }).sendReport(identity, report);
    expect(out).toEqual({ kind: "retry", error: "bug intake unreachable: fetch failed" });
  });

  it("resolves the intake URL from the environment", () => {
    expect(bugIntakeUrl({})).toBe(DEFAULT_BUG_INTAKE_URL);
    expect(bugIntakeUrl({ CAELO_BUG_INTAKE_URL: "http://localhost:8787/" })).toBe(
      "http://localhost:8787",
    );
  });
});
