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

/** A Google call that failed, with the HTTP status (and response body) when there was one. */
export class GoogleCallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
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
  method: "GET" | "POST" | "PATCH",
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
  const text = await res.text();
  throw new GoogleCallError(
    `${method} ${url}: HTTP ${res.status}: ${text.slice(0, 500)}`,
    res.status,
    text,
  );
}

/** Concurrent writers (Pulumi, another run) surface as an etag conflict. */
const MAX_CONFLICT_ATTEMPTS = 3;

/** IAM's wording per principal type in "<Kind> <id> does not exist." */
const UNKNOWN_PRINCIPAL_PREFIX: Record<string, string> = {
  User: "user:",
  Group: "group:",
  "Service account": "serviceAccount:",
};

/**
 * The member a setIamPolicy 400 refused because Google has no such account
 * (`"User a@b.com does not exist."`), or `null` for any other error.
 */
export function unknownPrincipalOf(e: unknown): string | null {
  if (!(e instanceof GoogleCallError) || e.status !== 400 || !e.body) return null;
  let message: unknown;
  try {
    message = (JSON.parse(e.body) as { error?: { message?: unknown } }).error?.message;
  } catch {
    return null;
  }
  if (typeof message !== "string") return null;
  const m = /^(User|Group|Service account) (\S+) does not exist\.?$/.exec(message.trim());
  const prefix = m ? UNKNOWN_PRINCIPAL_PREFIX[m[1] as string] : undefined;
  return prefix && m ? `${prefix}${(m[2] as string).toLowerCase()}` : null;
}

/** {@link Reconciled} plus the desired members Google refused as nonexistent accounts. */
export interface ResourceReconciled extends Reconciled {
  readonly unknownPrincipals: string[];
}

/**
 * Make `role` on the resource at `resourceUrl` (an IAP or IAM REST resource
 * URL, without the `:getIamPolicy` suffix) hold exactly `desired`.
 *
 * setIamPolicy is all-or-nothing: one desired member without a Google
 * account (a Caelo user whose email is not a Google address) fails the whole
 * write, which would also block every removal — `allUsers` added by hand
 * would stay. So such a member is dropped from `desired`, the write is
 * retried, and the caller gets it back in `unknownPrincipals` to report.
 */
export async function reconcileResourceRole(
  deps: GoogleDeps,
  resourceUrl: string,
  role: string,
  desired: ReadonlySet<string>,
  read: { readonly body?: unknown; readonly query?: string },
): Promise<ResourceReconciled> {
  const wanted = new Set(desired);
  const unknownPrincipals: string[] = [];
  for (let conflicts = 1; ; ) {
    const policy = (await googleCall(
      deps,
      `${resourceUrl}:getIamPolicy${read.query ?? ""}`,
      "POST",
      read.body ?? {},
    )) as IamPolicy;
    const result = reconcileRole(policy, role, wanted);
    if (!result.next) return { ...result, unknownPrincipals };
    try {
      await googleCall(deps, `${resourceUrl}:setIamPolicy`, "POST", { policy: result.next });
      return { ...result, unknownPrincipals };
    } catch (e) {
      const unknown = unknownPrincipalOf(e);
      // Each retry removes one member, so this ends after at most |desired| writes.
      if (unknown && wanted.delete(unknown)) {
        unknownPrincipals.push(unknown);
        continue;
      }
      if (e instanceof GoogleCallError && e.status === 409 && conflicts < MAX_CONFLICT_ATTEMPTS) {
        conflicts++;
        continue;
      }
      throw e;
    }
  }
}
