// SPDX-License-Identifier: MPL-2.0

/**
 * Boot smoke of the bug intake image (bug-intake-image.yml): the install's
 * own client (admin-core `BugIntakeClient`) registers, sends two signed
 * reports and asks for their status, against the running image whose store
 * is a Firestore emulator. The image is a bundle (apps/bug-intake/image.ts),
 * so this is where a package the bundle broke shows: the Firestore client
 * over gRPC (reads, queries, transactions), the signature check.
 *
 * The first report opens a cluster. The second has a different fingerprint,
 * so the matcher is asked; the image runs without a usable model key, the
 * call fails, and the report takes the outage path (service.ts, "Matcher
 * outage"): accepted on a stand-in cluster, which the status names too.
 *
 * Usage: bun apps/bug-intake/scripts/image-smoke.ts <intake base url>
 */

import { BugIntakeClient } from "@caelo-cms/admin-core";
import type { BugIntakeReport } from "@caelo-cms/shared";

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("usage: image-smoke.ts <intake base url>");

const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const identity = {
  installId: crypto.randomUUID(),
  publicKey: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64"),
  privateKeyPkcs8: Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
    "base64",
  ),
};
const report = (fingerprint: string): BugIntakeReport => ({
  protocolVersion: 1,
  reportId: crypto.randomUUID(),
  caeloVersion: "0.12.0",
  fingerprint: fingerprint.repeat(64),
  source: "auto",
  kind: "defect",
  severity: "degraded",
  blockedTask: false,
  suspectedTool: "build_page",
  title: "Image smoke report",
  whatHappened: "The bug intake image smoke test sent this report.",
  expected: "It is accepted.",
  evidence: null,
});

const client = new BugIntakeClient({
  baseUrl,
  // Cloud Run's front end appends the caller's address (#1339), and the
  // intake refuses a request without one.
  fetchImpl: ((url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.append("x-forwarded-for", "203.0.113.9");
    return fetch(url, { ...init, headers });
  }) as typeof fetch,
});
const step = <T>(what: string, r: { kind: string; error?: string; value?: T }): T => {
  if (r.kind !== "ok") throw new Error(`${what}: ${r.kind} ${r.error ?? ""}`);
  console.log(`[image-smoke] ${what}: ok`);
  return r.value as T;
};

step("register", await client.register(identity));
const first = step("first report", await client.sendReport(identity, report("e")));
const second = step("second report", await client.sendReport(identity, report("d")));
if (second.clusterId === first.clusterId) {
  throw new Error(`two fingerprints landed in one cluster without a match: ${first.clusterId}`);
}
const ids = [first.clusterId, second.clusterId];
const status = step("status", await client.clusterStatus(identity, ids));
const answered = status.map((c) => c.clusterId).sort();
if (JSON.stringify(answered) !== JSON.stringify([...ids].sort())) {
  throw new Error(`status did not name both clusters: ${JSON.stringify(status)}`);
}
console.log(`[image-smoke] the image registered, stored and answered for ${ids.join(", ")}`);
