// SPDX-License-Identifier: MPL-2.0

/**
 * #1476 — the Owner setup token: stored for the admin, with its read access,
 * minted once, and replaced only when it stopped being useful. The admin's
 * half is packages/admin-core/src/__tests__/owner-bootstrap-secret.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_BOOTSTRAP_TOKEN_SECRET, parseOwnerBootstrapToken } from "@caelo-cms/shared";
import type { GcloudResult } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import { GCP_STACK_ENV, gcpSecretId } from "./gcp-names.js";
import { INFRA_CONTRACT_VERSION } from "./infra-contract.js";
import { INSTALL_SETUP_LINK_SECRET } from "./install-job.js";
import { issueOwnerSetup, readOwnerBootstrapToken } from "./owner-setup-token.js";

const PROJECT = "acme-site";
const TARGET = { projectId: PROJECT, region: "europe-west1" };
const ADMIN = "https://admin.acme.test";
const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

/** A project's secrets as gcloud sees them; the calls it got. */
function secretManager(
  initial: Record<string, string> = {},
  refuse?: { readonly match: string; readonly stderr: string },
) {
  const secrets = new Map(Object.entries(initial));
  const calls: { args: string[]; stdin?: string }[] = [];
  const run: GcloudRunner = async (args, opts) => {
    calls.push({ args, ...(opts?.stdin === undefined ? {} : { stdin: opts.stdin }) });
    const line = args.join(" ");
    if (refuse && line.includes(refuse.match)) return fail(refuse.stderr);
    if (line.startsWith("secrets versions access")) {
      const id = args.find((a) => a.startsWith("--secret="))?.slice("--secret=".length) ?? "";
      const value = secrets.get(id);
      return value === undefined ? fail("NOT_FOUND: Secret not found") : ok(value);
    }
    if (line.startsWith("secrets describe")) {
      const id = args[2] ?? "";
      if (id.endsWith("postgres-password")) return ok('{"replication":{"automatic":{}}}');
      return secrets.has(id) ? ok(id) : fail("NOT_FOUND: Secret not found");
    }
    if (line.startsWith("secrets versions add")) {
      secrets.set(args[3] ?? "", opts?.stdin ?? "");
      return ok(`projects/1/secrets/${args[3]}/versions/2`);
    }
    if (line.startsWith("secrets versions list")) return ok("");
    if (line.startsWith("secrets create")) {
      secrets.set(args[2] ?? "", "");
      return ok();
    }
    if (line.startsWith("secrets add-iam-policy-binding")) return ok();
    throw new Error(`unexpected gcloud call: ${line}`);
  };
  return { run, secrets, calls };
}

const stored = (expiresAt: number) =>
  JSON.stringify({ token: "a".repeat(64), expiresAt: new Date(expiresAt).toISOString() });

