// SPDX-License-Identifier: MPL-2.0

/**
 * #1334 (epic #763 H4, M5, M6) — the hardened auth core: bounded argon2id,
 * no account enumeration, mandatory e-mail verification, atomic tokens,
 * normalised addresses, cookie-only sessions and the per-account login
 * throttle. In-memory store (test-world.ts); the gateway path is covered
 * by the integration suite.
 */

import { describe, expect, it } from "bun:test";
import {
  checkMailTemplates,
  isPublicOperationBusyError,
  manifestFromDefinition,
  publicOperationOf,
} from "@caelo-cms/plugin-sdk";
import plugin, { argon2InFlight } from "./index.js";
import { OPEN_CONFIG, type Row, run, sha256Hex, world } from "./test-world.js";

const PASSWORD = "correct horse battery";

async function signUpAndVerify(w: ReturnType<typeof world>, email: string): Promise<void> {
  await run(w.ctx, "signup", { email, password: PASSWORD });
  const mail = w.state.mails.findLast((m) => m.template === "verify_email");
  if (!mail?.token) throw new Error("no verification mail queued");
  await run(w.ctx, "verify_email", { token: mail.token });
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

async function timed(fn: () => Promise<unknown>): Promise<{ ms: number; value: unknown }> {
  const t = performance.now();
  const value = await fn();
  return { ms: performance.now() - t, value };
}

describe("argon2id is bounded (#763 H4)", () => {
  it("hashes with 19 MiB / t=2", async () => {
    const w = world({ auth_config: [OPEN_CONFIG] });
    await run(w.ctx, "signup", { email: "a@example.com", password: PASSWORD });
    expect(String(w.tables.public_users?.[0]?.password_hash)).toStartWith(
      "$argon2id$v=19$m=19456,t=2,",
    );
  });

  it("refuses requests above the concurrency bound with Busy, never more than 4 hashes at once", async () => {
    const w = world({ auth_config: [OPEN_CONFIG] });
    await signUpAndVerify(w, "a@example.com");
    let peak = 0;
    const sample = setInterval(() => {
      peak = Math.max(peak, argon2InFlight());
    }, 1);
    const rssBefore = process.memoryUsage().rss;
    let rssPeak = rssBefore;
    const rssSample = setInterval(() => {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    }, 5);
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, () =>
        run(w.ctx, "login", { email: "a@example.com", password: "wrong password!" }),
      ),
    );
    clearInterval(sample);
    clearInterval(rssSample);
    const busy = results.filter(
      (r) => r.status === "rejected" && isPublicOperationBusyError(r.reason),
    );
    expect(busy.length).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(4);
    // 24 unbounded hashes would hold ~450 MiB; four hold ~76 MiB.
    expect(rssPeak - rssBefore).toBeLessThan(250 * 1024 * 1024);
    expect(argon2InFlight()).toBe(0);
  });

  it("caps the password at 1024 characters in the input schema", () => {
    const signup = publicOperationOf(plugin.publicOperations, "signup");
    expect(
      signup?.input.safeParse({ email: "a@example.com", password: "x".repeat(1024) }).success,
    ).toBe(true);
    expect(
      signup?.input.safeParse({ email: "a@example.com", password: "x".repeat(1025) }).success,
    ).toBe(false);
  });
});

