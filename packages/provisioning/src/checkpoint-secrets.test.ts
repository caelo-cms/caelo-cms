// SPDX-License-Identifier: MPL-2.0

/**
 * #656 — progress.json / install.json never hold secret material, and
 * `upgrade` / wizard re-runs scrub what earlier installers stored. Every
 * credential below is a fake fixture.
 */

import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertNoCheckpointSecrets,
  assertNoSecrets,
  checkpointableOutputs,
  findCheckpointSecrets,
  findSecrets,
  redactCredentials,
  rotationHints,
  scrubProgressFile,
} from "./checkpoint-secrets.js";
import { databaseUrls } from "./stack-contract.js";

const FAKE_PW = "fakePw0rdForTests123";
const legacyAdminUrl = `postgresql://admin_role:${FAKE_PW}@10.1.2.3:5432/cms_admin?sslmode=require`;
const legacyPublicUrl = `postgresql://public_role:${FAKE_PW}@10.1.2.3:5432/cms_public?sslmode=require`;
const setupLink = "https://admin.acme.test/setup?token=fakeSetupToken0123456789";

/** What `pulumi up` returns on the current stacks, secret flags included. */
const stackOutputs = {
  adminDatabaseUrlOut: { value: databaseUrls("10.1.2.3").admin, secret: false },
  publicDatabaseUrlOut: { value: databaseUrls("10.1.2.3").public, secret: false },
  gatewayDatabaseUrlOut: { value: databaseUrls("10.1.2.3").gateway, secret: false },
  bootstrapUrlOut: { value: setupLink, secret: false },
  bootstrapTokenExpiresAtOut: { value: "2026-10-13T00:00:00.000Z", secret: false },
  providerOut: { value: "gcp", secret: false },
  lbIpOut: { value: "203.0.113.7", secret: false },
  adminDomainOut: { value: "admin.acme.test", secret: false },
  adminCloudRunUrlOut: { value: "https://caelo-admin-x.a.run.app", secret: false },
  dnsRecordsRequiredOut: {
    value: [{ hostname: "acme.test", type: "A", value: "203.0.113.7", purpose: "site" }],
    secret: false,
  },
  // A future output Pulumi marks secret, whatever its name or shape.
  someFutureOut: { value: "opaque", secret: true },
};

/** A progress.json as installers before #576 / #656 wrote it. */
const legacyProgress = {
  lastCompletedStep: "pulumi-up-acme",
  updatedAt: "2026-10-01T00:00:00.000Z",
  steps: {
    "project-acme": { existed: true },
    "sa-acme": { created: true, saEmail: "caelo-provisioner@acme.iam.gserviceaccount.com" },
    "sa-key-acme": { path: "/home/op/.caelo-gcp-acme/secrets/sa-key.json" },
    "pulumi-up-acme": {
      outputs: {
        adminDatabaseUrlOut: legacyAdminUrl,
        publicDatabaseUrlOut: legacyPublicUrl,
        bootstrapUrlOut: setupLink,
        providerOut: "gcp",
        lbIpOut: "203.0.113.7",
        adminDomainOut: "admin.acme.test",
      },
    },
  },
};

describe("findSecrets", () => {
  it("flags URLs carrying a password and names the database user", () => {
    const found = findSecrets(legacyProgress);
    expect(found).toContainEqual({
      path: "steps.pulumi-up-acme.outputs.adminDatabaseUrlOut",
      kind: "credential-url",
      user: "admin_role",
    });
    expect(found).toContainEqual({
      path: "steps.pulumi-up-acme.outputs.publicDatabaseUrlOut",
      kind: "credential-url",
      user: "public_role",
    });
    expect(found).toContainEqual({
      path: "steps.pulumi-up-acme.outputs.bootstrapUrlOut",
      kind: "token-url",
    });
    // Findings name where, never what.
    expect(JSON.stringify(found)).not.toContain(FAKE_PW);
  });

  it("does not flag the password-less database URLs the stacks export today", () => {
    expect(findSecrets(databaseUrls("10.1.2.3"))).toEqual([]);
  });

  it("flags secret-named keys holding a value, not markers or look-alikes", () => {
    expect(findSecrets({ postgresPassword: "x" })).toEqual([
      { path: "postgresPassword", kind: "secret-key" },
    ]);
    expect(findSecrets({ caeloSecretKekOut: "x", anthropic_api_key: "y" })).toHaveLength(2);
    expect(findSecrets({ bootstrapTokenExpiresAtOut: "2026-10-13", hasToken: false })).toEqual([]);
  });
});

