// SPDX-License-Identifier: MPL-2.0

/**
 * #1338 (gateway hardening L6) — converge a Cloud SQL install to
 * `sslmode=verify-full` through gcloud, the way `cms-provision upgrade`
 * converges everything else (stack-converge.ts; it never runs Pulumi).
 *
 * Verify-full checks the server certificate's chain AND that it names the
 * host the client dialled. On Cloud SQL that needs three things the stacks
 * declare for a new install (stacks/gcp, stacks/gcp-firebase) and this
 * module brings an existing one to:
 *
 *   1. The shared server CA (`GOOGLE_MANAGED_CAS_CA`): "The SAN field
 *      contains the hostname (DNS name of the instance) for all types of
 *      instances", while the default per-instance CA names one "only for
 *      instances enabled with Private Service Connect"
 *      (docs.cloud.google.com/sql/docs/postgres/authorize-ssl). An instance
 *      may move from per-instance to shared, not back. After the move the
 *      instance needs a server certificate from the new CA: "create a new
 *      server certificate with `gcloud sql ssl server-certs create`", then
 *      "complete the rotation with `gcloud sql ssl server-certs rotate`"
 *      (docs.cloud.google.com/sql/docs/postgres/manage-ssl-instance). The
 *      rotation restarts nothing a client keeps: open connections drop and
 *      reconnect; every client already uses TLS (`sslmode=require` before).
 *      `sslMode=ENCRYPTED_ONLY` refuses plaintext from then on.
 *   2. Resolution of the instance's DNS name (`dnsNames`, the
 *      PRIVATE_SERVICES_ACCESS entry, `….sql-psa.goog`) inside the VPC:
 *      "create the DNS record in a private DNS zone in the corresponding
 *      Virtual Private Cloud (VPC) network"
 *      (docs.cloud.google.com/sql/docs/postgres/configure-ssl-instance).
 *   3. The services dialling that name. They read it from their own
 *      `*_DATABASE_URL`, and so does every job the upgrade derives from the
 *      admin's (migrations, upgrader, operator access): {@link
 *      moveServicesToDnsHost} switches the host of the live URLs first,
 *      keeping their current `sslmode`, so the old image keeps working until
 *      the roll sets verify-full with the image that carries the CA bundle.
 *
 * The CA the clients trust is Google's published shared-CA bundle, shipped
 * in every image (shared database-tls.ts `CLOUD_SQL_CA_BUNDLE`): it covers
 * the root and every regional CA, so a server-certificate rotation needs no
 * change on the client side.
 *
 * Every step reads before it writes and is a no-op when already in shape,
 * so a re-run after a failure picks up where the last one stopped.
 */

import { isIpLiteral } from "@caelo-cms/shared";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import type { HttpFetch } from "./runtime-secrets.js";
import {
  CLOUD_SQL_SERVER_CA_MODE,
  CLOUD_SQL_SSL_MODE,
  cloudSqlDnsZoneName,
  cloudSqlPrivateDnsName,
} from "./stack-contract.js";
import type { LiveEnvValue } from "./stack-converge.js";

/** The install's Cloud SQL instance. */
export interface CloudSqlTlsTarget {
  readonly projectId: string;
  readonly env: string;
  readonly sqlInstance: string;
}

export interface CloudSqlTlsDeps {
  readonly run: GcloudRunner;
  readonly http?: HttpFetch;
  readonly sleep?: Sleep;
}

export type CloudSqlTlsResult =
  | { readonly ok: true; readonly host: string; readonly done: string[] }
  | { readonly ok: false; readonly error: string; readonly done: string[] };

