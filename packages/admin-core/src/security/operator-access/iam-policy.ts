// SPDX-License-Identifier: MPL-2.0

/**
 * Pure helpers for the operator-access sync job (sync-job.ts): which members
 * a managed IAM role SHOULD hold, and the read-modify-write that makes a
 * Google IAM policy hold exactly that.
 *
 * The job is the only principal allowed to change these two bindings
 * (`roles/iap.httpsResourceAccessor` on the admin's IAP resource,
 * `roles/iam.serviceAccountTokenCreator` on the `caelo-mcp` service account).
 * It writes the managed role's member list as a whole — every other member on
 * that role is removed, including conditional bindings and principal types it
 * never grants (`allUsers`, `allAuthenticatedUsers`, `domain:`) — so a single
 * run repairs a tampered policy. Bindings of OTHER roles are never touched;
 * the job's own setIamPolicy grant lives there.
 */

export interface IamBinding {
  role: string;
  members?: string[];
  condition?: unknown;
}

export interface IamPolicy {
  version?: number;
  etag?: string;
  bindings?: IamBinding[];
  [extra: string]: unknown;
}

/**
 * A Google account email as IAM accepts it after `user:`. Deliberately
 * strict: no wildcards, no whitespace or commas, a dotted domain.
 */
const EMAIL = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** `user:<email>` for a Caelo user's email, or `null` when it is not a valid one. */
export function userMember(email: string): string | null {
  const e = email.trim().toLowerCase();
  return EMAIL.test(e) ? `user:${e}` : null;
}

/** Principal types a static allowlist entry may name. */
const STATIC_MEMBER = /^(user|group|serviceAccount):[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Parse the job's static member list (`CAELO_OPERATOR_ACCESS_STATIC_MEMBERS`,
 * comma-separated, set by the provisioner from the same allowlist the stack
 * binds). Public and domain-wide principals are never accepted, even there.
 */
export function parseStaticMembers(raw: string): { members: string[]; rejected: string[] } {
  const members: string[] = [];
  const rejected: string[] = [];
  for (const entry of raw.split(",")) {
    const m = entry.trim();
    if (!m) continue;
    const [kind, ...rest] = m.split(":");
    const normalised = `${kind}:${rest.join(":").toLowerCase()}`;
    if (STATIC_MEMBER.test(normalised)) members.push(normalised);
    else rejected.push(m);
  }
  return { members, rejected };
}

/**
 * The members a managed role must hold: one `user:` member per valid Caelo
 * email, plus the static members. Invalid emails are reported, never granted.
 */
export function desiredMembers(
  emails: readonly string[],
  staticMembers: readonly string[],
): { members: Set<string>; invalidEmails: string[] } {
  const members = new Set(staticMembers);
  const invalidEmails: string[] = [];
  for (const email of emails) {
    const m = userMember(email);
    if (m) members.add(m);
    else invalidEmails.push(email);
  }
  return { members, invalidEmails };
}

/** A member the reconcile took away, with the condition it had (if any). */
export interface RemovedMember {
  readonly member: string;
  readonly condition?: unknown;
}

export interface Reconciled {
  /** The policy to write, or `null` when it already holds exactly `desired`. */
  readonly next: IamPolicy | null;
  readonly added: string[];
  readonly removed: RemovedMember[];
}

/**
 * Make `role` in `policy` hold exactly `desired`, unconditionally. Every
 * binding of `role` is replaced by one unconditional binding (dropped when
 * `desired` is empty); other roles' bindings are kept as they are.
 */
export function reconcileRole(
  policy: IamPolicy,
  role: string,
  desired: ReadonlySet<string>,
): Reconciled {
  const bindings = policy.bindings ?? [];
  const current = bindings.filter((b) => b.role === role);
  const unconditional = new Set(
    current.filter((b) => !b.condition).flatMap((b) => b.members ?? []),
  );
  const removed: RemovedMember[] = [];
  for (const b of current) {
    for (const member of b.members ?? []) {
      if (b.condition) removed.push({ member, condition: b.condition });
      else if (!desired.has(member)) removed.push({ member });
    }
  }
  const added = [...desired].filter((m) => !unconditional.has(m)).sort();
  if (added.length === 0 && removed.length === 0) return { next: null, added, removed };

  const others = bindings.filter((b) => b.role !== role);
  const next: IamPolicy = {
    ...policy,
    bindings: desired.size > 0 ? [...others, { role, members: [...desired].sort() }] : others,
  };
  // A policy that still carries a condition must be written as version 3.
  if (next.bindings?.some((b) => b.condition)) next.version = 3;
  return { next, added, removed };
}
