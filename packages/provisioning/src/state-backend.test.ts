// SPDX-License-Identifier: MPL-2.0

/**
 * Backend resolution (#696, state-backend.ts): the one place a Pulumi
 * backend URL, secrets provider and environment come from.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backendShellEnv,
  chooseInstallBackend,
  gcsBackendRecord,
  hasLocalPulumiState,
  parseStateBackend,
  resolveBackend,
} from "./state-backend.js";

const ROOT = "/home/op/.caelo-gcp-acme";
const GCS = gcsBackendRecord("acme", "europe-west1");

describe("resolveBackend", () => {
  it("local: file:// under the install dir, passphrase provider, passphrase in the env", () => {
    const b = resolveBackend(
      { installId: "gcp-acme" },
      { installRoot: ROOT, readPassphrase: () => "pp" },
    );
    expect(b).toEqual({
      kind: "local",
      url: `file://${ROOT}/state`,
      secretsProvider: "passphrase",
      envVars: {
        PULUMI_BACKEND_URL: `file://${ROOT}/state`,
        PULUMI_CONFIG_PASSPHRASE: "pp",
        PULUMI_FALLBACK_TO_STATE_SECRETS_MANAGER: "true",
      },
    });
  });

  it("local without a passphrase fails loudly instead of letting Pulumi prompt", () => {
    expect(() =>
      resolveBackend({ installId: "gcp-acme" }, { installRoot: ROOT, readPassphrase: () => null }),
    ).toThrow(/pulumi-passphrase is missing/);
  });

  it("gcs: the ops bucket + KMS key, no passphrase read or passed", () => {
    let read = false;
    const b = resolveBackend(
      { installId: "gcp-acme", stateBackend: GCS },
      {
        installRoot: ROOT,
        readPassphrase: () => {
          read = true;
          return "pp";
        },
      },
    );
    expect(read).toBe(false);
    expect(b.kind).toBe("gcs");
    expect(b.url).toBe("gs://acme-caelo-ops/pulumi");
    expect(b.secretsProvider).toBe(
      "gcpkms://projects/acme/locations/europe-west1/keyRings/caelo/cryptoKeys/pulumi-state",
    );
    expect(b.envVars).toEqual({
      PULUMI_BACKEND_URL: "gs://acme-caelo-ops/pulumi",
      PULUMI_FALLBACK_TO_STATE_SECRETS_MANAGER: "true",
    });
  });
});

describe("parseStateBackend", () => {
  it("accepts absent, local and a well-formed gcs record", () => {
    expect(parseStateBackend(undefined)).toBeUndefined();
    expect(parseStateBackend({ kind: "local" })).toEqual({ kind: "local" });
    expect(parseStateBackend({ ...GCS })).toEqual(GCS);
  });

  it("throws on anything else rather than pointing Pulumi at a guess", () => {
    expect(() => parseStateBackend({ kind: "s3" })).toThrow(/malformed/);
    expect(() =>
      parseStateBackend({ kind: "gcs", bucket: "gs://x", kmsKey: GCS.kmsKey }),
    ).toThrow();
    expect(() =>
      parseStateBackend({ kind: "gcs", bucket: "acme-caelo-ops", kmsKey: "k" }),
    ).toThrow();
  });
});

describe("backendShellEnv (recovery commands the CLI prints)", () => {
  it("never inlines the passphrase", () => {
    const local = backendShellEnv({}, ROOT);
    expect(local).toContain(`PULUMI_BACKEND_URL=file://${ROOT}/state`);
    expect(local).toContain(`"$(cat ${ROOT}/secrets/pulumi-passphrase)"`);
  });

  it("gcs needs no secret at all", () => {
    expect(backendShellEnv({ stateBackend: GCS }, ROOT)).toBe(
      "PULUMI_BACKEND_URL=gs://acme-caelo-ops/pulumi PULUMI_FALLBACK_TO_STATE_SECRETS_MANAGER=true",
    );
  });
});

describe("chooseInstallBackend", () => {
  it("new GCP installs go to the ops bucket", () => {
    expect(chooseInstallBackend({ provider: "gcp" }, false)).toBe("gcs");
    expect(chooseInstallBackend({ provider: "gcp-firebase" }, false)).toBe("gcs");
  });

  it("an older install with state on this machine stays local (never moved by a re-run)", () => {
    expect(chooseInstallBackend({ provider: "gcp-firebase" }, true)).toBe("local");
  });

  it("a deployed install with no state anywhere stops instead of starting an empty stack", () => {
    expect(() =>
      chooseInstallBackend({ installId: "gcp-acme", provider: "gcp" }, false, true),
    ).toThrow(/neither recorded/);
  });

  it("a recorded backend wins; self-hosted stays local", () => {
    expect(chooseInstallBackend({ provider: "gcp", stateBackend: GCS }, true)).toBe("gcs");
    expect(chooseInstallBackend({ provider: "gcp", stateBackend: { kind: "local" } }, false)).toBe(
      "local",
    );
    expect(chooseInstallBackend({ provider: "self-hosted" }, false)).toBe("local");
  });
});

describe("hasLocalPulumiState", () => {
  it("is true only when the DIY backend holds a stack", () => {
    const root = mkdtempSync(join(tmpdir(), "caelo-state-"));
    try {
      expect(hasLocalPulumiState(root)).toBe(false);
      mkdirSync(join(root, "state", ".pulumi", "stacks", "caelo-gcp"), { recursive: true });
      expect(hasLocalPulumiState(root)).toBe(true);
      rmSync(join(root, "state", ".pulumi", "stacks", "caelo-gcp"), { recursive: true });
      expect(hasLocalPulumiState(root)).toBe(false);
      writeFileSync(join(root, "state", ".pulumi", "stacks", "production.json"), "{}");
      expect(hasLocalPulumiState(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
