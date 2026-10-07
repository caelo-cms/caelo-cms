// SPDX-License-Identifier: MPL-2.0

/**
 * Operator access on Google IAP installs (`gcp`, `gcp-firebase`).
 *
 * The admin sits behind Identity-Aware Proxy (CLAUDE.md §11.B Tier 2), so a
 * Caelo user only reaches the login page once Google lets them through. Two
 * bindings make up "may use this admin", in a browser and over MCP:
 *
 *   1. `roles/iap.httpsResourceAccessor` on the admin's IAP resource — the
 *      Cloud Run service (gcp-firebase) or the LB backend service (gcp);
 *   2. `roles/iam.serviceAccountTokenCreator` on the MCP service account
 *      (`caelo-mcp@<project>`), whose signed JWT is how MCP clients pass IAP
 *      (packages/mcp-server/src/ingress-auth.ts).
 *
 * The admin writes them itself, as its own runtime service account, via the
 * IAP and IAM REST APIs. The stacks (and `cms-provision upgrade` for older
 * installs) give that account exactly what this needs and no more: a custom
 * role holding only get/setIamPolicy, bound on those two resources, plus on
 * `gcp` the right to list backend services to find the admin's one (see
 * packages/provisioning/src/operator-access-grants.ts).
 */

import { type IamPolicy, withMember } from "./iam-policy.js";

export const IAP_ACCESSOR_ROLE = "roles/iap.httpsResourceAccessor";
export const TOKEN_CREATOR_ROLE = "roles/iam.serviceAccountTokenCreator";

/** An access change that could not be made, with what to do about it. */
export class OperatorAccessError extends Error {
  constructor(
    message: string,
    readonly nextStep: string,
  ) {
    super(message);
    this.name = "OperatorAccessError";
  }
}

/** Grants or revokes one principal's access to the admin. */
export interface OperatorAccessBackend {
  /** Human-readable target, e.g. "Google IAP on Cloud Run service caelo-…". */
  readonly label: string;
  /** Throws {@link OperatorAccessError} when the change cannot be made. */
  setAccess(principal: string, allow: boolean): Promise<void>;
}

export interface GcpIapEnv {
  readonly CAELO_PROVIDER?: string;
  readonly CAELO_ENV?: string;
  /** Set by Cloud Run on every instance: the admin's own service name. */
  readonly K_SERVICE?: string;
  readonly CAELO_MCP_IAP_SERVICE_ACCOUNT?: string;
}

export interface GcpIapDeps {
  readonly fetch: typeof fetch;
  /** OAuth access token of the admin's runtime service account. */
  readonly accessToken: () => Promise<string>;
  /** GET a metadata-server value, e.g. `project/project-id`. */
  readonly metadata: (path: string) => Promise<string>;
}

/**
 * How to retry a sync once its cause is fixed. The user change itself is
 * already saved and its proposal applied, so "approve again" is impossible —
 * the /security/users re-sync button recomputes every user's access
 * (including deleted users', whose revocation is the case that matters).
 */
export const RESYNC_HINT =
  'Then open /security/users and click "Re-sync Google IAP access" — the user change itself is already saved.';

const UPGRADE_HINT = `Run \`cms-provision upgrade\` from the machine that provisioned this install: it grants the admin's service account the operator-access role it needs. ${RESYNC_HINT}`;

/**
 * The IAP backend for this process, or `null` when the admin is not behind
 * Google IAP (self-hosted, AWS, Azure) — there is nothing to sync there.
 */
export function gcpIapBackendFromEnv(
  env: GcpIapEnv,
  deps: GcpIapDeps = defaultDeps(),
): OperatorAccessBackend | null {
  const provider = env.CAELO_PROVIDER;
  if (provider !== "gcp" && provider !== "gcp-firebase") return null;
  return createGcpIapBackend(provider, env, deps);
}