describe("checkpointableOutputs", () => {
  it("drops secret-flagged outputs and the setup link, keeps what resume and DNS need", () => {
    const kept = checkpointableOutputs(stackOutputs);
    expect(Object.keys(kept)).not.toContain("someFutureOut");
    expect(Object.keys(kept)).not.toContain("bootstrapUrlOut");
    expect(kept.dnsRecordsRequiredOut).toEqual(stackOutputs.dnsRecordsRequiredOut.value);
    expect(kept.adminDomainOut).toBe("admin.acme.test");
    expect(kept.bootstrapTokenExpiresAtOut).toBe("2026-10-13T00:00:00.000Z");
    expect(findSecrets(kept)).toEqual([]);
  });

  it("drops a database URL that carries a password even when Pulumi did not mark it secret", () => {
    const kept = checkpointableOutputs({
      adminDatabaseUrlOut: { value: legacyAdminUrl, secret: false },
    });
    expect(kept).toEqual({});
  });
});

describe("checkpoint guard (regression #656)", () => {
  it("refuses a payload with a credential URL without echoing the secret", () => {
    let message = "";
    try {
      assertNoSecrets({ outputs: { adminDatabaseUrlOut: legacyAdminUrl } }, "progress.json");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("outputs.adminDatabaseUrlOut: credential-url");
    expect(message).not.toContain(FAKE_PW);
  });

  it("accepts every payload shape the wizard checkpoints", () => {
    const payloads = [
      { existed: true },
      { created: true },
      { billingAccountId: "000000-000000-000000" },
      { count: 12 },
      { existed: true, saEmail: "sa@acme.iam.gserviceaccount.com" },
      { granted: ["roles/run.admin"] },
      { path: "/home/op/.caelo-gcp-acme/secrets/sa-key.json" },
      { outputs: checkpointableOutputs(stackOutputs) },
      { skipped: "exists" },
      { bucket: "caelo-production-static-acme" },
      { adapter: "cloudflare" },
    ];
    for (const p of payloads) expect(() => assertNoSecrets(p, "progress.json")).not.toThrow();
  });

  it("every markStepDone call site in the CLI uses a reviewed payload key", () => {
    // A new checkpoint payload must be added here on purpose, after checking
    // it holds no secret. `outputs` must come from pulumiUpGcp, which returns
    // only checkpointableOutputs().
    const reviewed = new Set([
      "existed",
      "created",
      "billingAccountId",
      "count",
      "saEmail",
      "granted",
      "path",
      "outputs",
      "skipped",
      "bucket",
      "adapter",
    ]);
    const files = [
      ...readdirSync(import.meta.dir).map((f) => join(import.meta.dir, f)),
      ...readdirSync(join(import.meta.dir, "wizards")).map((f) =>
        join(import.meta.dir, "wizards", f),
      ),
    ].filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const keys: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/markStepDone\([^,]+,[^,]+,\s*\{([^}]*)\}/g)) {
        for (const part of (m[1] ?? "").split(",")) {
          const key = part.split(":")[0]?.trim();
          if (key) keys.push(key);
        }
      }
    }
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => !reviewed.has(k))).toEqual([]);
    const gcp = readFileSync(join(import.meta.dir, "wizards", "gcp.ts"), "utf8");
    expect(gcp).toContain("markStepDone(installId, stepName, { outputs: result.outputs })");
    const up = readFileSync(join(import.meta.dir, "wizards", "gcp-pulumi.ts"), "utf8");
    expect(up).toContain("outputs: checkpointableOutputs(result.outputs)");
  });
});

