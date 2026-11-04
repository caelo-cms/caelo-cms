// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  checkDeployedRuntimeEnv,
  chooseImageDigests,
  digestFromImageRef,
  readDeployedImageDigests,
  readDeployedRegion,
} from "./deployed-release.js";
import type { GcloudResult } from "./gcloud.js";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const C = `sha256:${"c".repeat(64)}`;
const REG = "europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

/** Fake gcloud answering by command prefix; records every call. */
function fakeGcloud(answers: Record<string, GcloudResult[]>) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const key = Object.keys(answers).find((k) => args.join(" ").includes(k));
    return (key && answers[key]?.shift()) || ok();
  };
  return { run, calls };
}

/**
 * A gcp-firebase install since #1328: the admin, the data gateway and the
 * MCP-Auth-Proxy — the service that was the gateway (E13 a).
 */
const FIREBASE = { provider: "gcp-firebase" as const, projectId: "p", region: "europe-west1" };
const firebaseLists = () => ({
  "metadata.name~^caelo-production-admin": [ok("caelo-production-admin-abc\n")],
  "metadata.name~^caelo-production-data-gateway": [ok("caelo-production-data-gateway\n")],
  "metadata.name~^caelo-production-gateway": [ok("caelo-production-gateway-def\n")],
});

describe("digestFromImageRef", () => {
  it("extracts the pinned digest", () => {
    expect(digestFromImageRef(`${REG}/admin@${A}\n`)).toBe(A);
  });
  it("is null for a tag reference", () => {
    expect(digestFromImageRef(`${REG}/admin:latest`)).toBeNull();
  });
});

describe("readDeployedImageDigests", () => {
  it("reads the three services' digests, each from the service playing its role", async () => {
    const { run, calls } = fakeGcloud({
      ...firebaseLists(),
      "describe caelo-production-admin-abc": [ok(`${REG}/admin@${A}`)],
      "describe caelo-production-data-gateway": [ok(`${REG}/gateway@${B}`)],
      "describe caelo-production-gateway-def": [ok(`${REG}/mcp-auth-proxy@${C}`)],
    });
    const r = await readDeployedImageDigests({ ...FIREBASE, run });
    expect(r).toEqual({ ok: true, digests: { admin: A, gateway: B, "mcp-auth-proxy": C } });
    expect(calls.every((c) => c.includes("--project=p"))).toBe(true);
  });

  it("finds the gcp proxy under its own name", async () => {
    const { run } = fakeGcloud({
      "metadata.name~^caelo-production-admin": [ok("caelo-production-admin-abc\n")],
      "metadata.name~^caelo-production-gateway": [ok("caelo-production-gateway-def\n")],
      "metadata.name~^caelo-production-mcp-auth-proxy": [ok("caelo-production-mcp-auth-proxy\n")],
      "describe caelo-production-admin-abc": [ok(`${REG}/admin@${A}`)],
      "describe caelo-production-gateway-def": [ok(`${REG}/gateway@${B}`)],
      "describe caelo-production-mcp-auth-proxy": [ok(`${REG}/mcp-auth-proxy@${C}`)],
    });
    const r = await readDeployedImageDigests({ ...FIREBASE, provider: "gcp", run });
    expect(r).toEqual({ ok: true, digests: { admin: A, gateway: B, "mcp-auth-proxy": C } });
  });

  it("sends an install without its #1328 services to upgrade", async () => {
    const { run } = fakeGcloud({
      "metadata.name~^caelo-production-admin": [ok("caelo-production-admin-abc\n")],
      "metadata.name~^caelo-production-data-gateway": [ok("")],
      "describe caelo-production-admin-abc": [ok(`${REG}/admin@${A}`)],
    });
    const r = await readDeployedImageDigests({ ...FIREBASE, run });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("no caelo-production-data-gateway* Cloud Run service");
      expect(r.error).toContain("Run `upgrade` first");
    }
  });

  it("refuses an ambiguous service match", async () => {
    const { run } = fakeGcloud({
      "metadata.name~^caelo-production-admin": [
        ok("caelo-production-admin-a\ncaelo-production-admin-b\n"),
      ],
    });
    const r = await readDeployedImageDigests({ ...FIREBASE, run });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toContain("found caelo-production-admin-a, caelo-production-admin-b");
  });

  it("refuses a service that runs a tag, not a digest", async () => {
    const { run } = fakeGcloud({
      "metadata.name~^caelo-production-admin": [ok("caelo-production-admin-abc\n")],
      "describe caelo-production-admin-abc": [ok(`${REG}/admin:latest`)],
    });
    const r = await readDeployedImageDigests({ ...FIREBASE, run });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not pinned to a digest");
  });

  it("#1330 — accepts a staging gateway on the gateway's image, refuses one on another", async () => {
    const answers = (staging: string) => ({
      ...firebaseLists(),
      "metadata.name~^caelo-production-staging-gateway": [ok("caelo-production-staging-gateway\n")],
      "describe caelo-production-admin-abc": [ok(`${REG}/admin@${A}`)],
      "describe caelo-production-data-gateway": [ok(`${REG}/gateway@${B}`)],
      "describe caelo-production-gateway-def": [ok(`${REG}/mcp-auth-proxy@${C}`)],
      "describe caelo-production-staging-gateway": [ok(`${REG}/gateway@${staging}`)],
    });
    const same = fakeGcloud(answers(B));
    expect(await readDeployedImageDigests({ ...FIREBASE, run: same.run })).toEqual({
      ok: true,
      digests: { admin: A, gateway: B, "mcp-auth-proxy": C },
    });
    expect(same.calls.some((c) => c.includes("caelo-production-staging-gateway"))).toBe(true);
    const other = fakeGcloud(answers(A));
    const r = await readDeployedImageDigests({ ...FIREBASE, run: other.run });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("the staging gateway runs");
  });

  it("surfaces a gcloud failure", async () => {
    const { run } = fakeGcloud({ "services list": [fail("PERMISSION_DENIED")] });
    const r = await readDeployedImageDigests({ ...FIREBASE, run });
    expect(r).toEqual({ ok: false, error: "list Cloud Run services: PERMISSION_DENIED" });
  });
});