/** The parts of `gcloud sql instances describe --format=json` this module and converge-db-trust.ts read. */
export interface InstanceDescription {
  /** The CA of the instance's current server certificate (PEM in `cert`). */
  readonly serverCaCert?: { readonly cert?: string };
  readonly settings?: {
    readonly ipConfiguration?: {
      readonly serverCaMode?: string;
      readonly sslMode?: string;
      readonly privateNetwork?: string;
    };
  };
  readonly ipAddresses?: readonly { readonly type?: string; readonly ipAddress?: string }[];
  readonly dnsNames?: readonly { readonly name?: string; readonly connectionType?: string }[];
}

const NOT_FOUND = /NOT_FOUND|not found|does not exist|404/i;
const SQL_ADMIN = "https://sqladmin.googleapis.com/v1";

/** `gcloud sql instances describe` of the install's instance, parsed. */
export async function describeInstance(
  t: CloudSqlTlsTarget,
  run: GcloudRunner,
): Promise<{ ok: true; d: InstanceDescription } | { ok: false; error: string }> {
  const r = await run([
    "sql",
    "instances",
    "describe",
    t.sqlInstance,
    `--project=${t.projectId}`,
    "--format=json",
  ]);
  if (!r.ok) return { ok: false, error: `describe ${t.sqlInstance}: ${r.stderr.trim()}` };
  try {
    return { ok: true, d: JSON.parse(r.stdout) as InstanceDescription };
  } catch {
    return { ok: false, error: `describe ${t.sqlInstance}: gcloud printed no JSON` };
  }
}

/** The instance's server certificates and which one is active (Cloud SQL Admin API). */
export async function listServerCertificates(
  t: CloudSqlTlsTarget,
  run: GcloudRunner,
  http: HttpFetch,
): Promise<
  { ok: true; activeVersion: string | null; fingerprints: string[] } | { ok: false; error: string }
> {
  const token = await run(["auth", "print-access-token"]);
  const bearer = token.ok ? token.stdout.trim() : "";
  if (!bearer)
    return { ok: false, error: `gcloud auth print-access-token: ${token.stderr.trim()}` };
  const res = await http(
    `${SQL_ADMIN}/projects/${encodeURIComponent(t.projectId)}/instances/${encodeURIComponent(t.sqlInstance)}/listServerCertificates`,
    { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
  );
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      error: `list server certificates: HTTP ${res.status} ${text.slice(0, 300)}`,
    };
  }
  const body = JSON.parse(text) as {
    activeVersion?: string;
    serverCerts?: { sha1Fingerprint?: string }[];
  };
  return {
    ok: true,
    activeVersion: body.activeVersion ?? null,
    fingerprints: (body.serverCerts ?? []).map((c) => c.sha1Fingerprint ?? "").filter(Boolean),
  };
}

/**
 * Bring the instance to verify-full: shared CA with an active server
 * certificate from it, encrypted connections only, its DNS name resolving
 * in the VPC. Returns the host every client must dial.
 */
