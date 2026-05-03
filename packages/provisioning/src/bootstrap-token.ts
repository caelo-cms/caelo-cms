// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — owner bootstrap token. cms-provision generates one at first
 * `up`; the operator visits /setup?token=<…> to create the first
 * Owner. Single-use, 24h TTL.
 */

export interface BootstrapToken {
  readonly token: string;
  readonly expiresAt: string;
}

export function generateBootstrapToken(): BootstrapToken {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return { token, expiresAt };
}