describe("checkpoints of projects with secret-sounding ids (codex review)", () => {
  it("treats step names as identifiers, not secret fields", () => {
    const checkpoint = {
      lastCompletedStep: "project-acme-token",
      updatedAt: "t",
      steps: { "project-acme-token": { existed: true }, "billing-acme-secret": { count: 1 } },
    };
    expect(findCheckpointSecrets(checkpoint)).toEqual([]);
    expect(() => assertNoCheckpointSecrets(checkpoint, "progress.json")).not.toThrow();
    // Payloads under such steps are still inspected.
    expect(
      findCheckpointSecrets({ steps: { "project-acme-token": { url: legacyAdminUrl } } }),
    ).toEqual([
      { path: "steps.project-acme-token.url", kind: "credential-url", user: "admin_role" },
    ]);
  });
});

describe("scrubProgressFile", () => {
  const withFile = (contents: unknown, run: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "caelo-scrub-"));
    try {
      const path = join(dir, "progress.json");
      writeFileSync(path, JSON.stringify(contents), { mode: 0o644 });
      run(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("removes the secrets, keeps every completed step, and leaves the file 0600", () => {
    withFile(legacyProgress, (path) => {
      const { removed } = scrubProgressFile(path);
      expect(removed.map((f) => f.kind).sort()).toEqual([
        "credential-url",
        "credential-url",
        "token-url",
      ]);
      const text = readFileSync(path, "utf8");
      expect(text).not.toContain(FAKE_PW);
      expect(text).not.toContain("token=");
      const after = JSON.parse(text);
      // Wizard re-runs resume: every step is still recorded as done.
      expect(Object.keys(after.steps)).toEqual(Object.keys(legacyProgress.steps));
      expect(after.lastCompletedStep).toBe("pulumi-up-acme");
      expect(after.steps["pulumi-up-acme"].outputs).toEqual({
        providerOut: "gcp",
        lbIpOut: "203.0.113.7",
        adminDomainOut: "admin.acme.test",
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(path, "..")).filter((f) => f.includes(".tmp-"))).toEqual([]);
      // Idempotent.
      expect(scrubProgressFile(path).removed).toEqual([]);
    });
  });

  it("keeps the completed-step markers of a project whose id sounds secret", () => {
    const cp = {
      lastCompletedStep: "pulumi-up-acme-token",
      updatedAt: "t",
      steps: {
        "project-acme-token": { existed: true },
        "pulumi-up-acme-token": { outputs: { adminDatabaseUrlOut: legacyAdminUrl, lbIpOut: "1" } },
      },
    };
    withFile(cp, (path) => {
      expect(scrubProgressFile(path).removed).toHaveLength(1);
      const after = JSON.parse(readFileSync(path, "utf8"));
      expect(after.steps).toEqual({
        "project-acme-token": { existed: true },
        "pulumi-up-acme-token": { outputs: { lbIpOut: "1" } },
      });
    });
  });

  it("leaves a clean file untouched and a missing one alone", () => {
    withFile(
      { lastCompletedStep: "x", steps: { x: { created: true } }, updatedAt: "t" },
      (path) => {
        const before = readFileSync(path, "utf8");
        expect(scrubProgressFile(path).removed).toEqual([]);
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(scrubProgressFile(`${path}.missing`).removed).toEqual([]);
      },
    );
  });
});

describe("rotationHints", () => {
  it("names the rotate-secret command for each leaked role password", () => {
    const hints = rotationHints(
      [
        { path: "a", kind: "credential-url", user: "admin_role" },
        { path: "b", kind: "credential-url", user: "public_role" },
        { path: "c", kind: "credential-url", user: "gateway_role" },
        { path: "d", kind: "credential-url", user: "admin_role" },
      ],
      "gcp-acme",
    );
    expect(hints).toEqual([
      "admin_role's password was stored in progress.json. Rotate it: bunx @caelo-cms/provisioning rotate-secret postgres-password --install gcp-acme",
      "public_role's password was stored in progress.json. Rotate it: bunx @caelo-cms/provisioning rotate-secret public-role-password --install gcp-acme",
      "gateway_role's password was stored in progress.json. Rotate it: bunx @caelo-cms/provisioning rotate-secret gateway-role-password --install gcp-acme",
    ]);
  });

  it("says the setup link needs no rotation", () => {
    const [hint] = rotationHints([{ path: "a", kind: "token-url" }], "gcp-acme");
    expect(hint).toContain("nothing to rotate");
  });
});

describe("redactCredentials", () => {
  it("masks URL passwords and leaves the rest readable", () => {
    const out = redactCredentials(`connect failed: ${legacyAdminUrl} (timeout)`);
    expect(out).not.toContain(FAKE_PW);
    expect(out).toContain("postgresql://admin_role:***@10.1.2.3:5432/cms_admin");
    expect(redactCredentials("https://admin.acme.test/x")).toBe("https://admin.acme.test/x");
  });
});

describe("install dir end to end (regression #656)", () => {
  it("a wizard's checkpoints leave no secret outside secrets/; legacy files are scrubbed; secrets are refused", () => {
    // installRoot() resolves ~ via os.homedir(), read once at process start —
    // drive install-state in a child process with its own HOME.
    const home = mkdtempSync(join(tmpdir(), "caelo-install-656-"));
    const installId = "gcp-acme";
    const root = join(home, `.caelo-${installId}`);
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "progress.json"), JSON.stringify(legacyProgress), {
        mode: 0o600,
      });
      const mod = resolve(import.meta.dir, "install-state.ts");
      const sec = resolve(import.meta.dir, "checkpoint-secrets.ts");
      const script = `
        const m = await import(${JSON.stringify(mod)});
        const s = await import(${JSON.stringify(sec)});
        const id = ${JSON.stringify(installId)};
        const lines = m.scrubInstallProgress(id);
        m.markStepDone(id, "sa-acme", { created: true, saEmail: "sa@acme.iam.gserviceaccount.com" });
        m.markStepDone(id, "pulumi-up-acme", { outputs: s.checkpointableOutputs(${JSON.stringify(stackOutputs)}) });
        let refused = "";
        try {
          m.markStepDone(id, "bad", { url: ${JSON.stringify(legacyAdminUrl)} });
        } catch (e) { refused = e.message; }
        console.log(JSON.stringify({ lines, refused, done: m.isStepDone(id, "project-acme") }));
      `;
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, HOME: home },
        stderr: "pipe",
      });
      expect(new TextDecoder().decode(child.stderr)).toBe("");
      expect(child.exitCode).toBe(0);
      const result = JSON.parse(new TextDecoder().decode(child.stdout));
      expect(result.done).toBe(true);
      expect(result.refused).toContain("credential-url");
      expect(result.refused).not.toContain(FAKE_PW);
      expect(result.lines.join("\n")).toContain(
        "rotate-secret postgres-password --install gcp-acme",
      );
      expect(result.lines.join("\n")).toContain(
        "rotate-secret public-role-password --install gcp-acme",
      );
      // Nothing under the install dir but secrets/ holds secret material.
      for (const f of readdirSync(root)) {
        if (f === "secrets" || f === "state") continue;
        const text = readFileSync(join(root, f), "utf8");
        expect(findSecrets(JSON.parse(text))).toEqual([]);
        expect(text).not.toContain(FAKE_PW);
      }
      expect(statSync(join(root, "progress.json")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
