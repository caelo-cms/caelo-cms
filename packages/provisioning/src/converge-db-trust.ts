// SPDX-License-Identifier: MPL-2.0

/**
 * #1373 — where the converge job (#819) opens its database queue, and whom
 * it trusts there, BEFORE the install's database TLS step (#1338) ran.
 *
 * The job writes the update timeline and the request's end through that
 * queue. Its code connects with verify-full only, which needs the
 * instance's DNS name, and on an install whose services still dial the
 * instance's IP the DNS name exists only once the TLS step has run. When
 * the job ran that step before opening the queue, a failure of the step
 * reached only the job's log: Settings → Updates showed "Interrupted" and
 * nothing else. So the job first opens the queue on the host the install
 * dials today and runs the TLS step as a timeline step of its own
 * (converge-job.ts `secureDatabase`).
 *
 * Dialling an IP, the host-name half of verify-full cannot hold (the
 * certificate names no IP). The connection must still authenticate the
 * server: the job's password is the provisioner's access token, worth far
 * more than a database password, so `sslmode=require` (encrypted, server
 * unchecked) is not an option. The trust comes from the Cloud SQL Admin
 * API, over an authenticated channel, about this one instance:
 *
 *   - per-instance CA (`GOOGLE_MANAGED_INTERNAL_CA`, the default before
 *     #1338): the instance's own server CA (`serverCaCert`). Nobody else
 *     holds a certificate from it, so a verified chain is this instance.
 *   - shared CA (`GOOGLE_MANAGED_CAS_CA`): always pinned, because the
 *     shared CA signs other customers' instances too. With its certificate
 *     active: Google's shared-CA bundle (the one every image ships) and the
 *     fingerprints `listServerCertificates` names; not rotated in yet: the
 *     one certificate the API names active. A listing that does not name
 *     the active certificate with a well-formed fingerprint is refused —
 *     fail closed, never a guess.
 *   - any other CA mode: refused.
 *
 * No input but the metadata server's placement and the APIs: the job's
 * scrubbed-environment contract (§11.C) is unchanged.
 */

import { readFileSync } from "node:fs";
import { CLOUD_SQL_CA_BUNDLE, isIpLiteral } from "@caelo-cms/shared";
import { z } from "zod";
import { describeInstance } from "./cloudsql-tls.js";
import { findSqlInstance } from "./gateway-credentials.js";
import { gcloud } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import { GCP_STACK_ENV } from "./gcp-names.js";
import type { HttpFetch } from "./runtime-secrets.js";
import { CLOUD_SQL_SERVER_CA_MODE } from "./stack-contract.js";
import { type UpgraderPlacement, upgraderDatabaseHost } from "./upgrader-gcp.js";

/** How the converge job reaches the database. */
export type ConvergeDatabaseTarget =
  /** The services dial the DNS name already: verify-full, nothing to set up. */
  | { readonly kind: "dns"; readonly host: string }
  /**
   * The services dial the instance's IP: connect there, verify the chain
   * against `caPem` and, when `pinnedSha1` is set, the certificate's
   * fingerprint (lower-case hex, no colons) against it.
   */
  | {
      readonly kind: "ip";
      readonly host: string;
      readonly caPem: string;
      readonly pinnedSha1: readonly string[] | null;
    };

export interface ConvergeDatabaseTargetDeps {
  readonly run?: GcloudRunner;
  readonly http?: HttpFetch;
  /** The shipped shared-CA bundle (tests pass their own). */
  readonly readSharedCaBundle?: () => string;
}

/** A SHA-1 fingerprint as hex without separators, lower case (`AB:CD…` and `abcd…` compare equal). */
export function normalizedSha1(fingerprint: string): string {
  return fingerprint.replace(/[^0-9a-f]/gi, "").toLowerCase();
}

/**
 * The host the install dials today and, when it is the instance's IP, the
 * server identity the converge job's connection must verify there. Throws
 * with what could not be read: without it the job must not connect.
 */
