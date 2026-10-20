// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #901 — the install's real client (admin-core BugIntakeClient) against
 * the intake's real HTTP handler. Both sides share the contract module, but
 * only this test proves they still speak to each other: register, signed
 * report, status refresh, and the retry signal for an unregistered key.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { BugIntakeClient } from "@caelo-cms/admin-core";
import type { BugIntakeReport } from "@caelo-cms/shared";
import { createIntakeHandler } from "./server.js";
import { IntakeService, type IssueTracker } from "./service.js";
import { MemoryStore } from "./store.js";

const tracker: IssueTracker = {
  createIssue: async () => ({ number: 7, url: "https://github.com/caelo-cms/caelo-cms/issues/7" }),
  updateIssue: async () => {},
  getIssue: async () => ({
    number: 7,
    url: "https://github.com/caelo-cms/caelo-cms/issues/7",
    state: "open",
    stateReason: null,
    closedAt: null,
    labels: [],
  }),
  addComment: async () => {},
  recentCommentBodies: async () => [],
  releases: async () => [],
};

let identity: { installId: string; publicKey: string; privateKeyPkcs8: string };
const report: BugIntakeReport = {
  protocolVersion: 1,
  reportId: "00000000-0000-4000-8000-000000000042",
  caeloVersion: "0.10.55",
  fingerprint: "f".repeat(64),
  source: "auto",
  severity: "blocking",
  blockedTask: true,
  suspectedTool: "deploy_staging",
  title: "Tool deploy_staging returned an error",
  whatHappened: "HandlerError",
  expected: "A staged build.",
  evidence: null,
};

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  identity = {
    installId: "44444444-4444-4444-8444-444444444444",
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64"),
    privateKeyPkcs8: Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
      "base64",
    ),
  };
});

describe("install client ↔ intake", () => {
  it("registers, sends a signed report and refreshes its status", async () => {
    const store = new MemoryStore();
    const handler = createIntakeHandler({
      store,
      service: new IntakeService({
        store,
        tracker,
        matcher: { match: async () => null },
        issueThresholdInstalls: 1,
      }),
    });
    const client = new BugIntakeClient({
      baseUrl: "https://bugs.test",
      fetchImpl: ((url: string, init?: RequestInit) =>
        handler(new Request(url, init))) as unknown as typeof fetch,
    });

    const early = await client.sendReport(identity, report);
    expect(early.kind).toBe("retry");

    expect((await client.register(identity)).kind).toBe("ok");
    const sent = await client.sendReport(identity, report);
    if (sent.kind !== "ok") throw new Error(sent.error);
    expect(sent.value).toMatchObject({
      status: "open",
      issueUrl: "https://github.com/caelo-cms/caelo-cms/issues/7",
    });

    const status = await client.clusterStatus(identity, [sent.value.clusterId]);
    if (status.kind !== "ok") throw new Error(status.error);
    expect(status.value[0]?.clusterId).toBe(sent.value.clusterId);
  });
});
