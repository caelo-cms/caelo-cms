// SPDX-License-Identifier: MPL-2.0

/**
 * Pure read-modify-write helpers for Google IAM policies (the shape every
 * `getIamPolicy` / `setIamPolicy` pair returns, IAP and IAM alike).
 *
 * Only UNCONDITIONAL bindings are touched. A conditional binding is something
 * an operator wrote by hand (e.g. "only from the office network"); silently
 * widening or deleting it would be worse than leaving it, so a member granted
 * only through a condition is left exactly as found.
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

/** Whether `member` holds `role` through an unconditional binding. */
export function hasUnconditionalMember(policy: IamPolicy, role: string, member: string): boolean {
  return (policy.bindings ?? []).some(
    (b) => b.role === role && !b.condition && (b.members ?? []).includes(member),
  );
}

/**
 * The policy with `member` added to (`present: true`) or removed from
 * (`present: false`) the unconditional `role` binding, or `null` when the
 * policy already says so — the caller then skips the write entirely.
 */
export function withMember(
  policy: IamPolicy,
  role: string,
  member: string,
  present: boolean,
): IamPolicy | null {
  if (hasUnconditionalMember(policy, role, member) === present) return null;
  const bindings = (policy.bindings ?? []).map((b) => ({ ...b, members: [...(b.members ?? [])] }));
  if (present) {
    const target = bindings.find((b) => b.role === role && !b.condition);
    if (target) target.members.push(member);
    else bindings.push({ role, members: [member] });
  } else {
    for (const b of bindings) {
      if (b.role === role && !b.condition) b.members = b.members.filter((m) => m !== member);
    }
  }
  const next: IamPolicy = {
    ...policy,
    bindings: bindings.filter((b) => b.members.length > 0),
  };
  // A policy carrying any condition must be written as version 3, or the
  // API rejects it; requesting v3 on read keeps the conditions visible.
  if (next.bindings?.some((b) => b.condition)) next.version = 3;
  return next;
}