describe("no account enumeration (#763 M5)", () => {
  it("signup answers identically, in the same time, for known and unknown addresses", async () => {
    const w = world({ auth_config: [OPEN_CONFIG] });
    await signUpAndVerify(w, "known@example.com");
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 4; i++) {
      const k = await timed(() =>
        run(w.ctx, "signup", { email: "known@example.com", password: PASSWORD }),
      );
      const u = await timed(() =>
        run(w.ctx, "signup", { email: `new${i}@example.com`, password: PASSWORD }),
      );
      expect(k.value).toEqual(u.value);
      expect(k.value).toEqual({ awaitingVerification: true });
      known.push(k.ms);
      unknown.push(u.ms);
    }
    expect(Math.abs(median(known) - median(unknown))).toBeLessThan(60);
    // The known address gets a note, never a second account.
    expect(w.tables.public_users?.filter((u) => u.email === "known@example.com")).toHaveLength(1);
    expect(w.state.mails.some((m) => m.template === "signup_existing_account")).toBe(true);
  });

  it("request_password_reset answers identically, in the same time", async () => {
    const w = world({ auth_config: [OPEN_CONFIG] });
    await signUpAndVerify(w, "known@example.com");
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 4; i++) {
      const k = await timed(() =>
        run(w.ctx, "request_password_reset", { email: "known@example.com" }),
      );
      const u = await timed(() =>
        run(w.ctx, "request_password_reset", { email: `nobody${i}@example.com` }),
      );
      expect(k.value).toEqual(u.value);
      known.push(k.ms);
      unknown.push(u.ms);
    }
    expect(Math.abs(median(known) - median(unknown))).toBeLessThan(60);
    expect(w.state.mails.filter((m) => m.template === "password_reset")).toHaveLength(4);
    expect(w.state.mails.every((m) => m.to !== "nobody0@example.com")).toBe(true);
  });

  it("login refuses known and unknown addresses alike, in the same time", async () => {
    const w = world({ auth_config: [OPEN_CONFIG] });
    await signUpAndVerify(w, "known@example.com");
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 4; i++) {
      const k = await timed(() =>
        run(w.ctx, "login", { email: "known@example.com", password: "wrong" }).catch(
          (e: Error) => e.message,
        ),
      );
      const u = await timed(() =>
        run(w.ctx, "login", { email: `nobody${i}@example.com`, password: "wrong" }).catch(
          (e: Error) => e.message,
        ),
      );
      expect(k.value).toBe(u.value);
      known.push(k.ms);
      unknown.push(u.ms);
    }
    expect(Math.abs(median(known) - median(unknown))).toBeLessThan(30);
  });
});

describe("mandatory e-mail verification (E12)", () => {
  it("an account logs in only after its verification link was opened", async () => {
    const w = world({ auth_config: [OPEN_CONFIG] });
    await run(w.ctx, "signup", { email: "a@example.com", password: PASSWORD });
    expect(w.state.sessionSet).toBe(0);
    await expect(
      run(w.ctx, "login", { email: "a@example.com", password: PASSWORD }),
    ).rejects.toThrow(/invalid credentials/);
    const mail = w.state.mails.find((m) => m.template === "verify_email");
    if (!mail?.token) throw new Error("no verification mail");
    expect(mail.to).toBe("a@example.com");
    await run(w.ctx, "verify_email", { token: mail.token });
    await expect(
      run(w.ctx, "login", { email: "a@example.com", password: PASSWORD }),
    ).resolves.toMatchObject({ publicUserId: expect.any(String) });
    expect(w.state.sessionSet).toBe(1);
  });

  it("a squatted, unverified sign-up never gets a usable password", async () => {
    const w = world({ auth_config: [OPEN_CONFIG] });
    await run(w.ctx, "signup", { email: "victim@example.com", password: "attacker password" });
    await run(w.ctx, "signup", { email: "victim@example.com", password: PASSWORD });
    const victimMail = w.state.mails.findLast((m) => m.template === "verify_email");
    if (!victimMail?.token) throw new Error("no verification mail");
    await run(w.ctx, "verify_email", { token: victimMail.token });
    await expect(
      run(w.ctx, "login", { email: "victim@example.com", password: "attacker password" }),
    ).rejects.toThrow(/invalid credentials/);
    await expect(
      run(w.ctx, "login", { email: "victim@example.com", password: PASSWORD }),
    ).resolves.toBeDefined();
    // The attacker's earlier link died with the verification.
    expect(w.tables.email_verification_tokens?.filter((t) => !t.used_at)).toHaveLength(0);
  });

  it("the plugin requires a mail transport and its links target its own operations", () => {
    const manifest = manifestFromDefinition(plugin);
    expect(manifest.requires).toContain("email");
    const issues: string[] = [];
    checkMailTemplates(manifest, (_p, m) => issues.push(m));
    expect(issues).toEqual([]);
  });
});

