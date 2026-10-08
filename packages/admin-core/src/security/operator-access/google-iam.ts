// SPDX-License-Identifier: MPL-2.0

/**
 * Google REST plumbing for the operator-access sync job: the job's own
 * access token and metadata (it runs as a Cloud Run job with its own service
 * account), and the getIamPolicy → reconcile → setIamPolicy cycle with an
 * etag-conflict retry. Shared by sync-job.ts only — the admin service never
 * writes IAM (it can only start the job, gcp-job-trigger.ts).
 */

import { type IamPolicy, type Reconciled, reconcileRole } from "./iam-policy.js";

export interface GoogleDeps {
  readonly fetch: typeof fetch;
  /** OAuth access token of the process's service account. */
  readonly accessToken: () => Promise<string>;
  /** GET a metadata-server value, e.g. `project/numeric-project-id`. */
  readonly metadata: (path: string) => Promise<string>;
}

/** A Google call that failed, with the HTTP status when there was one. */
export class GoogleCallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GoogleCallError";
  }
}

const METADATA = "http://metadata.google.internal/computeMetadata/v1/";

/** Real Google endpoints: metadata server token + values, global fetch. */
export function defaultGoogleDeps(): GoogleDeps {
  const metadata = async (path: string): Promise<string> => {
    const res = await fetch(`${METADATA}${path}`, { headers: { "Metadata-Flavor": "Google" } });
    if (!res.ok) {
      throw new GoogleCallError(`metadata server: ${path} returned HTTP ${res.status}`, res.status);
    }
    return (await res.text()).trim();
  };
  return {
    fetch,
    metadata,
    accessToken: async () => {
      const raw = await metadata("instance/service-accounts/default/token");
      const token = (JSON.parse(raw) as { access_token?: string }).access_token;
      if (!token) throw new GoogleCallError("metadata server returned no access token");
      return token;
    },
  };
}

/** One authenticated JSON call; throws {@link GoogleCallError} on a non-2xx. */
export async function googleCall(
  deps: GoogleDeps,
  url: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<unknown> {
  const token = await deps.accessToken();
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
  throw new GoogleCallError(`${method} ${url}: HTTP ${res.status}: ${text}`, res.status);
}

/** Concurrent writers (Pulumi, another run) surface as an etag conflict. */
const MAX_ATTEMPTS = 3;

/**
 * Make `role` on the resource at `resourceUrl` (an IAP or IAM REST resource
 * URL, without the `:getIamPolicy` suffix) hold exactly `desired`.
 */
export async function reconcileResourceRole(
  deps: GoogleDeps,
  resourceUrl: string,
  role: string,
  desired: ReadonlySet<string>,
  read: { readonly body?: unknown; readonly query?: string },
): Promise<Reconciled> {
  for (let attempt = 1; ; attempt++) {
    const policy = (await googleCall(
      deps,
      `${resourceUrl}:getIamPolicy${read.query ?? ""}`,
      "POST",
      read.body ?? {},
    )) as IamPolicy;
    const result = reconcileRole(policy, role, desired);
    if (!result.next) return result;
    try {
      await googleCall(deps, `${resourceUrl}:setIamPolicy`, "POST", { policy: result.next });
      return result;
    } catch (e) {
      if (e instanceof GoogleCallError && e.status === 409 && attempt < MAX_ATTEMPTS) continue;
      throw e;
    }
  }
}
