// SPDX-License-Identifier: MPL-2.0

/**
 * Password hashing via Bun's built-in `Bun.password`. Algorithm locked to
 * argon2id — the current OWASP-recommended memory-hard hash. No third-party
 * dependency; same hash verifies stably across Bun releases.
 */

const ALGORITHM: { algorithm: "argon2id"; memoryCost: number; timeCost: number } = {
  algorithm: "argon2id",
  // OWASP 2023+ guidance: m=19MiB (19456 KiB), t=2. Bun exposes these as
  // memoryCost (KiB) + timeCost (iterations).
  memoryCost: 19_456,
  timeCost: 2,
};

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  return await Bun.password.hash(plaintext, ALGORITHM);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  if (plaintext.length === 0 || hash.length === 0) return false;
  try {
    return await Bun.password.verify(plaintext, hash);
  } catch {
    // Malformed hash => treat as mismatch rather than crashing the request.
    return false;
  }
}