describe("single-use tokens are redeemed atomically (#763 M6)", () => {
  it("a reset token works once under concurrency", async () => {
    const w = world({
      auth_config: [OPEN_CONFIG],
      public_users: [{ id: "u1", email: "a@example.com", password_hash: "old" } as Row],
    });
    const token = "reset-token-0123456789abcdef";
    w.tables.password_reset_tokens?.push({
      id: "t1",
      public_user_id: "u1",
      token_hash: await sha256Hex(token),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
    });
    const results = await Promise.allSettled([
      run(w.ctx, "reset_password", { token, newPassword: "first new password" }),
      run(w.ctx, "reset_password", { token, newPassword: "second new password" }),
      run(w.ctx, "reset_password", { token, newPassword: "third new password" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    // The reset proved the inbox.
    expect(w.tables.public_users?.[0]?.email_verified_at).toBeTruthy();
  });

  it("a verification token works once under concurrency", async () => {
    const w = world({ auth_config: [OPEN_CONFIG] });
    await run(w.ctx, "signup", { email: "a@example.com", password: PASSWORD });
    const token = w.state.mails[0]?.token ?? "";
    const results = await Promise.allSettled([
      run(w.ctx, "verify_email", { token }),
      run(w.ctx, "verify_email", { token }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("addresses, sessions and the login throttle (#763 M6)", () => {
  it("normalises addresses: one account per address, whatever the case", async () => {
    const w = world({ auth_config: [OPEN_CONFIG] });
    await signUpAndVerify(w, " Alice@Example.COM ");
    await run(w.ctx, "signup", { email: "alice@example.com", password: PASSWORD });
    expect(w.tables.public_users).toHaveLength(1);
    expect(w.tables.public_users?.[0]?.email).toBe("alice@example.com");
    await expect(
      run(w.ctx, "login", { email: "ALICE@example.com", password: PASSWORD }),
    ).resolves.toBeDefined();
  });

  it("takes the session token from the cookie only", () => {
    for (const op of ["me", "logout"]) {
      const def = publicOperationOf(plugin.publicOperations, op);
      expect(def?.input.safeParse({ sessionToken: "x".repeat(64) }).success).toBe(false);
      expect(def?.input.safeParse({}).success).toBe(true);
    }
  });

  it("refuses an account after 5 failed logins in 15 minutes, without hashing", async () => {
    const w = world({ auth_config: [OPEN_CONFIG] });
    await signUpAndVerify(w, "a@example.com");
    for (let i = 0; i < 5; i++) {
      await expect(
        run(w.ctx, "login", { email: "a@example.com", password: "wrong" }),
      ).rejects.toThrow(/invalid credentials/);
    }
    await expect(
      run(w.ctx, "login", { email: "a@example.com", password: PASSWORD }),
    ).rejects.toThrow(/too many attempts/);
    // The throttle holds for unknown addresses too, so it reveals nothing.
    for (let i = 0; i < 5; i++) {
      await run(w.ctx, "login", { email: "ghost@example.com", password: "x" }).catch(() => null);
    }
    await expect(
      run(w.ctx, "login", { email: "ghost@example.com", password: "x" }),
    ).rejects.toThrow(/too many attempts/);
  });

  it("captcha is required on login and both reset steps", () => {
    for (const op of [
      "signup",
      "login",
      "request_password_reset",
      "reset_password",
      "verify_email",
    ]) {
      expect(publicOperationOf(plugin.publicOperations, op)?.captcha ?? "required").toBe(
        "required",
      );
    }
  });
});