describe("issueOwnerSetup", () => {
  it("mints a token, stores it for the admin, and stores the link that carries it", async () => {
    const gcp = secretManager({ "caelo-production-postgres-password": "x" });
    const r = await issueOwnerSetup(gcp.run, TARGET, ADMIN, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.minted).toBe(true);
    const token = parseOwnerBootstrapToken(gcp.secrets.get(OWNER_BOOTSTRAP_TOKEN_SECRET) ?? "");
    expect(token?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.link).toBe(`${ADMIN}/setup?token=${token?.token}`);
    expect(gcp.secrets.get(INSTALL_SETUP_LINK_SECRET)).toBe(r.link);
  });

  it("gives the admin's service account read access, on this secret only", async () => {
    const gcp = secretManager({ "caelo-production-postgres-password": "x" });
    await issueOwnerSetup(gcp.run, TARGET, ADMIN, NOW);
    const grants = gcp.calls.filter((c) => c.args[1] === "add-iam-policy-binding");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.args[2]).toBe(OWNER_BOOTSTRAP_TOKEN_SECRET);
    expect(grants[0]?.args).toContain(
      `--member=serviceAccount:caelo-production-run-sa@${PROJECT}.iam.gserviceaccount.com`,
    );
    expect(grants[0]?.args).toContain("--role=roles/secretmanager.secretAccessor");
  });

  it("never puts the token on a command line", async () => {
    const gcp = secretManager({ "caelo-production-postgres-password": "x" });
    const r = await issueOwnerSetup(gcp.run, TARGET, ADMIN, NOW);
    if (!r.ok) throw new Error(r.error);
    const token = new URL(r.link).searchParams.get("token") ?? "";
    expect(gcp.calls.some((c) => c.args.join(" ").includes(token))).toBe(false);
  });

  it("keeps a token with time left, so a link already handed out stays good", async () => {
    const gcp = secretManager({
      [OWNER_BOOTSTRAP_TOKEN_SECRET]: stored(NOW + 5 * HOUR),
    });
    const r = await issueOwnerSetup(gcp.run, TARGET, ADMIN, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.minted).toBe(false);
    expect(r.link).toBe(`${ADMIN}/setup?token=${"a".repeat(64)}`);
    expect(gcp.secrets.get(OWNER_BOOTSTRAP_TOKEN_SECRET)).toBe(stored(NOW + 5 * HOUR));
    // An interrupted run may have stopped before the grant.
    expect(gcp.calls.some((c) => c.args[1] === "add-iam-policy-binding")).toBe(true);
  });

  it.each([
    ["expired", stored(NOW - HOUR)],
    ["about to expire", stored(NOW + HOUR / 2)],
    ["not a token", "garbage"],
  ])("replaces a stored token that is %s", async (_case, value) => {
    const gcp = secretManager({
      "caelo-production-postgres-password": "x",
      [OWNER_BOOTSTRAP_TOKEN_SECRET]: value,
    });
    const r = await issueOwnerSetup(gcp.run, TARGET, ADMIN, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.minted).toBe(true);
    expect(r.link).not.toContain("a".repeat(64));
  });

  it("fails loudly when the admin cannot be given access, with no link stored", async () => {
    const gcp = secretManager(
      { "caelo-production-postgres-password": "x" },
      { match: "add-iam-policy-binding", stderr: "PERMISSION_DENIED: setIamPolicy" },
    );
    const r = await issueOwnerSetup(gcp.run, TARGET, ADMIN, NOW);
    expect(r).toEqual({
      ok: false,
      error: `let the admin read ${OWNER_BOOTSTRAP_TOKEN_SECRET}: PERMISSION_DENIED: setIamPolicy`,
    });
    expect(gcp.secrets.has(INSTALL_SETUP_LINK_SECRET)).toBe(false);
  });
});

describe("readOwnerBootstrapToken", () => {
  it("is null without a token", async () => {
    expect(await readOwnerBootstrapToken(secretManager().run, PROJECT)).toBeNull();
  });

  it("names what the account needs when the read is refused", async () => {
    const gcp = secretManager({}, { match: "versions access", stderr: "PERMISSION_DENIED: no" });
    await expect(readOwnerBootstrapToken(gcp.run, PROJECT)).rejects.toThrow(
      "secretmanager.versions.access",
    );
  });
});

describe("where the token lives", () => {
  const stack = (provider: string) =>
    readFileSync(join(import.meta.dir, `../stacks/${provider}/index.ts`), "utf8");

  it("the admin and the CLI name the same secret", () => {
    expect(OWNER_BOOTSTRAP_TOKEN_SECRET).toBe(gcpSecretId(GCP_STACK_ENV, "owner-bootstrap-token"));
  });

  it.each(["gcp", "gcp-firebase", "aws", "azure"])(
    "%s mints no token in the Pulumi program: it would change on every up and sit in its state",
    (provider) => {
      const source = stack(provider);
      expect(source).not.toContain("generateBootstrapToken");
      expect(source).not.toContain("setup?token=");
    },
  );

  it.each(["gcp", "gcp-firebase"])(
    "%s neither mounts the secret nor binds it: existing installs get no converge step",
    (provider) => {
      expect(stack(provider)).not.toContain("owner-bootstrap-token");
      expect(INFRA_CONTRACT_VERSION).toBe(22);
    },
  );
});