export async function ensureCloudSqlVerifyFull(
  t: CloudSqlTlsTarget,
  deps: CloudSqlTlsDeps,
): Promise<CloudSqlTlsResult> {
  const sleep = deps.sleep ?? realSleep;
  const run = (args: string[]) => runWithRetry(deps.run, sleep, args);
  const http = deps.http ?? (fetch as unknown as HttpFetch);
  const done: string[] = [];
  const fail = (error: string): CloudSqlTlsResult => ({ ok: false, error, done });
  const project = `--project=${t.projectId}`;

  let described = await describeInstance(t, run);
  if (!described.ok) return fail(described.error);
  const ip = described.d.settings?.ipConfiguration;
  const patch: string[] = [];
  if (ip?.serverCaMode !== CLOUD_SQL_SERVER_CA_MODE) {
    patch.push(`--server-ca-mode=${CLOUD_SQL_SERVER_CA_MODE}`);
  }
  if (ip?.sslMode !== CLOUD_SQL_SSL_MODE) patch.push(`--ssl-mode=${CLOUD_SQL_SSL_MODE}`);
  if (patch.length > 0) {
    const r = await run(["sql", "instances", "patch", t.sqlInstance, project, ...patch, "--quiet"]);
    if (!r.ok) return fail(`patch ${t.sqlInstance} (${patch.join(" ")}): ${r.stderr.trim()}`);
    done.push(`Cloud SQL ${t.sqlInstance}: ${patch.join(" ")}`);
    // The instance reports its DNS name only once it uses the shared CA, so
    // the description from before the patch cannot name the host.
    described = await describeInstance(t, run);
    if (!described.ok) return fail(described.error);
  }

  // The active server certificate must come from the shared CA. Before the
  // move there is none in the list the shared CA keeps; after an
  // interrupted run there may be an upcoming one that was never rotated in.
  const certs = await listServerCertificates(t, run, http);
  if (!certs.ok) return fail(certs.error);
  const activeShared =
    certs.activeVersion !== null && certs.fingerprints.includes(certs.activeVersion);
  if (!activeShared) {
    const upcoming = certs.fingerprints.filter((f) => f !== certs.activeVersion);
    if (upcoming.length === 0) {
      const c = await run([
        "sql",
        "ssl",
        "server-certs",
        "create",
        `--instance=${t.sqlInstance}`,
        project,
      ]);
      if (!c.ok) return fail(`create a server certificate: ${c.stderr.trim()}`);
      done.push(`Cloud SQL ${t.sqlInstance}: server certificate from the shared CA created`);
    }
    const rot = await run([
      "sql",
      "ssl",
      "server-certs",
      "rotate",
      `--instance=${t.sqlInstance}`,
      project,
      "--quiet",
    ]);
    if (!rot.ok) return fail(`rotate to the shared-CA server certificate: ${rot.stderr.trim()}`);
    done.push(`Cloud SQL ${t.sqlInstance}: rotated onto the shared-CA server certificate`);
    described = await describeInstance(t, run);
    if (!described.ok) return fail(described.error);
  }

  const host = cloudSqlPrivateDnsName(described.d.dnsNames);
  if (!host) {
    return fail(
      `${t.sqlInstance} reports no PRIVATE_SERVICES_ACCESS DNS name (dnsNames) although it uses the shared CA; verify-full needs it. Check the instance's private IP configuration and re-run.`,
    );
  }
  const privateIp = described.d.ipAddresses?.find((a) => a.type === "PRIVATE")?.ipAddress;
  if (!privateIp) return fail(`${t.sqlInstance} has no private IP address`);
  const network = ip?.privateNetwork?.split("/").pop();
  if (!network) return fail(`${t.sqlInstance} names no private network`);

  const zone = cloudSqlDnsZoneName(t.env);
  const fqdn = `${host}.`;
  const z = await run(["dns", "managed-zones", "describe", zone, project, "--format=json"]);
  if (z.ok) {
    const existing = (JSON.parse(z.stdout) as { dnsName?: string }).dnsName?.toLowerCase();
    if (existing !== fqdn) {
      return fail(
        `the private DNS zone ${zone} serves ${existing ?? "(no name)"}, not the instance's DNS name ${fqdn}. If the instance was replaced, delete the zone (gcloud dns managed-zones delete ${zone} ${project}) after removing its records, then re-run.`,
      );
    }
  } else if (NOT_FOUND.test(z.stderr)) {
    const c = await run([
      "dns",
      "managed-zones",
      "create",
      zone,
      project,
      `--dns-name=${fqdn}`,
      "--visibility=private",
      `--networks=${network}`,
      `--description=Caelo ${t.env}: the Cloud SQL instance's DNS name inside the VPC (#1338)`,
    ]);
    if (!c.ok) return fail(`create the private DNS zone ${zone}: ${c.stderr.trim()}`);
    done.push(`private DNS zone ${zone} (${fqdn}) on network ${network}`);
  } else {
    return fail(`describe the private DNS zone ${zone}: ${z.stderr.trim()}`);
  }

  const rec = ["dns", "record-sets"];
  const where = [fqdn, `--zone=${zone}`, "--type=A", project];
  const a = await run([...rec, "describe", ...where, "--format=json"]);
  if (a.ok) {
    const rrdatas = (JSON.parse(a.stdout) as { rrdatas?: string[] }).rrdatas ?? [];
    if (rrdatas.length !== 1 || rrdatas[0] !== privateIp) {
      const u = await run([...rec, "update", ...where, "--ttl=300", `--rrdatas=${privateIp}`]);
      if (!u.ok) return fail(`update the A record of ${fqdn}: ${u.stderr.trim()}`);
      done.push(`DNS ${fqdn} A ${rrdatas.join(",") || "(none)"} → ${privateIp}`);
    }
  } else if (NOT_FOUND.test(a.stderr)) {
    const c = await run([...rec, "create", ...where, "--ttl=300", `--rrdatas=${privateIp}`]);
    if (!c.ok) return fail(`create the A record of ${fqdn}: ${c.stderr.trim()}`);
    done.push(`DNS ${fqdn} A ${privateIp}`);
  } else {
    return fail(`describe the A record of ${fqdn}: ${a.stderr.trim()}`);
  }
  return { ok: true, host, done };
}

