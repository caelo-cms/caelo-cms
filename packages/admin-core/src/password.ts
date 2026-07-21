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

/**
 * Minimum length for a new password. Deliberately longer than the historical
 * 8-char floor (`hashPassword` still guards at 8 as a backstop) — modern
 * guidance (NIST 800-63B) favours length + a breach/common-list check over
 * composition rules, so we lean on length here rather than mandating symbols.
 */
export const MIN_PASSWORD_LENGTH = 10;

/** Upper bound (also enforced at the Zod boundary) — argon2 cost + a sane cap. */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * A compact blocklist of the most-common / most-breached passwords. NOT a full
 * HaveIBeenPwned lookup (that needs network + a dependency); it catches the
 * passwords attackers try first. Length-blocked short entries are kept for
 * completeness. Compared case-insensitively.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "password1234",
  "password12345",
  "passw0rd",
  "passw0rd123",
  "p@ssw0rd",
  "p@ssword123",
  "123456",
  "1234567",
  "12345678",
  "123456789",
  "1234567890",
  "12345678910",
  "0987654321",
  "qwerty",
  "qwerty123",
  "qwertyuiop",
  "qwerty12345",
  "1q2w3e4r",
  "1q2w3e4r5t",
  "1qaz2wsx",
  "zaq12wsx",
  "abc123",
  "abcd1234",
  "abcabcabc",
  "letmein",
  "letmein123",
  "welcome",
  "welcome1",
  "welcome123",
  "admin",
  "admin123",
  "admin1234",
  "admin12345",
  "administrator",
  "root",
  "rootroot",
  "iloveyou",
  "iloveyou1",
  "monkey",
  "monkey123",
  "dragon",
  "dragon123",
  "master",
  "master123",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "superman",
  "batman123",
  "trustno1",
  "whatever",
  "changeme",
  "changeme123",
  "secret",
  "secret123",
  "test1234",
  "test12345",
  "testtest",
  "asdfghjkl",
  "asdfasdf",
  "qazwsxedc",
  "zxcvbnm",
  "1111111111",
  "0000000000",
  "aaaaaaaaaa",
  "caelo",
  "caelocms",
  "caelo12345",
]);

/**
 * Ascending/descending strings that a "password" made purely of a keyboard or
 * numeric run would be a substring of. We reject only when the WHOLE password
 * is a slice of one of these — so `abcdefghij` is out, but `myabcpassword` is
 * fine.
 */
const SEQUENCES = ["0123456789", "abcdefghijklmnopqrstuvwxyz", "qwertyuiopasdfghjklzxcvbnm"];

export interface PasswordPolicyContext {
  /** The account's email — a password must not embed its local-part. */
  email?: string;
  /** The account's display name — a password must not embed it. */
  displayName?: string;
}

/** Result of {@link validatePasswordStrength}: a machine + human reason on fail. */
export type PasswordValidation = { ok: true } | { ok: false; reason: string };

function isSequential(lower: string): boolean {
  if (lower.length < 4) return false;
  const rev = lower.split("").reverse().join("");
  return SEQUENCES.some((seq) => seq.includes(lower) || seq.includes(rev));
}

function embedsPersonal(lower: string, raw: string | undefined): boolean {
  if (!raw) return false;
  // Split an email local-part or a display name into word-ish tokens; a token
  // shorter than 4 chars is too generic to block on.
  const local = raw.includes("@") ? raw.slice(0, raw.indexOf("@")) : raw;
  const tokens = local
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
  return tokens.some((t) => lower.includes(t));
}

/**
 * Reject weak passwords BEFORE they are hashed. Applied at every set-point
 * (setup, admin-create, self-change, reset) so the policy is enforced in one
 * place. Returns a structured reason so callers can surface it verbatim.
 *
 * Policy (NIST 800-63B-aligned): length ≥ {@link MIN_PASSWORD_LENGTH}, not a
 * known-common password, not a single repeated character, not a pure
 * keyboard/number sequence, and not embedding the account's own email or name.
 */
export function validatePasswordStrength(
  password: string,
  ctx: PasswordPolicyContext = {},
): PasswordValidation {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.` };
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    return { ok: false, reason: "That password is too common — pick something less guessable." };
  }
  if (/^(.)\1+$/.test(password)) {
    return { ok: false, reason: "Password can't be a single repeated character." };
  }
  if (isSequential(lower)) {
    return { ok: false, reason: "Password can't be a simple keyboard or number sequence." };
  }
  if (embedsPersonal(lower, ctx.email) || embedsPersonal(lower, ctx.displayName)) {
    return { ok: false, reason: "Password must not contain your name or email." };
  }
  return { ok: true };
}
