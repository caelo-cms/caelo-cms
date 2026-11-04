// SPDX-License-Identifier: MPL-2.0

/**
 * #1330 — the DNS records the staging host needs, for Settings → Updates.
 *
 * Since the staging cutover the staging host is served by the staging
 * gateway on every provider, through its own edge (provisioning
 * staging-gateway-setup.ts): on gcp-firebase it is the custom domain of the
 * second Hosting site, whose records Hosting names itself; on gcp it shares
 * the site's load balancer; on self-hosted, Caddy on the same server. The
 * converge prints the records once; this page keeps showing them, so the
 * Owner can change DNS without a terminal (E13 a of #763).
 *
 * Read-only. gcp-firebase reads the custom domain of the staging site
 * (`CAELO_FIREBASE_STAGING_SITE`) with the admin's own Hosting rights; the
 * other providers need no lookup: their record follows the site's.
 */

/** One record to set at the registrar. */
export interface StagingDnsRecord {
  readonly name: string;
  readonly type: string;
  readonly value: string;
}

/** What Settings → Updates shows for the staging host. */
export type StagingHostDns =
  | {
      readonly kind: "records";
      readonly host: string;
      readonly records: readonly StagingDnsRecord[];
      /** Hosting's view: whether the host already points at it and has its certificate. */
      readonly active: boolean;
    }
  /** No lookup needed: the record follows the site's (`sameAs` is the live site's host). */
  | { readonly kind: "same-as-site"; readonly host: string; readonly sameAs: string }
  | { readonly kind: "unavailable"; readonly host: string; readonly reason: string }
  | { readonly kind: "unsupported"; readonly host: string };

/** The env var naming the gcp-firebase staging Hosting site (stack-contract.ts). */
export const FIREBASE_STAGING_SITE_ENV = "CAELO_FIREBASE_STAGING_SITE";

const FIREBASE_HOSTING_API = "https://firebasehosting.googleapis.com/v1beta1";

interface FirebaseCustomDomainDns {
  readonly hostState?: string;
  readonly ownershipState?: string;
  readonly cert?: { readonly state?: string };
  readonly requiredDnsUpdates?: {
    readonly desired?: readonly {
      readonly records?: readonly {
        readonly domainName?: string;
        readonly type?: string;
        readonly rdata?: string;
      }[];
    }[];
  };
}

/** The records a Firebase custom domain asks for. */
export function desiredRecords(domain: FirebaseCustomDomainDns | null): StagingDnsRecord[] {
  return (domain?.requiredDnsUpdates?.desired ?? []).flatMap((set) =>
    (set.records ?? []).flatMap((r) =>
      r.domainName && r.type && r.rdata
        ? [{ name: r.domainName.replace(/\.$/, ""), type: r.type, value: r.rdata }]
        : [],
    ),
  );
}

/** Dependencies, for tests. */
export interface StagingHostDnsDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** GET one Hosting API path; null on 404. */
  readonly fetchHosting?: (path: string) => Promise<unknown | null>;
}

async function defaultFetchHosting(path: string): Promise<unknown | null> {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;
  if (!token) throw new Error("could not obtain an access token for Firebase Hosting");
  const res = await fetch(`${FIREBASE_HOSTING_API}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firebase Hosting answered HTTP ${res.status}`);
  return res.json();
}

async function projectId(env: Readonly<Record<string, string | undefined>>): Promise<string> {
  const fromEnv = env.GOOGLE_CLOUD_PROJECT ?? env.CAELO_PROVIDER_PROJECT;
  if (fromEnv) return fromEnv;
  const { GoogleAuth } = await import("google-auth-library");
  const id = await new GoogleAuth().getProjectId();
  if (!id) throw new Error("the Google Cloud project is unknown");
  return id;
}

/**
 * What the staging host needs in DNS on this install.
 *
 * @param host - the stored staging host (`staging_access.staging_host`)
 * @param siteHost - the live site's host, which the gcp / self-hosted record follows
 */
export async function readStagingHostDns(
  host: string,
  siteHost: string,
  deps: StagingHostDnsDeps = {},
): Promise<StagingHostDns> {
  const env = deps.env ?? process.env;
  // An unset provider is a development checkout, not self-hosted: it
  // serves no staging host, so there is no record to show.
  const provider = env.CAELO_PROVIDER;
  if (provider === "gcp" || provider === "self-hosted") {
    return { kind: "same-as-site", host, sameAs: siteHost };
  }
  if (provider !== "gcp-firebase") return { kind: "unsupported", host };
  const site = env[FIREBASE_STAGING_SITE_ENV];
  if (!site) {
    return {
      kind: "unavailable",
      host,
      reason: `the admin has no ${FIREBASE_STAGING_SITE_ENV}; install the update that sets up the staging gateway`,
    };
  }
  try {
    const project = await projectId(env);
    const fetchHosting = deps.fetchHosting ?? defaultFetchHosting;
    const domain = (await fetchHosting(
      `projects/${encodeURIComponent(project)}/sites/${encodeURIComponent(site)}/customDomains/${encodeURIComponent(host)}`,
    )) as FirebaseCustomDomainDns | null;
    if (!domain) {
      return {
        kind: "unavailable",
        host,
        reason: `${host} is not set up on the staging site yet; installing the update (or \`cms-provision staging-domain enable\`) adds it`,
      };
    }
    return {
      kind: "records",
      host,
      records: desiredRecords(domain),
      active: domain.hostState === "HOST_ACTIVE" && domain.ownershipState === "OWNERSHIP_ACTIVE",
    };
  } catch (e) {
    return { kind: "unavailable", host, reason: e instanceof Error ? e.message : String(e) };
  }
}