/** The plain values of `names` in a service's live env (secret refs and unset vars skipped). */
export function liveDatabaseUrls(
  liveEnv: ReadonlyMap<string, LiveEnvValue>,
  names: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = liveEnv.get(name);
    if (v?.kind === "value" && v.value) out[name] = v.value;
  }
  return out;
}

/** Whether a database URL dials an IP literal (an unparsable one does not). */
export function dialsIpAddress(url: string): boolean {
  try {
    return isIpLiteral(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * `url` with its host replaced by `host`, everything else kept — or null
 * when it already dials a host name (nothing to move).
 */
export function urlOnDnsHost(url: string, host: string): string | null {
  const parsed = new URL(url);
  if (!isIpLiteral(parsed.hostname)) return null;
  parsed.hostname = host;
  return parsed.toString();
}

/**
 * Switch the live database URLs of `services` from the instance's IP to
 * `host`, keeping their `sslmode` (the running image may not carry the CA
 * bundle yet; the roll sets verify-full with the image that does). Every
 * reader of the database host — the rolls, the migration job, the upgrader
 * and operator-access jobs — takes it from these URLs, so after this they
 * all dial the name the server's certificate carries.
 *
 * @param liveUrls the plain URL values each service carries now
 */
export async function moveServicesToDnsHost(
  target: { readonly projectId: string; readonly region: string },
  services: readonly {
    readonly serviceName: string;
    readonly liveUrls: Readonly<Record<string, string>>;
  }[],
  host: string,
  deps: CloudSqlTlsDeps,
): Promise<{ ok: true; done: string[] } | { ok: false; error: string; done: string[] }> {
  const sleep = deps.sleep ?? realSleep;
  const done: string[] = [];
  for (const s of services) {
    const moved = Object.entries(s.liveUrls)
      .map(([name, url]) => [name, urlOnDnsHost(url, host)] as const)
      .filter((e): e is readonly [string, string] => e[1] !== null);
    if (moved.length === 0) continue;
    const r = await runWithRetry(deps.run, sleep, [
      "run",
      "services",
      "update",
      s.serviceName,
      "--region",
      target.region,
      `--project=${target.projectId}`,
      // ^|^ — the values carry `&` and `=`; a custom delimiter keeps gcloud
      // from splitting them.
      `--update-env-vars=^|^${moved.map(([n, u]) => `${n}=${u}`).join("|")}`,
      "--quiet",
    ]);
    if (!r.ok) {
      return {
        ok: false,
        error: `move ${s.serviceName} onto the database's DNS name: ${r.stderr.trim()}`,
        done,
      };
    }
    done.push(`${s.serviceName}: ${moved.map(([n]) => n).join(", ")} → ${host}`);
  }
  return { ok: true, done };
}
