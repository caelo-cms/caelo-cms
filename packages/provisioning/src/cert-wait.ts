// SPDX-License-Identifier: MPL-2.0

/**
 * Waiting for a Google-managed TLS certificate (§11.C: the CLI polls certs
 * itself instead of telling the operator to check back later).
 *
 * Two certificate sources, one wait loop:
 *   - the `gcp` load balancer's managed SSL certificates
 *     ({@link lbCertProbe}) — the installer waits for the admin host;
 *   - a Cloud Run domain mapping's certificate ({@link domainMappingProbe})
 *     — `admin-domain enable` / `staging-domain enable` on gcp-firebase.
 *
 * {@link waitForCert} is pure apart from its injected clock, sleep and
 * probe, so the timeout and progress behaviour is unit-tested without
 * gcloud or real time.
 */

import type { GcloudResult } from "./gcloud.js";

type Run = (args: string[]) => Promise<GcloudResult>;

/** One look at a certificate. */
export type CertProbe =
  | { readonly state: "ready" }
  | { readonly state: "pending"; readonly detail: string }
  /** gcloud itself failed (auth, permissions) — waiting will not fix it. */
  | { readonly state: "error"; readonly error: string };

export type CertWaitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "timeout"; readonly lastDetail: string }
  | { readonly ok: false; readonly reason: "error"; readonly error: string };

export interface CertWaitOpts {
  readonly probe: () => Promise<CertProbe>;
  readonly timeoutMs: number;
  readonly intervalMs: number;
  /** Called whenever the probe's detail text changes (spinner message). */
  readonly onUpdate?: (detail: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Poll `probe` until the certificate is ready, gcloud fails, or `timeoutMs`
 * passes. The probe runs once more at the deadline so a certificate that
 * flips during the last interval is not reported as a timeout.
 */
export async function waitForCert(opts: CertWaitOpts): Promise<CertWaitResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + opts.timeoutMs;
  let lastDetail = "";
  for (;;) {
    const p = await opts.probe();
    if (p.state === "ready") return { ok: true };
    if (p.state === "error") return { ok: false, reason: "error", error: p.error };
    if (p.detail !== lastDetail) {
      lastDetail = p.detail;
      opts.onUpdate?.(p.detail);
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { ok: false, reason: "timeout", lastDetail };
    await sleep(Math.min(opts.intervalMs, remaining));
  }
}

interface MappingCondition {
  type?: string;
  status?: string;
  message?: string;
  reason?: string;
}

/**
 * The certificate state of the Cloud Run domain mapping for `hostname`.
 * Ready once the mapping's `Ready` condition is True (Google sets it after
 * `CertificateProvisioned` and `DomainRoutable`); until then the detail is
 * the first non-True condition's message, which says what Google waits for
 * (usually the DNS record).
 */
export async function domainMappingProbe(
  run: Run,
  target: { readonly hostname: string; readonly region: string; readonly projectId: string },
): Promise<CertProbe> {
  const r = await run([
    "beta",
    "run",
    "domain-mappings",
    "describe",
    `--domain=${target.hostname}`,
    `--region=${target.region}`,
    `--project=${target.projectId}`,
    "--format=json",
  ]);
  if (!r.ok) return { state: "error", error: `describe the domain mapping: ${r.stderr.trim()}` };
  const conditions =
    (JSON.parse(r.stdout) as { status?: { conditions?: MappingCondition[] } }).status?.conditions ??
    [];
  const ready = conditions.find((c) => c.type === "Ready");
  if (ready?.status === "True") return { state: "ready" };
  const blocking =
    conditions.find((c) => c.type === "CertificateProvisioned" && c.status !== "True") ??
    conditions.find((c) => c.status !== "True");
  const detail = blocking
    ? `${blocking.type}: ${blocking.message || blocking.reason || blocking.status || "pending"}`
    : "Google has not reported the mapping's status yet";
  return { state: "pending", detail };
}

interface SslCertificateJson {
  name?: string;
  managed?: { status?: string; domainStatus?: Record<string, string> };
}

/**
 * Whether the `gcp` load balancer has an ACTIVE managed certificate that
 * covers `hostname`. Any such certificate counts: installs from before the
 * admin got its own certificate serve the admin from the combined one.
 * A certificate is only served once its overall status is ACTIVE, so a
 * combined certificate whose other domain still fails does not count.
 */
export async function lbCertProbe(
  run: Run,
  target: { readonly projectId: string; readonly hostname: string },
): Promise<CertProbe> {
  const r = await run([
    "compute",
    "ssl-certificates",
    "list",
    "--global",
    `--project=${target.projectId}`,
    "--format=json",
  ]);
  if (!r.ok) return { state: "error", error: `list SSL certificates: ${r.stderr.trim()}` };
  const covering = (JSON.parse(r.stdout) as SslCertificateJson[]).filter(
    (c) => c.managed?.domainStatus?.[target.hostname] !== undefined,
  );
  if (
    covering.some(
      (c) =>
        c.managed?.status === "ACTIVE" && c.managed.domainStatus?.[target.hostname] === "ACTIVE",
    )
  ) {
    return { state: "ready" };
  }
  if (covering.length === 0) {
    return { state: "pending", detail: `no managed certificate lists ${target.hostname} yet` };
  }
  const detail = covering
    .map(
      (c) =>
        `${c.name ?? "certificate"}: ${target.hostname} ${c.managed?.domainStatus?.[target.hostname]}`,
    )
    .join("; ");
  return { state: "pending", detail };
}

/**
 * How long the CLI waits for a certificate before handing the operator the
 * status command. Google documents up to 60 min after DNS resolves.
 */
export const CERT_WAIT_TIMEOUT_MS = 60 * 60 * 1000;