function createGcpIapBackend(
  provider: "gcp" | "gcp-firebase",
  env: GcpIapEnv,
  deps: GcpIapDeps,
): OperatorAccessBackend {
  let resource: Promise<string> | null = null;
  const iapResource = (): Promise<string> => {
    resource ??= resolveIapResource(provider, env, deps).catch((e: unknown) => {
      resource = null; // a transient failure must not stick for the process lifetime
      throw e;
    });
    return resource;
  };

  return {
    label:
      provider === "gcp-firebase"
        ? `Google IAP on Cloud Run service ${env.K_SERVICE ?? "(unknown)"}`
        : "Google IAP on the admin load-balancer backend",
    async setAccess(principal, allow) {
      const mcpSa = env.CAELO_MCP_IAP_SERVICE_ACCOUNT?.trim();
      if (!mcpSa) {
        throw new OperatorAccessError(
          "CAELO_MCP_IAP_SERVICE_ACCOUNT is not set on the admin, so MCP access cannot be granted.",
          UPGRADE_HINT,
        );
      }
      const iapUrl = `https://iap.googleapis.com/v1/${await iapResource()}`;
      await updateMembership(deps, {
        url: iapUrl,
        what: "the admin's IAP allowlist",
        getBody: { options: { requestedPolicyVersion: 3 } },
        role: IAP_ACCESSOR_ROLE,
        member: principal,
        present: allow,
      });
      await updateMembership(deps, {
        url: `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(mcpSa)}`,
        what: `the MCP service account ${mcpSa}`,
        getQuery: "?options.requestedPolicyVersion=3",
        role: TOKEN_CREATOR_ROLE,
        member: principal,
        present: allow,
      });
    },
  };
}

async function resolveIapResource(
  provider: "gcp" | "gcp-firebase",
  env: GcpIapEnv,
  deps: GcpIapDeps,
): Promise<string> {
  // IAP resource names use the project NUMBER (cloud.google.com/iap/docs/
  // managing-access#resources_and_permissions); the Compute API takes the id.
  const projectNumber = (await deps.metadata("project/numeric-project-id")).trim();
  if (provider === "gcp-firebase") {
    const service = env.K_SERVICE?.trim();
    if (!service) {
      throw new OperatorAccessError(
        "K_SERVICE is not set, so the admin cannot tell which Cloud Run service it is.",
        "This only happens outside Cloud Run; operator access is managed on the deployed admin.",
      );
    }
    // `projects/<n>/regions/<region>` → `<region>`
    const region = (await deps.metadata("instance/region")).trim().split("/").pop() ?? "";
    return `projects/${projectNumber}/iap_web/cloud_run-${region}/services/${service}`;
  }
  // gcp: IAP sits on the LB backend service, whose Pulumi-generated name the
  // admin cannot know up front (the backend references the admin service, so
  // the reverse reference would be a cycle). Same lookup `cms-provision
  // upgrade` does, narrowed to IAP-enabled backends.
  const caeloEnv = env.CAELO_ENV?.trim();
  if (!caeloEnv) {
    throw new OperatorAccessError(
      "CAELO_ENV is not set on the admin, so it cannot tell which load-balancer backend is its own.",
      UPGRADE_HINT,
    );
  }
  const project = (await deps.metadata("project/project-id")).trim();
  const prefix = `caelo-${caeloEnv}-admin-backend`;
  const filter = encodeURIComponent(`name eq ${prefix}.*`);
  const res = await call(
    deps,
    `https://compute.googleapis.com/compute/v1/projects/${project}/global/backendServices?filter=${filter}`,
    "GET",
    undefined,
    "list the admin's backend service",
  );
  const items = ((res as { items?: { name: string; iap?: { enabled?: boolean } }[] }).items ?? [])
    .filter((b) => b.iap?.enabled)
    .map((b) => b.name);
  if (items.length !== 1) {
    throw new OperatorAccessError(
      `Expected exactly one IAP-enabled backend service named ${prefix}*, found ${items.length}${items.length > 1 ? ` (${items.join(", ")})` : ""}.`,
      `Check the load balancer in the Cloud Console; \`cms-provision status\` shows the install's resources. ${RESYNC_HINT}`,
    );
  }
  return `projects/${projectNumber}/iap_web/compute/services/${items[0]}`;
}

