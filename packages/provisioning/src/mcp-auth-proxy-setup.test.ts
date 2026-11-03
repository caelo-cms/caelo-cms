// SPDX-License-Identifier: MPL-2.0

/**
 * #1328 — the services an upgrade to the MCP-Auth-Proxy release creates on
 * installs whose stack predates them (mcp-auth-proxy-setup.ts): the proxy's
 * account and its two secret grants, the gcp-firebase data gateway copied
 * from the old gateway service, and the gcp proxy service.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import {
  cloneServiceSpec,
  ensureReleaseServices,
  gcpProxyDeployArgs,
  type ReleaseServicesTarget,
} from "./mcp-auth-proxy-setup.js";
import { MCP_AUTH_PROXY_TIMEOUT_SECONDS } from "./stack-contract.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

/** Answers by the longest matching command prefix; anything else is an error. */
function fakeGcloud(answers: Record<string, GcloudResult>) {
  const calls: string[] = [];
  const run: GcloudRunner = async (args) => {
    const line = args.join(" ");
    calls.push(line);
    const key = Object.keys(answers)
      .filter((k) => line.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return key ? (answers[key] as GcloudResult) : fail(`unexpected: ${line}`);
  };
  return { run, calls };
}

const IMAGE = "europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images";
const PROXY_SA = "caelo-production-mcp-proxy-sa@acme.iam.gserviceaccount.com";

const firebase: ReleaseServicesTarget = {
  provider: "gcp-firebase",
  projectId: "acme",
  region: "europe-west1",
  env: "production",
  domain: "acme.com",
  mcpAuthProxyImageRef: `${IMAGE}/mcp-auth-proxy@sha256:${"c".repeat(64)}`,
};
const gcp: ReleaseServicesTarget = { ...firebase, provider: "gcp" };

/** The old gateway service as `gcloud run services describe --format=json` shows it. */
const OLD_GATEWAY = {
  apiVersion: "serving.knative.dev/v1",
  kind: "Service",
  metadata: {
    name: "caelo-production-gateway-bbb",
    namespace: "123456",
    uid: "u-1",
    resourceVersion: "AAY",
    generation: 42,
    creationTimestamp: "2026-01-01T00:00:00Z",
    selfLink:
      "/apis/serving.knative.dev/v1/namespaces/123456/services/caelo-production-gateway-bbb",
    labels: {
      "cloud.googleapis.com/location": "europe-west1",
      "goog-terraform-provisioned": "true",
      team: "web",
    },
    annotations: {
      "run.googleapis.com/ingress": "all",
      "run.googleapis.com/ingress-status": "all",
      "serving.knative.dev/creator": "someone@acme.com",
      "serving.knative.dev/lastModifier": "someone@acme.com",
      "run.googleapis.com/operation-id": "op-1",
      "run.googleapis.com/client-name": "gcloud",
    },
  },
  spec: {
    template: {
      metadata: {
        name: "caelo-production-gateway-bbb-00042-abc",
        labels: {
          "client.knative.dev/nonce": "n",
          "run.googleapis.com/startupProbeType": "Default",
        },
        annotations: {
          "autoscaling.knative.dev/maxScale": "10",
          "run.googleapis.com/network-interfaces": '[{"network":"caelo-production-vpc"}]',
          "run.googleapis.com/vpc-access-egress": "private-ranges-only",
          "run.googleapis.com/client-name": "gcloud",
          "run.googleapis.com/client-version": "500.0.0",
        },
      },
      spec: {
        serviceAccountName: "caelo-production-gateway-sa@acme.iam.gserviceaccount.com",
        timeoutSeconds: 3600,
        containers: [
          {
            image: `${IMAGE}/gateway@sha256:${"b".repeat(64)}`,
            env: [
              { name: "CAELO_PROVIDER", value: "gcp-firebase" },
              {
                name: "PUBLIC_DATABASE_PASSWORD",
                valueFrom: {
                  secretKeyRef: { name: "caelo-production-public-role-password", key: "latest" },
                },
              },
            ],
          },
        ],
      },
    },
    traffic: [{ revisionName: "caelo-production-gateway-bbb-00041-old", percent: 100 }],
  },
  status: {
    url: "https://caelo-production-gateway-bbb-xyz.a.run.app",
    latestReadyRevisionName: "x",
  },
};

describe("cloneServiceSpec", () => {
  const clone = JSON.parse(
    cloneServiceSpec(JSON.stringify(OLD_GATEWAY), "caelo-production-data-gateway"),
  );

  it("names the copy and drops the source's identity, status and tool stamps", () => {
    expect(clone.metadata).toEqual({
      name: "caelo-production-data-gateway",
      labels: { team: "web" },
      annotations: { "run.googleapis.com/ingress": "all" },
    });
    expect(clone.status).toBeUndefined();
    expect(clone.spec.template.metadata.name).toBeUndefined();
    expect(clone.spec.template.metadata.labels).toEqual({});
    expect(clone.spec.template.metadata.annotations).toEqual({
      "autoscaling.knative.dev/maxScale": "10",
      "run.googleapis.com/network-interfaces": '[{"network":"caelo-production-vpc"}]',
      "run.googleapis.com/vpc-access-egress": "private-ranges-only",
    });
  });

  it("keeps the configuration — image, env, secrets, account, timeout — and routes all traffic to the new revision", () => {
    expect(clone.spec.template.spec).toEqual(OLD_GATEWAY.spec.template.spec);
    expect(clone.spec.traffic).toEqual([{ percent: 100, latestRevision: true }]);
    expect(clone.apiVersion).toBe("serving.knative.dev/v1");
    expect(clone.kind).toBe("Service");
  });

  it("refuses to copy a service that runs no gateway image (the proxy the old service became)", () => {
    const proxy = structuredClone(OLD_GATEWAY);
    (proxy.spec.template.spec.containers[0] as { image: string }).image =
      `${IMAGE}/mcp-auth-proxy@sha256:${"c".repeat(64)}`;
    expect(() => cloneServiceSpec(JSON.stringify(proxy), "x")).toThrow("not a Caelo gateway image");
  });
});

describe("gcpProxyDeployArgs", () => {
  it("deploys the proxy load-balancer-only, public, at zero instances, without a VPC, with its two secrets", () => {
    const args = gcpProxyDeployArgs(gcp);
    expect(args.slice(0, 3)).toEqual(["run", "deploy", "caelo-production-mcp-auth-proxy"]);
    expect(args).toContain(`--image=${gcp.mcpAuthProxyImageRef}`);
    expect(args).toContain(`--service-account=${PROXY_SA}`);
    expect(args).toContain("--ingress=internal-and-cloud-load-balancing");
    expect(args).toContain("--allow-unauthenticated");
    expect(args).toContain("--min-instances=0");
    expect(args).toContain("--cpu-throttling");
    expect(args).toContain(`--timeout=${MCP_AUTH_PROXY_TIMEOUT_SECONDS}`);
    expect(args.some((a) => a.startsWith("--network") || a.startsWith("--vpc"))).toBe(false);
    expect(args).toContain(
      "--set-env-vars=CAELO_PROVIDER=gcp,CAELO_REMOTE_MCP=available,CAELO_TRUSTED_PROXY_HOPS=2,CAELO_OPERATOR_OAUTH_CLIENT_FILE=/secrets/operator-oauth-client/client.json,CAELO_ADMIN_URL=https://admin.acme.com,CAELO_MCP_PUBLIC_URL=https://acme.com",
    );
    expect(args).toContain(
      "--set-secrets=CAELO_MCP_OAUTH_SEAL_KEY=caelo-production-mcp-oauth-seal-key:latest,/secrets/operator-oauth-client/client.json=caelo-production-operator-oauth-client:latest",
    );
    // Nothing that would hand it a database: no URL, no password.
    expect(args.join(" ")).not.toMatch(/DATABASE|public-role-password|postgres-password/);
  });
});

/** The account and its two grants, as a fresh install answers them. */
const accountAndGrants = {
  [`iam service-accounts describe ${PROXY_SA}`]: fail("NOT_FOUND: does not exist"),
  "iam service-accounts create caelo-production-mcp-proxy-sa": ok(),
  "secrets add-iam-policy-binding": ok(),
};

describe("ensureReleaseServices", () => {
  it("gcp-firebase: creates the account, grants exactly its two secrets and copies the old gateway", async () => {
    const written: string[] = [];
    let cleaned = false;
    const { run, calls } = fakeGcloud({
      ...accountAndGrants,
      // gcloud's real wording: no NOT_FOUND code (searchVIU, 2026-11-03).
      "run services describe caelo-production-data-gateway": fail(
        "ERROR: (gcloud.run.services.describe) Cannot find service [caelo-production-data-gateway]",
      ),
      "run services list": ok("caelo-production-gateway-bbb\n"),
      "run services describe caelo-production-gateway-bbb": ok(JSON.stringify(OLD_GATEWAY)),
      "run services replace": ok(),
    });
    const outcomes = await ensureReleaseServices(firebase, {
      run,
      writeSpecFile: (json) => {
        written.push(json);
        return {
          path: "/tmp/spec.json",
          cleanup: () => {
            cleaned = true;
          },
        };
      },
    });
    expect(outcomes.map((o) => o.status)).toEqual(["applied", "present", "present", "applied"]);
    expect(calls.filter((c) => c.startsWith("secrets add-iam-policy-binding"))).toEqual([
      `secrets add-iam-policy-binding caelo-production-mcp-oauth-seal-key --project=acme --member=serviceAccount:${PROXY_SA} --role=roles/secretmanager.secretAccessor --condition=None --quiet`,
      `secrets add-iam-policy-binding caelo-production-operator-oauth-client --project=acme --member=serviceAccount:${PROXY_SA} --role=roles/secretmanager.secretAccessor --condition=None --quiet`,
    ]);
    // Never a project role.
    expect(calls.some((c) => c.startsWith("projects add-iam-policy-binding"))).toBe(false);
    // The copy's source is the service the proxy prefix finds — the old gateway.
    expect(calls).toContain(
      "run services list --region europe-west1 --project acme --filter metadata.name~^caelo-production-gateway --format=value(metadata.name)",
    );
    expect(JSON.parse(written[0] as string).metadata.name).toBe("caelo-production-data-gateway");
    expect(calls).toContain(
      "run services replace /tmp/spec.json --region=europe-west1 --project=acme --quiet",
    );
    expect(cleaned).toBe(true);
    // No new image is deployed: the copy runs what serves today.
    expect(calls.some((c) => c.startsWith("run deploy"))).toBe(false);
  });

  it("gcp-firebase: a data gateway that exists already is left alone", async () => {
    const { run, calls } = fakeGcloud({
      [`iam service-accounts describe ${PROXY_SA}`]: ok(`${PROXY_SA}\n`),
      "secrets add-iam-policy-binding": ok(),
      "run services describe caelo-production-data-gateway": ok("caelo-production-data-gateway\n"),
    });
    const outcomes = await ensureReleaseServices(firebase, { run });
    expect(outcomes.map((o) => o.status)).toEqual(["present", "present", "present", "present"]);
    expect(calls.some((c) => c.includes("replace") || c.includes("create"))).toBe(false);
  });

  it("gcp-firebase: refuses to copy when the old service already runs the proxy image", async () => {
    const proxy = structuredClone(OLD_GATEWAY);
    (proxy.spec.template.spec.containers[0] as { image: string }).image =
      `${IMAGE}/mcp-auth-proxy@sha256:${"c".repeat(64)}`;
    const { run, calls } = fakeGcloud({
      ...accountAndGrants,
      "run services describe caelo-production-data-gateway": fail("NOT_FOUND: could not be found"),
      "run services list": ok("caelo-production-gateway-bbb\n"),
      "run services describe caelo-production-gateway-bbb": ok(JSON.stringify(proxy)),
    });
    const outcomes = await ensureReleaseServices(firebase, { run });
    const last = outcomes.at(-1);
    expect(last?.status).toBe("failed");
    expect(last?.error).toContain("Re-run the installer");
    expect(calls.some((c) => c.startsWith("run services replace"))).toBe(false);
  });

  it("gcp: deploys the proxy service with the release's image when it is missing", async () => {
    const { run, calls } = fakeGcloud({
      ...accountAndGrants,
      "run services describe caelo-production-mcp-auth-proxy": fail(
        "NOT_FOUND: could not be found",
      ),
      "run deploy caelo-production-mcp-auth-proxy": ok(),
    });
    const outcomes = await ensureReleaseServices(gcp, { run });
    expect(outcomes.map((o) => o.status)).toEqual(["applied", "present", "present", "applied"]);
    expect(calls).toContain(gcpProxyDeployArgs(gcp).join(" "));
  });

  it("gcp: an existing proxy service is not deployed again", async () => {
    const { run, calls } = fakeGcloud({
      [`iam service-accounts describe ${PROXY_SA}`]: ok(`${PROXY_SA}\n`),
      "secrets add-iam-policy-binding": ok(),
      "run services describe caelo-production-mcp-auth-proxy": ok(
        "caelo-production-mcp-auth-proxy\n",
      ),
    });
    const outcomes = await ensureReleaseServices(gcp, { run });
    expect(outcomes.at(-1)?.status).toBe("present");
    expect(calls.some((c) => c.startsWith("run deploy"))).toBe(false);
  });

  it("stops before any service when a grant fails (Cloud Run would refuse the revision)", async () => {
    const { run, calls } = fakeGcloud({
      ...accountAndGrants,
      "secrets add-iam-policy-binding caelo-production-operator-oauth-client": fail(
        "PERMISSION_DENIED: secretmanager.secrets.setIamPolicy",
      ),
    });
    const outcomes = await ensureReleaseServices(gcp, { run });
    expect(outcomes.map((o) => o.status)).toEqual(["applied", "present", "failed"]);
    expect(calls.some((c) => c.startsWith("run "))).toBe(false);
  });

  it("retries a grant while the account it just created has not propagated", async () => {
    const { run: base, calls } = fakeGcloud({
      ...accountAndGrants,
      "run services describe caelo-production-mcp-auth-proxy": ok(
        "caelo-production-mcp-auth-proxy\n",
      ),
    });
    let refusals = 2;
    const run: GcloudRunner = async (args, opts) => {
      if (args[0] === "secrets" && refusals > 0) {
        refusals -= 1;
        return fail(
          `ERROR: (gcloud.secrets.add-iam-policy-binding) Status code: 400. Service account ${PROXY_SA} does not exist..`,
        );
      }
      return base(args, opts);
    };
    const pauses: number[] = [];
    const outcomes = await ensureReleaseServices(gcp, {
      run,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(outcomes.map((o) => o.status)).toEqual(["applied", "present", "present", "present"]);
    expect(pauses.length).toBe(2);
    expect(calls.filter((c) => c.startsWith("secrets add-iam-policy-binding"))).toHaveLength(2);
  });

  it("stops at once when the account cannot be read", async () => {
    const { run, calls } = fakeGcloud({
      [`iam service-accounts describe ${PROXY_SA}`]: fail("PERMISSION_DENIED"),
    });
    const outcomes = await ensureReleaseServices(firebase, { run });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("failed");
    expect(calls).toHaveLength(1);
  });
});