describe("checkDeployedRuntimeEnv", () => {
  const svc = (env: unknown[]) =>
    ok(JSON.stringify({ spec: { template: { spec: { containers: [{ env }] } } } }));
  const secret = (name: string, id = "postgres-password") => ({
    name,
    valueFrom: { secretKeyRef: { name: `caelo-production-${id}`, key: "latest" } },
  });
  const adminOk = svc([
    secret("ADMIN_DATABASE_PASSWORD"),
    secret("PUBLIC_ADMIN_DATABASE_PASSWORD"),
    // #1329 — the staging database's pool: a release from before it is
    // refused here too and goes through `upgrade` first.
    secret("PUBLIC_STAGING_ADMIN_DATABASE_PASSWORD"),
  ]);
  const gatewayOk = svc([secret("PUBLIC_DATABASE_PASSWORD", "public-role-password")]);
  const proxyOk = svc([secret("CAELO_MCP_OAUTH_SEAL_KEY", "mcp-oauth-seal-key")]);

  it("passes once every service runs the current env", async () => {
    const { run } = fakeGcloud({
      ...firebaseLists(),
      "describe caelo-production-admin-abc": [adminOk],
      "describe caelo-production-data-gateway": [gatewayOk],
      "describe caelo-production-gateway-def": [proxyOk],
    });
    expect(await checkDeployedRuntimeEnv({ ...FIREBASE, run })).toEqual({ ok: true });
  });

  it("#1328 — stops a wizard re-run while the proxy is still the old gateway (database env)", async () => {
    const { run } = fakeGcloud({
      ...firebaseLists(),
      "describe caelo-production-admin-abc": [adminOk],
      "describe caelo-production-data-gateway": [gatewayOk],
      "describe caelo-production-gateway-def": [gatewayOk],
    });
    const r = await checkDeployedRuntimeEnv({ ...FIREBASE, run });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("PUBLIC_DATABASE_PASSWORD");
      expect(r.error).toContain("Run `upgrade` first");
    }
  });

  it("stops a wizard re-run on a gateway from before #635 (it needs its gateway_role pool)", async () => {
    const { run } = fakeGcloud({
      ...firebaseLists(),
      "describe caelo-production-admin-abc": [adminOk],
      "describe caelo-production-data-gateway": [
        svc([
          secret("GATEWAY_DATABASE_PASSWORD", "gateway-role-password"),
          secret("PUBLIC_DATABASE_PASSWORD", "public-role-password"),
        ]),
      ],
    });
    const r = await checkDeployedRuntimeEnv({ ...FIREBASE, run });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("GATEWAY_DATABASE_PASSWORD");
      expect(r.error).toContain("Run `upgrade` first");
    }
  });

  it("stops a wizard re-run on a gateway from before #613 (it needs the admin_role pool)", async () => {
    const { run } = fakeGcloud({
      ...firebaseLists(),
      "describe caelo-production-admin-abc": [adminOk],
      "describe caelo-production-data-gateway": [
        svc([secret("ADMIN_DATABASE_PASSWORD"), secret("PUBLIC_DATABASE_PASSWORD")]),
      ],
    });
    const r = await checkDeployedRuntimeEnv({ ...FIREBASE, run });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("ADMIN_DATABASE_PASSWORD");
      expect(r.error).toContain("Run `upgrade` first");
    }
  });

  it("stops a wizard re-run on an install upgrade hasn't moved over (password in the URL)", async () => {
    const { run } = fakeGcloud({
      ...firebaseLists(),
      "describe caelo-production-admin-abc": [
        svc([
          {
            name: "ADMIN_DATABASE_URL",
            value: "postgres://admin_role:pw@db1.p-label.europe-west1.sql-psa.goog:5432/cms_admin",
          },
        ]),
      ],
    });
    const r = await checkDeployedRuntimeEnv({ ...FIREBASE, run });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Run `upgrade` first");
      expect(r.error).not.toContain(":pw@");
    }
  });
});