interface MembershipChange {
  readonly url: string;
  readonly what: string;
  readonly getBody?: unknown;
  readonly getQuery?: string;
  readonly role: string;
  readonly member: string;
  readonly present: boolean;
}

/** Concurrent writers (another approval, Pulumi) surface as an etag conflict. */
const MAX_ATTEMPTS = 3;

async function updateMembership(deps: GcpIapDeps, c: MembershipChange): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const policy = (await call(
      deps,
      `${c.url}:getIamPolicy${c.getQuery ?? ""}`,
      "POST",
      c.getBody ?? {},
      `read ${c.what}`,
    )) as IamPolicy;
    const next = withMember(policy, c.role, c.member, c.present);
    if (!next) return;
    try {
      await call(deps, `${c.url}:setIamPolicy`, "POST", { policy: next }, `update ${c.what}`);
      return;
    } catch (e) {
      if (e instanceof EtagConflict && attempt < MAX_ATTEMPTS) continue;
      throw e instanceof EtagConflict
        ? new OperatorAccessError(
            `update ${c.what}: the policy kept changing underneath (${MAX_ATTEMPTS} attempts).`,
            `Wait a moment. ${RESYNC_HINT}`,
          )
        : e;
    }
  }
}

class EtagConflict extends Error {}

async function call(
  deps: GcpIapDeps,
  url: string,
  method: "GET" | "POST",
  body: unknown,
  action: string,
): Promise<unknown> {
  let token: string;
  try {
    token = await deps.accessToken();
  } catch (e) {
    throw new OperatorAccessError(
      `${action}: no Google access token for the admin's service account (${e instanceof Error ? e.message : String(e)}).`,
      "The admin must run on Cloud Run with its runtime service account attached.",
    );
  }
  const res = await deps.fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.ok) return res.json();
  const text = (await res.text()).slice(0, 500);
  if (res.status === 409) throw new EtagConflict(text);
  if (res.status === 403) {
    throw new OperatorAccessError(
      `${action}: permission denied for the admin's service account (HTTP 403: ${text}).`,
      UPGRADE_HINT,
    );
  }
  if (res.status === 400 && /does not exist|not found|invalid member|is of type/i.test(text)) {
    throw new OperatorAccessError(
      `${action}: Google rejected the principal (HTTP 400: ${text}).`,
      "Google IAP only admits Google identities: the user's email must be a Google account (Gmail or Google Workspace). Delete this user and create them again with their Google sign-in address.",
    );
  }
  throw new OperatorAccessError(
    `${action}: HTTP ${res.status}: ${text}`,
    `If this persists, report it with \`bug_report\`. ${RESYNC_HINT}`,
  );
}

function defaultDeps(): GcpIapDeps {
  const METADATA = "http://metadata.google.internal/computeMetadata/v1/";
  return {
    fetch,
    accessToken: async () => {
      // Lazy import keeps the dep off non-GCP code paths (self-hosted).
      const { GoogleAuth } = await import("google-auth-library");
      const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
      const token = await auth.getAccessToken();
      if (!token) throw new Error("Application Default Credentials returned no access token");
      return token;
    },
    metadata: async (path) => {
      const res = await fetch(`${METADATA}${path}`, { headers: { "Metadata-Flavor": "Google" } });
      if (!res.ok) {
        throw new OperatorAccessError(
          `metadata server: ${path} returned HTTP ${res.status}`,
          "The admin must run on Google Cloud Run for IAP access sync.",
        );
      }
      return res.text();
    },
  };
}