export async function convergeDatabaseTarget(
  placement: Pick<UpgraderPlacement, "projectId" | "region">,
  deps: ConvergeDatabaseTargetDeps = {},
): Promise<ConvergeDatabaseTarget> {
  const run = deps.run ?? gcloud;
  const host = await upgraderDatabaseHost(placement, run);
  if (!isIpLiteral(host)) return { kind: "dns", host };
  const install = { projectId: placement.projectId, env: GCP_STACK_ENV };
  const lookup = await findSqlInstance(install, { run });
  if (lookup.status !== "found") {
    throw new Error(`could not find the install's Cloud SQL instance (${lookup.status})`);
  }
  const target = { ...install, sqlInstance: lookup.name };
  const described = await describeInstance(target, run);
  if (!described.ok) throw new Error(described.error);
  const d = described.d;
  const mode = d.settings?.ipConfiguration?.serverCaMode;
  const ownCa = d.serverCaCert?.cert?.trim() || null;
  if (mode === CLOUD_SQL_SERVER_CA_MODE) {
    const listing = await serverCertificateListing(
      target,
      run,
      deps.http ?? (fetch as unknown as HttpFetch),
    );
    // Fail closed: once the shared CA may be active, every connection is
    // pinned to a certificate the API names — the shared CA alone would
    // also vouch for other customers' instances.
    const sharedBundle = (
      deps.readSharedCaBundle ?? (() => readFileSync(CLOUD_SQL_CA_BUNDLE, "utf8"))
    )();
    if (listing.fingerprints.includes(listing.active)) {
      return { kind: "ip", host, caPem: sharedBundle, pinnedSha1: listing.fingerprints };
    }
    // Moved to the shared CA, its certificate not rotated in yet: the
    // server still presents the active one from its own CA. Pinned to
    // exactly that certificate, so which CA vouches for it does not widen
    // what is accepted.
    const caPem = [ownCa, sharedBundle].filter((c): c is string => Boolean(c)).join("\n");
    return { kind: "ip", host, caPem, pinnedSha1: [listing.active] };
  }
  // Per-instance CA (the default, which older instances do not name):
  // nobody else holds a certificate from it, so the verified chain is this
  // instance. Any other mode (a customer-managed CA) is not one this job
  // can reason about.
  if (mode !== undefined && mode !== PER_INSTANCE_CA_MODE) {
    throw new Error(
      `${lookup.name} uses the server CA mode ${mode}, which the converge job cannot verify a connection to ${host} for`,
    );
  }
  if (!ownCa) {
    throw new Error(
      `${lookup.name} names no server CA certificate (serverCaCert), so the connection to ${host} could not be verified`,
    );
  }
  return { kind: "ip", host, caPem: ownCa, pinnedSha1: null };
}

/** Cloud SQL's default per-instance server CA mode. */
const PER_INSTANCE_CA_MODE = "GOOGLE_MANAGED_INTERNAL_CA";

const SHA1_HEX = /^[0-9a-f]{40}$/;

/**
 * The Admin API's `listServerCertificates` answer, validated: the active
 * certificate's fingerprint and every listed one, normalized. Throws on
 * anything else — a missing `activeVersion`, a certificate without a
 * well-formed fingerprint — since a guessed listing would be a guessed
 * trust decision.
 */
async function serverCertificateListing(
  t: { readonly projectId: string; readonly sqlInstance: string },
  run: GcloudRunner,
  http: HttpFetch,
): Promise<{ readonly active: string; readonly fingerprints: readonly string[] }> {
  const token = await run(["auth", "print-access-token"]);
  const bearer = token.ok ? token.stdout.trim() : "";
  if (!bearer) throw new Error(`gcloud auth print-access-token: ${token.stderr.trim()}`);
  const res = await http(
    `https://sqladmin.googleapis.com/v1/projects/${encodeURIComponent(t.projectId)}/instances/${encodeURIComponent(t.sqlInstance)}/listServerCertificates`,
    { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`list server certificates: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("list server certificates: the Cloud SQL Admin API answered no JSON");
  }
  const parsed = ListingSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `list server certificates: the answer does not name the active certificate and the listed ones with SHA-1 fingerprints (${parsed.error.issues[0]?.message ?? "invalid"}), so the connection is not trusted`,
    );
  }
  return {
    active: parsed.data.activeVersion,
    fingerprints: parsed.data.serverCerts.map((c) => c.sha1Fingerprint),
  };
}

const Sha1 = z
  .string()
  .transform(normalizedSha1)
  .refine((f) => SHA1_HEX.test(f), "a SHA-1 fingerprint");

const ListingSchema = z.object({
  activeVersion: Sha1,
  // Before the first shared-CA certificate exists the API may list none.
  serverCerts: z.array(z.object({ sha1Fingerprint: Sha1 })).default([]),
});

/**
 * Why a server certificate with `fingerprint` (as `node:tls` prints it) is
 * not the instance `target` names, or null when it is. Only for an `ip`
 * target; the chain itself is checked against `caPem` by the TLS layer.
 */
export function serverIdentityProblem(
  target: Extract<ConvergeDatabaseTarget, { kind: "ip" }>,
  fingerprint: string,
): string | null {
  if (target.pinnedSha1 === null) return null;
  return target.pinnedSha1.includes(normalizedSha1(fingerprint))
    ? null
    : `the database at ${target.host} presented a certificate (SHA-1 ${normalizedSha1(fingerprint)}) that the Cloud SQL Admin API does not list for this install's instance`;
}