describe("chooseImageDigests", () => {
  const latest = { admin: C, gateway: C, "mcp-auth-proxy": C };
  const recorded = { admin: A, gateway: B, "mcp-auth-proxy": C };
  const never = () => {
    throw new Error("must not be called");
  };

  it("keeps the recorded release", async () => {
    const r = await chooseImageDigests({
      recorded,
      deployed: true,
      readLive: never,
      resolveLatest: never,
    });
    expect(r).toEqual({ ok: true, source: "recorded", digests: recorded });
  });

  it("#1328 — sends a record from before the MCP-Auth-Proxy to upgrade instead of mixing releases", async () => {
    const r = await chooseImageDigests({
      recorded: { admin: A, gateway: B },
      deployed: true,
      readLive: never,
      resolveLatest: never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("records no mcp-auth-proxy image");
      expect(r.error).toContain("Run `upgrade` first");
    }
  });

  it("keeps what a provisioned install without a record runs (no :latest roll)", async () => {
    const r = await chooseImageDigests({
      recorded: null,
      deployed: true,
      readLive: async () => ({ ok: true, digests: recorded }),
      resolveLatest: never,
    });
    expect(r).toEqual({ ok: true, source: "live", digests: recorded });
  });

  it("stops and points at upgrade when the running release can't be read", async () => {
    const r = await chooseImageDigests({
      recorded: null,
      deployed: true,
      readLive: async () => ({ ok: false, error: "PERMISSION_DENIED" }),
      resolveLatest: never,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/PERMISSION_DENIED.*Run `upgrade` once/);
  });

  it("resolves the newest release only for a new install", async () => {
    const r = await chooseImageDigests({
      recorded: null,
      deployed: false,
      readLive: never,
      resolveLatest: async () => latest,
    });
    expect(r).toEqual({ ok: true, source: "latest", digests: latest });
  });
});

describe("readDeployedRegion (#607)", () => {
  it("reads the admin service's region across all regions", async () => {
    const { run, calls } = fakeGcloud({
      "metadata.name~^caelo-production-admin": [ok("europe-west1\n")],
    });
    expect(await readDeployedRegion({ projectId: "p", run })).toEqual({
      ok: true,
      region: "europe-west1",
    });
    expect(calls[0]?.some((a) => a.startsWith("--region"))).toBe(false);
  });

  it("is null when nothing is deployed", async () => {
    const { run } = fakeGcloud({ "metadata.name~^caelo-production-admin": [ok("")] });
    expect(await readDeployedRegion({ projectId: "p", run })).toEqual({ ok: true, region: null });
  });

  it("fails loudly when the services can't be listed", async () => {
    const { run } = fakeGcloud({
      "metadata.name~^caelo-production-admin": [fail("PERMISSION_DENIED")],
    });
    const r = await readDeployedRegion({ projectId: "p", run });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("PERMISSION_DENIED");
  });

  it("refuses to guess between several regions", async () => {
    const { run } = fakeGcloud({
      "metadata.name~^caelo-production-admin": [ok("europe-west1\nus-central1\n")],
    });
    const r = await readDeployedRegion({ projectId: "p", run });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("several regions");
  });
});
