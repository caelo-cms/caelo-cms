// SPDX-License-Identifier: MPL-2.0

/**
 * The keyless provisioner (#696, provisioner-identity.ts) against a fake
 * gcloud and a fake fetch. Load-bearing: no code path mints a key; the
 * operator gets TokenCreator on caelo-provisioner only; an older install's
 * key is deleted locally and in IAM — that key and no other; re-runs are
 * no-ops; a missing permission stops with the command to fix it; tokens
 * never leave the probe.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkAdcImpersonation } from "./adc-impersonation.js";
import type { GcloudResult } from "./gcloud.js";
import {
  convergeKeylessProvisioner,
  LEGACY_SA_KEY_FILE,
  operatorMember,
  provisionerServiceAccountEmail,
  TOKEN_CREATOR_ROLE,
} from "./provisioner-identity.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

type Opts = { readonly stdin?: string; readonly env?: NodeJS.ProcessEnv };

function fakeGcloud(answers: Record<string, GcloudResult[]>) {
  const calls: { args: string[]; opts?: Opts }[] = [];
  const run = async (args: string[], opts?: Opts) => {
    calls.push({ args, ...(opts ? { opts } : {}) });
    const key = Object.keys(answers)
      .sort((a, b) => b.length - a.length)
      .find((k) => args.join(" ").startsWith(k));
    return (key && answers[key]?.shift()) || ok();
  };
  return { run, calls, lines: () => calls.map((c) => c.args.join(" ")) };
}

const noSleep = async () => {};
const PROJECT = "acme-site";
const SA = provisionerServiceAccountEmail(PROJECT);
const OPERATOR = "Owner@Example.com";
const KEY_ID = "0123456789abcdef0123456789abcdef01234567";
const OTHER_KEY_ID = "fedcba9876543210fedcba9876543210fedcba98";
const keyName = (id: string) => `projects/${PROJECT}/serviceAccounts/${SA}/keys/${id}`;
const tokenCreatorPolicy = (member: string) =>
  JSON.stringify({ bindings: [{ role: TOKEN_CREATOR_ROLE, members: [member] }] });

let secretsDir = "";
beforeEach(() => {
  secretsDir = mkdtempSync(join(tmpdir(), "caelo-keyless-"));
});
afterEach(() => {
  rmSync(secretsDir, { recursive: true, force: true });
});

function writeLegacyKey(clientEmail = SA, keyId = KEY_ID): string {
  const path = join(secretsDir, LEGACY_SA_KEY_FILE);
  writeFileSync(
    path,
    JSON.stringify({
      type: "service_account",
      private_key_id: keyId,
      private_key: "not-a-real-private-key",
      client_email: clientEmail,
    }),
    { mode: 0o600 },
  );
  return path;
}

const target = () => ({ projectId: PROJECT, secretsDir, operatorAccount: OPERATOR });

describe("operatorMember", () => {
  it("a person is a user:, a service account a serviceAccount:, both lower-cased", () => {
    expect(operatorMember("Owner@Example.com")).toBe("user:owner@example.com");
    expect(operatorMember("ci@p.iam.gserviceaccount.com")).toBe(
      "serviceAccount:ci@p.iam.gserviceaccount.com",
    );
  });
});

describe("convergeKeylessProvisioner — new install", () => {
  it("grants TokenCreator on caelo-provisioner only and never mints or touches a key", async () => {
    const g = fakeGcloud({
      "iam service-accounts describe": [ok(`${SA}\n`)],
      "iam service-accounts get-iam-policy": [ok("{}")],
    });
    const r = await convergeKeylessProvisioner(target(), { run: g.run, sleep: noSleep });
    expect(r).toEqual({ ok: true, grant: "granted", legacyKey: "none", lines: [] });
    const grants = g.calls.filter((c) => c.args.includes("add-iam-policy-binding"));
    expect(grants).toHaveLength(1);
    expect(grants[0]?.args.slice(0, 4)).toEqual([
      "iam",
      "service-accounts",
      "add-iam-policy-binding",
      SA,
    ]);
    expect(grants[0]?.args).toContain("--member=user:owner@example.com");
    expect(grants[0]?.args).toContain(`--role=${TOKEN_CREATOR_ROLE}`);
    // Never project-wide, never a key operation, nothing written to disk.
    expect(g.lines().some((l) => l.startsWith("projects add-iam-policy-binding"))).toBe(false);
    expect(g.lines().some((l) => l.includes(" keys "))).toBe(false);
    expect(g.lines().some((l) => l.includes("print-access-token"))).toBe(false);
    expect(readdirSync(secretsDir)).toEqual([]);
  });

  it("an operator who already holds the role needs no IAM write", async () => {
    const g = fakeGcloud({
      "iam service-accounts describe": [ok(SA)],
      "iam service-accounts get-iam-policy": [ok(tokenCreatorPolicy("user:owner@example.com"))],
    });
    const r = await convergeKeylessProvisioner(target(), { run: g.run, sleep: noSleep });
    expect(r.ok && r.grant).toBe("already");
    expect(g.lines().some((l) => l.includes("add-iam-policy-binding"))).toBe(false);
  });

  it("a missing permission to grant stops with the command a project Owner can run", async () => {
    const path = writeLegacyKey();
    const g = fakeGcloud({
      "iam service-accounts describe": [ok(SA)],
      "iam service-accounts get-iam-policy": [ok("{}")],
      "iam service-accounts add-iam-policy-binding": [
        fail("ERROR: (gcloud.iam.service-accounts.add-iam-policy-binding) PERMISSION_DENIED"),
      ],
    });
    const r = await convergeKeylessProvisioner(target(), { run: g.run, sleep: noSleep });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("iam.serviceAccounts.setIamPolicy");
    expect(r.error).toContain(
      `gcloud iam service-accounts add-iam-policy-binding ${SA} --project=${PROJECT} --member=user:owner@example.com --role=${TOKEN_CREATOR_ROLE}`,
    );
    // The key stays until impersonation works: it is still the only credential.
    expect(existsSync(path)).toBe(true);
    expect(g.lines().some((l) => l.includes(" keys "))).toBe(false);
  });

  it("a project without caelo-provisioner and without a key has nothing to migrate", async () => {
    const g = fakeGcloud({
      "iam service-accounts describe": [fail("NOT_FOUND: Unknown service account")],
    });
    const r = await convergeKeylessProvisioner(target(), { run: g.run, sleep: noSleep });
    expect(r).toEqual({ ok: true, grant: "no-provisioner", legacyKey: "none", lines: [] });
    expect(g.calls).toHaveLength(1);
  });
});

describe("convergeKeylessProvisioner — account created moments ago", () => {
  it("waits out IAM propagation instead of reporting no provisioner", async () => {
    const g = fakeGcloud({
      "iam service-accounts describe": [fail("NOT_FOUND: Unknown service account"), ok(SA)],
      "iam service-accounts get-iam-policy": [ok("{}")],
    });
    const r = await convergeKeylessProvisioner(
      { ...target(), justCreated: true },
      { run: g.run, sleep: noSleep },
    );
    expect(r.ok && r.grant).toBe("granted");
  });
});

describe("convergeKeylessProvisioner — existing install with a key (upgrade)", () => {
  const withKeys = (ids: string[]) =>
    fakeGcloud({
      "iam service-accounts describe": [ok(SA)],
      "iam service-accounts get-iam-policy": [ok("{}")],
      "iam service-accounts keys list": [
        ok(JSON.stringify(ids.map((id) => ({ name: keyName(id), keyType: "USER_MANAGED" })))),
      ],
    });

  it("deletes the matching IAM key and the local file — and no other key", async () => {
    const path = writeLegacyKey();
    const g = withKeys([KEY_ID, OTHER_KEY_ID]);
    const r = await convergeKeylessProvisioner(target(), { run: g.run, sleep: noSleep });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.legacyKey).toBe("removed");
    const deletes = g.calls.filter((c) =>
      c.args.join(" ").startsWith("iam service-accounts keys delete"),
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.args[4]).toBe(KEY_ID);
    expect(deletes[0]?.args).toContain(`--iam-account=${SA}`);
    expect(existsSync(path)).toBe(false);
    // The unrecorded key is reported with its delete command, not deleted.
    const text = r.lines.join("\n");
    expect(text).toContain(OTHER_KEY_ID);
    expect(text).toContain(`gcloud iam service-accounts keys delete ${OTHER_KEY_ID}`);
    // Grant before the key goes: impersonation must work before the key is gone.
    const grantAt = g.lines().findIndex((l) => l.includes("add-iam-policy-binding"));
    const deleteAt = g.lines().findIndex((l) => l.includes("keys delete"));
    expect(grantAt).toBeGreaterThanOrEqual(0);
    expect(grantAt).toBeLessThan(deleteAt);
  });

  it("a conditional binding does not count as a grant", async () => {
    writeLegacyKey();
    const conditional = JSON.stringify({
      bindings: [
        {
          role: TOKEN_CREATOR_ROLE,
          members: ["user:owner@example.com"],
          condition: {
            title: "expired",
            expression: 'request.time < timestamp("2020-01-01T00:00:00Z")',
          },
        },
      ],
    });
    const g = fakeGcloud({
      "iam service-accounts describe": [ok(SA)],
      "iam service-accounts get-iam-policy": [ok(conditional)],
      "iam service-accounts keys list": [ok(JSON.stringify([{ name: keyName(KEY_ID) }]))],
    });
    const r = await convergeKeylessProvisioner(target(), { run: g.run, sleep: noSleep });
    expect(r.ok && r.grant).toBe("granted");
    const add = g.calls.find((c) => c.args.includes("add-iam-policy-binding"));
    expect(add?.args).toContain("--condition=None");
  });

  it("keeps the key when impersonation does not work yet, even after waiting", async () => {
    const path = writeLegacyKey();
    const denied = () => fail("PERMISSION_DENIED: iam.serviceAccounts.getAccessToken");
    const g = fakeGcloud({
      "iam service-accounts describe": [ok(SA)],
      "iam service-accounts get-iam-policy": [ok("{}")],
      "auth print-access-token": [
        denied(),
        denied(),
        denied(),
        denied(),
        denied(),
        denied(),
        denied(),
      ],
    });
    const slept: number[] = [];
    const r = await convergeKeylessProvisioner(target(), {
      run: g.run,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("its key was kept");
    expect(slept.length).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(true);
    expect(g.lines().some((l) => l.includes(" keys "))).toBe(false);
  });

  it("verifies impersonation through gcloud before deleting, and never keeps the token", async () => {
    writeLegacyKey();
    const g = fakeGcloud({
      "iam service-accounts describe": [ok(SA)],
      "iam service-accounts get-iam-policy": [ok(tokenCreatorPolicy("user:owner@example.com"))],
      "auth print-access-token": [ok("ya29.must-not-leak\n")],
      "iam service-accounts keys list": [ok(JSON.stringify([{ name: keyName(KEY_ID) }]))],
    });
    const r = await convergeKeylessProvisioner(target(), { run: g.run, sleep: noSleep });
    expect(r.ok && r.legacyKey).toBe("removed");
    const verifyAt = g.lines().findIndex((l) => l.startsWith("auth print-access-token"));
    const deleteAt = g.lines().findIndex((l) => l.includes("keys delete"));
    expect(g.lines()[verifyAt]).toContain(`--impersonate-service-account=${SA}`);
    expect(verifyAt).toBeLessThan(deleteAt);
    expect(JSON.stringify(r)).not.toContain("must-not-leak");
  });

  it("is idempotent: a second run finds no key and changes nothing", async () => {
    writeLegacyKey();
    await convergeKeylessProvisioner(target(), { run: withKeys([KEY_ID]).run, sleep: noSleep });
    const again = fakeGcloud({
      "iam service-accounts describe": [ok(SA)],
      "iam service-accounts get-iam-policy": [ok(tokenCreatorPolicy("user:owner@example.com"))],
    });
    const r = await convergeKeylessProvisioner(target(), { run: again.run, sleep: noSleep });
    expect(r).toEqual({ ok: true, grant: "already", legacyKey: "none", lines: [] });
    expect(again.lines().some((l) => l.includes(" keys ") || l.includes("add-iam"))).toBe(false);
  });

  it("a key already deleted in IAM only removes the local file", async () => {
    const path = writeLegacyKey();
    const g = withKeys([]);
    const r = await convergeKeylessProvisioner(target(), { run: g.run, sleep: noSleep });
    expect(r.ok && r.legacyKey).toBe("removed");
    expect(g.lines().some((l) => l.includes("keys delete"))).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("a failed IAM delete keeps the file so the next run can match it", async () => {
    const path = writeLegacyKey();
    const g = fakeGcloud({
      "iam service-accounts describe": [ok(SA)],
      "iam service-accounts get-iam-policy": [ok("{}")],
      "iam service-accounts keys list": [ok(JSON.stringify([{ name: keyName(KEY_ID) }]))],
      "iam service-accounts keys delete": [fail("PERMISSION_DENIED")],
    });
    const r = await convergeKeylessProvisioner(target(), { run: g.run, sleep: noSleep });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("iam.serviceAccountKeys.delete");
    expect(existsSync(path)).toBe(true);
  });

  it("a key file for another account is left alone and nothing is deleted", async () => {
    const path = writeLegacyKey("someone@other.iam.gserviceaccount.com");
    const g = withKeys([KEY_ID]);
    const r = await convergeKeylessProvisioner(target(), { run: g.run, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(g.lines().some((l) => l.includes("keys delete"))).toBe(false);
  });

  it("an unreadable key file is not guessed at", async () => {
    writeFileSync(join(secretsDir, LEGACY_SA_KEY_FILE), "garbage", { mode: 0o600 });
    const g = withKeys([KEY_ID, OTHER_KEY_ID]);
    const r = await convergeKeylessProvisioner(target(), { run: g.run, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(g.lines().some((l) => l.includes("keys delete"))).toBe(false);
  });
});

describe("checkAdcImpersonation", () => {
  const SOURCE = "ya29.source-token-must-never-leak";
  const MINTED = "ya29.impersonated-token-must-never-leak";
  const response = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  function fakeFetch(answers: Response[], tokeninfoEmail?: string) {
    const urls: string[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("tokeninfo")) {
        expect(String(init?.body)).toContain("access_token=");
        return response(200, { email: tokeninfoEmail ?? "" });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SOURCE}`);
      return answers.shift() ?? response(500, {});
    }) as typeof fetch;
    return { impl, urls };
  }

  it("runs the ADC lookup without ambient key/token variables", async () => {
    const g = fakeGcloud({ "auth application-default print-access-token": [fail("no ADC")] });
    const r = await checkAdcImpersonation(
      { projectId: PROJECT, operatorAccount: OPERATOR, freshGrant: false },
      {
        run: g.run,
        sleep: noSleep,
        fetch: fakeFetch([]).impl,
        env: {
          PATH: "/usr/bin",
          GOOGLE_APPLICATION_CREDENTIALS: "/home/op/.caelo-x/secrets/sa-key.json",
          GOOGLE_OAUTH_ACCESS_TOKEN: "static",
        },
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no-adc");
      expect(r.error).toContain("gcloud auth application-default login");
    }
    const env = g.calls[0]?.opts?.env ?? {};
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.GOOGLE_OAUTH_ACCESS_TOKEN).toBeUndefined();
  });

  it("expired ADC stop before IAM or the Credentials API is asked (#1078)", async () => {
    const g = fakeGcloud({
      "auth application-default print-access-token": [
        fail(
          "ERROR: (gcloud.auth.application-default.print-access-token) There was a problem refreshing your current auth tokens: ('invalid_grant: reauth related error (invalid_rapt)', {'error': 'invalid_grant'})",
        ),
      ],
    });
    const f = fakeFetch([]);
    const r = await checkAdcImpersonation(
      { projectId: PROJECT, operatorAccount: OPERATOR, freshGrant: false },
      { run: g.run, sleep: noSleep, fetch: f.impl },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("expired-adc");
    expect(r.error).toContain("have expired");
    expect(r.error).toContain("`gcloud auth application-default login`");
    expect(r.error).not.toContain("\n");
    expect(g.calls.map((c) => c.args.join(" "))).toEqual([
      "auth application-default print-access-token",
    ]);
    expect(f.urls).toEqual([]);
  });

  it("succeeds when ADC may mint a token for the provisioner, and keeps no token", async () => {
    const g = fakeGcloud({
      "auth application-default print-access-token": [ok(`${SOURCE}\n`)],
      "iam service-accounts describe": [ok(`${SA}\n`)],
    });
    const f = fakeFetch([response(200, { accessToken: MINTED, expireTime: "x" })]);
    const r = await checkAdcImpersonation(
      { projectId: PROJECT, operatorAccount: OPERATOR, freshGrant: false },
      { run: g.run, sleep: noSleep, fetch: f.impl },
    );
    expect(r).toEqual({ ok: true });
    expect(f.urls[0]).toContain(`serviceAccounts/${encodeURIComponent(SA)}:generateAccessToken`);
  });

  it("never calls the IAM Credentials API for an account IAM doesn't confirm", async () => {
    const g = fakeGcloud({
      "auth application-default print-access-token": [ok(SOURCE)],
      "iam service-accounts describe": [fail("NOT_FOUND: Unknown service account")],
    });
    const f = fakeFetch([]);
    const r = await checkAdcImpersonation(
      { projectId: PROJECT, operatorAccount: OPERATOR, freshGrant: false },
      { run: g.run, sleep: noSleep, fetch: f.impl },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(`Could not find ${SA}`);
    expect(f.urls).toEqual([]);
  });

  it("waits out IAM propagation after a fresh grant", async () => {
    const g = fakeGcloud({
      "auth application-default print-access-token": [ok(SOURCE)],
      "iam service-accounts describe": [ok(`${SA}\n`)],
    });
    const denied = () =>
      response(403, {
        error: { message: "Permission 'iam.serviceAccounts.getAccessToken' denied" },
      });
    const f = fakeFetch([denied(), denied(), response(200, { accessToken: MINTED })]);
    const slept: number[] = [];
    const r = await checkAdcImpersonation(
      { projectId: PROJECT, operatorAccount: OPERATOR, freshGrant: true },
      { run: g.run, sleep: async (ms) => void slept.push(ms), fetch: f.impl },
    );
    expect(r).toEqual({ ok: true });
    expect(slept).toHaveLength(2);
  });

  it("a denial names the ADC account when it differs from gcloud's, without leaking a token", async () => {
    const g = fakeGcloud({
      "auth application-default print-access-token": [ok(SOURCE)],
      "iam service-accounts describe": [ok(`${SA}\n`)],
    });
    const f = fakeFetch(
      [
        response(403, {
          error: { message: "Permission 'iam.serviceAccounts.getAccessToken' denied" },
        }),
      ],
      "someone-else@example.com",
    );
    const r = await checkAdcImpersonation(
      { projectId: PROJECT, operatorAccount: OPERATOR, freshGrant: false },
      { run: g.run, sleep: noSleep, fetch: f.impl },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("denied");
    expect(r.error).toContain("someone-else@example.com");
    expect(r.error).toContain(`gcloud auth application-default login\` as ${OPERATOR}`);
    expect(JSON.stringify(r)).not.toContain(SOURCE);
    expect(JSON.stringify(r)).not.toContain(MINTED);
  });
});

describe("no service-account key is minted anywhere in provisioning (#696)", () => {
  const root = resolve(import.meta.dir, "..");
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === "node_modules" || e.name.startsWith(".")) return [];
      const p = join(dir, e.name);
      if (e.isDirectory()) return sources(p);
      return /\.(ts|js|sh|ya?ml)$/.test(e.name) && !e.name.endsWith(".test.ts") ? [p] : [];
    });
  }

  it("no `keys create` (gcloud) and no key-creating API in any source file", () => {
    const files = sources(root);
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return (
        // `gcloud kms keys create` (the state key, ops-backend.ts) makes a
        // Cloud KMS key, not a service-account key.
        /(?<!kms["'`\s,]+)keys["'`\s,]+create/.test(src) ||
        /createServiceAccountKey|serviceAccounts\.keys\.create|ServiceAccountKey\(/.test(src)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("Pulumi never gets a key file: the wizard passes the SA to impersonate", () => {
    const up = readFileSync(join(root, "src", "wizards", "gcp-pulumi.ts"), "utf8");
    expect(up).not.toMatch(/GOOGLE_APPLICATION_CREDENTIALS:\s*inputs/);
    expect(up).not.toContain("saKeyPath");
    const wizard = readFileSync(join(root, "src", "wizards", "gcp.ts"), "utf8");
    expect(wizard).not.toContain("saKeyPath");
    expect(wizard).toContain("impersonateServiceAccount: saEmail");
    expect(wizard).toContain("convergeKeylessProvisioner(");
  });
});
