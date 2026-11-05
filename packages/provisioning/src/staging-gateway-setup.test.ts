// SPDX-License-Identifier: MPL-2.0

/**
 * #1330 — the staging gateway's provisioning (staging-gateway-setup.ts): the
 * service with exactly its rights, and the edge that routes the staging host
 * to it and nowhere else, per provider (E11 of #763).
 */

import { describe, expect, it } from "bun:test";
import { generateDockerCompose } from "./compose.js";
import type { GcloudResult } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import { firebaseStagingSiteId } from "./gcp-names.js";
import type { HttpFetch } from "./runtime-secrets.js";
import {
  ensureStagingGatewayEdge,
  ensureStagingGatewayService,
  firebaseDesiredRecords,
  firebaseStagingSiteConfig,
  isFirebaseStagingConfig,
  planStagingHostRule,
  type StagingGatewayServiceInputs,
  stagingCertName,
  stagingGatewayDeployArgs,
} from "./staging-gateway-setup.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

/** Answers by the longest matching command prefix; anything else succeeds empty. */
function fakeGcloud(answers: Record<string, GcloudResult> = {}) {
  const calls: string[] = [];
  const run: GcloudRunner = async (args) => {
    const line = args.join(" ");
    calls.push(line);
    const key = Object.keys(answers)
      .filter((k) => line.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return key ? (answers[key] as GcloudResult) : ok();
  };
  return { run, calls };
}

const INPUTS: StagingGatewayServiceInputs = {
  provider: "gcp-firebase",
  projectId: "acme",
  region: "europe-west1",
  env: "production",
  domain: "acme.com",
  stagingHost: "staging.acme.com",
  gatewayImageRef: `registry/gateway@sha256:${"b".repeat(64)}`,
  databaseHost: "db1.p-label.europe-west1.sql-psa.goog",
  vpc: { network: "caelo-production-vpc", subnetwork: "caelo-production-subnet" },
};
const STG_SA = "caelo-production-stg-gw-sa@acme.iam.gserviceaccount.com";

describe("the staging gateway service", () => {
  it("deploys the gateway image as staging: its own account, its one login, no gate key", () => {
    const args = stagingGatewayDeployArgs(INPUTS).join(" ");
    expect(args).toContain("run deploy caelo-production-staging-gateway ");
    expect(args).toContain(`--image=${INPUTS.gatewayImageRef}`);
    expect(args).toContain(`--service-account=${STG_SA}`);
    expect(args).toContain("CAELO_GATEWAY_ENVIRONMENT=staging");
    expect(args).toContain("CAELO_STAGING_STORAGE=gs://acme-caelo-production-staging");
    expect(args).toContain("public_staging_role@db1.p-label.europe-west1.sql-psa.goog");
    expect(args).toContain(
      "PUBLIC_DATABASE_PASSWORD=caelo-production-public-staging-role-password:latest",
    );
    expect(args).not.toContain("STAGING_GATE_SECRET");
    expect(args).not.toContain("public_role@");
    expect(args).not.toContain("MEDIA_STORAGE_URL");
    expect(args).toContain("--network=caelo-production-vpc");
    // Firebase rewrites stop at 60 s; Hosting arrives from Google's edge.
    expect(args).toContain("--timeout=60");
    expect(args).toContain("--ingress=all");
    expect(stagingGatewayDeployArgs({ ...INPUTS, provider: "gcp" })).toContain(
      "--ingress=internal-and-cloud-load-balancing",
    );
  });

  it("gcp-firebase: creates a private staging bucket before the service; the account only reads it", async () => {
    const { run, calls } = fakeGcloud({
      [`iam service-accounts describe ${STG_SA}`]: fail("NOT_FOUND"),
      "storage buckets describe gs://acme-caelo-production-staging": fail("404 NOT_FOUND"),
      "run services describe caelo-production-staging-gateway": fail(
        "ERROR: Cannot find service [caelo-production-staging-gateway]",
      ),
    });
    const outcomes = await ensureStagingGatewayService(INPUTS, { run, sleep: async () => {} });
    expect(outcomes.every((o) => o.status !== "failed")).toBe(true);
    const at = (re: RegExp) => calls.findIndex((c) => re.test(c));
    const bucket = at(/^storage buckets create gs:\/\/acme-caelo-production-staging /);
    expect(calls[bucket]).toContain("--public-access-prevention");
    expect(calls[bucket]).toContain("--uniform-bucket-level-access");
    expect(bucket).toBeLessThan(at(/^run deploy caelo-production-staging-gateway /));
    // The staging gateway's grants: its login password, read on the staging bucket.
    const grants = calls.filter((c) => c.includes(`serviceAccount:${STG_SA}`));
    expect(grants).toEqual([
      expect.stringMatching(
        /^secrets add-iam-policy-binding caelo-production-public-staging-role-password .*secretAccessor/,
      ),
      expect.stringMatching(
        /^storage buckets add-iam-policy-binding gs:\/\/acme-caelo-production-staging .*--role=roles\/storage\.objectViewer/,
      ),
    ]);
    // Invokable without a Google identity: the gate is its own, on every host.
    expect(calls).toContainEqual(
      expect.stringMatching(
        /^run services add-iam-policy-binding caelo-production-staging-gateway .*--member=allUsers --role=roles\/run\.invoker/,
      ),
    );
  });

  it("gcp: the bucket exists already (the stack's); an existing service is not deployed again", async () => {
    const { run, calls } = fakeGcloud();
    const outcomes = await ensureStagingGatewayService(
      { ...INPUTS, provider: "gcp" },
      { run, sleep: async () => {} },
    );
    expect(outcomes.every((o) => o.status !== "failed")).toBe(true);
    expect(calls.some((c) => c.startsWith("storage buckets create"))).toBe(false);
    expect(calls.some((c) => c.startsWith("run deploy"))).toBe(false);
  });
});

describe("the gcp-firebase edge: a second Hosting site", () => {
  const LIVE_SITE = "caelo-production-site-abc123";
  const SITE = firebaseStagingSiteId("production", LIVE_SITE);

  function adminWith(site: string) {
    return {
      "run services list --region europe-west1 --project acme --filter metadata.name~^caelo-production-admin":
        ok("caelo-production-admin-aaa\n"),
      "run services describe caelo-production-admin-aaa": ok(
        JSON.stringify({
          spec: {
            template: {
              spec: { containers: [{ env: [{ name: "CAELO_FIREBASE_SITE", value: site }] }] },
            },
          },
        }),
      ),
    };
  }

  it("names the staging site after the live one, deterministically and within Hosting's limits", () => {
    expect(SITE).toMatch(/^caelo-production-stg-[0-9a-f]{6}$/);
    expect(firebaseStagingSiteId("production", LIVE_SITE)).toBe(SITE);
    expect(firebaseStagingSiteId("production", "other-site")).not.toBe(SITE);
    expect(SITE.length).toBeLessThanOrEqual(30);
  });

  it("creates the site, one `**` rewrite to the staging gateway, the custom domain; deletes the old mapping", async () => {
    const { run, calls } = fakeGcloud({
      ...adminWith(LIVE_SITE),
      "auth print-access-token": ok("tok\n"),
      // An existing Cloud Run domain mapping (#650) to the old gateway service.
      "beta run domain-mappings describe": ok("staging.acme.com\n"),
    });
    const requests: { method: string; url: string; body?: string }[] = [];
    const http: HttpFetch = async (url, init) => {
      requests.push({ method: init.method, url, ...(init.body ? { body: init.body } : {}) });
      const json = (status: number, body: unknown) => ({
        ok: status < 400,
        status,
        text: async () => JSON.stringify(body),
      });
      if (init.method === "GET" && url.endsWith(`/sites/${SITE}`)) return json(404, {});
      if (url.includes("/channels/live/releases")) return json(404, {});
      if (init.method === "POST" && url.includes(`/sites/${SITE}/versions`)) {
        return json(200, { name: `sites/${SITE}/versions/v1` });
      }
      if (init.method === "GET" && url.includes("/customDomains/staging.acme.com")) {
        const seen = requests.filter((r) => r.url.includes("/customDomains")).length;
        return seen === 1
          ? json(404, {})
          : json(200, {
              requiredDnsUpdates: {
                desired: [
                  {
                    records: [
                      { domainName: "staging.acme.com.", type: "A", rdata: "199.36.158.100" },
                    ],
                  },
                ],
              },
            });
      }
      return json(200, {});
    };
    const r = await ensureStagingGatewayEdge(
      {
        provider: "gcp-firebase",
        projectId: "acme",
        region: "europe-west1",
        env: "production",
        domain: "acme.com",
        stagingHost: "staging.acme.com",
      },
      { run, http },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dnsRecords).toEqual([
      { name: "staging.acme.com", type: "A", value: "199.36.158.100" },
    ]);
    const version = requests.find((q) => q.method === "POST" && q.url.endsWith("/versions"));
    expect(JSON.parse(version?.body ?? "{}")).toEqual({
      config: {
        rewrites: [
          {
            glob: "**",
            run: { serviceId: "caelo-production-staging-gateway", region: "europe-west1" },
          },
        ],
      },
    });
    expect(
      requests.some((q) => q.method === "POST" && q.url.includes("/releases?versionName=")),
    ).toBe(true);
    expect(
      requests.some(
        (q) =>
          q.method === "POST" && q.url.includes("customDomains?customDomainId=staging.acme.com"),
      ),
    ).toBe(true);
    // No second path to the staged files: the old mapping goes.
    expect(calls).toContainEqual(expect.stringMatching(/^beta run domain-mappings delete /));
  });

  it("waits for the records Firebase works out after the custom domain is created", async () => {
    const { run } = fakeGcloud({
      ...adminWith(LIVE_SITE),
      "auth print-access-token": ok("tok\n"),
      "beta run domain-mappings describe": fail("ERROR: Cannot find mapping [staging.acme.com]"),
    });
    let domainReads = 0;
    const sleeps: number[] = [];
    const http: HttpFetch = async (url, init) => {
      const json = (status: number, body: unknown) => ({
        ok: status < 400,
        status,
        text: async () => JSON.stringify(body),
      });
      if (init.method === "GET" && url.includes("/customDomains/staging.acme.com")) {
        domainReads++;
        // Not there yet, then created by this run: the first reads carry no records.
        if (domainReads === 1) return json(404, {});
        return json(
          200,
          domainReads < 4
            ? {}
            : {
                requiredDnsUpdates: {
                  desired: [
                    {
                      records: [
                        { domainName: "staging.acme.com.", type: "CNAME", rdata: "stg.web.app." },
                      ],
                    },
                  ],
                },
              },
        );
      }
      if (url.includes("/channels/live/releases")) return json(404, {});
      if (init.method === "POST" && url.includes("/versions")) {
        return json(200, { name: `sites/${SITE}/versions/v1` });
      }
      return json(200, {});
    };
    const r = await ensureStagingGatewayEdge(
      {
        provider: "gcp-firebase",
        projectId: "acme",
        region: "europe-west1",
        env: "production",
        domain: "acme.com",
        stagingHost: "staging.acme.com",
      },
      { run, http, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dnsRecords).toEqual([
      { name: "staging.acme.com", type: "CNAME", value: "stg.web.app." },
    ]);
    expect(sleeps).toHaveLength(2);
  });

  it("a site already serving the rewrite is not released again", () => {
    const t = { env: "production", region: "europe-west1" };
    expect(isFirebaseStagingConfig(firebaseStagingSiteConfig(t), t)).toBe(true);
    expect(
      isFirebaseStagingConfig({ ...firebaseStagingSiteConfig(t), redirects: [{ glob: "/x" }] }, t),
    ).toBe(false);
    expect(isFirebaseStagingConfig({ rewrites: [{ glob: "/api/**" }] }, t)).toBe(false);
    expect(isFirebaseStagingConfig(null, t)).toBe(false);
  });

  it("reads the DNS records Hosting asks for", () => {
    expect(firebaseDesiredRecords(null)).toEqual([]);
    expect(
      firebaseDesiredRecords({
        requiredDnsUpdates: {
          desired: [
            { records: [{ domainName: "s.example.com.", type: "TXT", rdata: "hosting=1" }] },
          ],
        },
      }),
    ).toEqual([{ name: "s.example.com", type: "TXT", value: "hosting=1" }]);
  });
});

describe("the gcp edge: the staging host's own rule on the load balancer", () => {
  const BACKEND =
    "https://compute/projects/acme/global/backendServices/caelo-production-staging-gateway-backend";
  const map = {
    name: "caelo-production-url-map-1",
    hostRules: [
      { hosts: ["acme.com"], pathMatcher: "public" },
      { hosts: ["admin.acme.com"], pathMatcher: "admin" },
    ],
    pathMatchers: [
      { name: "public", defaultService: "static" },
      { name: "admin", defaultService: "admin" },
    ],
  };
  const t = { env: "production", domain: "acme.com", stagingHost: "staging.acme.com" };

  it("routes the staging host, every path, to the staging gateway's backend; keeps every other rule", () => {
    const next = planStagingHostRule(map, t, BACKEND);
    expect(next?.hostRules).toEqual([
      ...map.hostRules,
      { hosts: ["staging.acme.com"], pathMatcher: "staging" },
    ]);
    expect(next?.pathMatchers).toEqual([
      ...map.pathMatchers,
      { name: "staging", defaultService: BACKEND },
    ]);
  });

  it("creates the backend, attaches Cloud Armor by update, and names the one external address", async () => {
    const proxy = "caelo-production-https-proxy-1";
    const { run, calls } = fakeGcloud({
      "compute network-endpoint-groups describe": fail("NOT_FOUND: was not found"),
      "compute network-endpoint-groups create": ok(),
      "compute security-policies list": ok("caelo-production-waf-1\n"),
      "compute backend-services describe": fail("NOT_FOUND: was not found"),
      "compute backend-services create": ok(JSON.stringify([{ selfLink: BACKEND }])),
      "compute backend-services update": ok(),
      "compute backend-services add-backend": ok(),
      "compute ssl-certificates describe": ok("{}"),
      // Routed already: the REST update of the map has its own tests.
      "compute url-maps list": ok(JSON.stringify([planStagingHostRule(map, t, BACKEND)])),
      "compute target-https-proxies list": ok(
        JSON.stringify([{ name: proxy, sslCertificates: [] }]),
      ),
      "compute target-https-proxies update": ok(),
      "compute url-maps import": ok(),
      "compute addresses list": ok("136.81.196.111\n"),
    });
    const r = await ensureStagingGatewayEdge(
      {
        provider: "gcp",
        projectId: "acme",
        region: "europe-west1",
        env: "production",
        domain: "acme.com",
        stagingHost: "staging.acme.com",
      },
      { run },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.dnsRecords).toEqual([
      { name: "staging.acme.com", type: "A", value: "136.81.196.111" },
    ]);
    expect(calls.find((c) => c.startsWith("compute backend-services create"))).not.toContain(
      "--security-policy",
    );
    expect(calls.find((c) => c.startsWith("compute backend-services update"))).toContain(
      "--security-policy=",
    );
    expect(calls.find((c) => c.startsWith("compute addresses list"))).toContain(
      "addressType=EXTERNAL",
    );
  });

  it("is a no-op when the map already routes it, and moves a changed staging host", () => {
    const routed = planStagingHostRule(map, t, BACKEND);
    if (!routed) throw new Error("expected a plan");
    expect(planStagingHostRule(routed, t, BACKEND)).toBeNull();
    // The stack's fail-closed placeholder (a redirect, no backend) is replaced.
    const placeholder = {
      ...routed,
      pathMatchers: [
        ...map.pathMatchers,
        { name: "staging", defaultUrlRedirect: { hostRedirect: "acme.com" } },
      ],
    };
    expect(planStagingHostRule(placeholder, t, BACKEND)?.pathMatchers?.at(-1)).toEqual({
      name: "staging",
      defaultService: BACKEND,
    });
    const moved = planStagingHostRule(routed, { ...t, stagingHost: "preview.acme.com" }, BACKEND);
    expect(moved?.hostRules?.at(-1)).toEqual({
      hosts: ["preview.acme.com"],
      pathMatcher: "staging",
    });
    expect(moved?.hostRules).toHaveLength(3);
  });

  it("names one certificate per staging host", () => {
    expect(stagingCertName("production", "staging.acme.com")).toMatch(
      /^caelo-production-staging-cert-[0-9a-f]{6}$/,
    );
    expect(stagingCertName("production", "staging.acme.com")).not.toBe(
      stagingCertName("production", "preview.acme.com"),
    );
  });
});

describe("self-hosted: the staging gateway container", () => {
  const compose = generateDockerCompose({
    domain: "example.com",
    stagingHost: "staging.example.com",
    stagingGateSecret: "g".repeat(64),
    postgresPassword: "pg",
    rolePasswords: { admin: "a", public: "p", publicStaging: "ps" },
    caeloSecretKek: "k".repeat(64),
    internalSecret: "i".repeat(48),
    dbTlsServerCertSha256: "c".repeat(64),
    diskSize: "20Gi",
    images: {
      mode: "release",
      admin: `ghcr.io/caelo-cms/admin@sha256:${"a".repeat(64)}`,
      gateway: `ghcr.io/caelo-cms/gateway@sha256:${"b".repeat(64)}`,
    },
    ports: { http: 80, https: 443 },
    project: "caelo",
  });
  const service = (name: string) => {
    const start = compose.indexOf(`\n  ${name}:\n`);
    const end = compose.indexOf("\n\n", start + 1);
    return compose.slice(start, end === -1 ? undefined : end);
  };

  it("runs the gateway image as staging, reading only output/staging, read-only", () => {
    const stg = service("caelo-staging-gateway");
    expect(stg).toContain(`image: ghcr.io/caelo-cms/gateway@sha256:${"b".repeat(64)}`);
    expect(stg).toContain('CAELO_GATEWAY_ENVIRONMENT: "staging"');
    expect(stg).toContain("./output/output/staging:/srv/staging:ro");
    expect(stg).not.toContain("./output:");
    expect(stg).toContain('CAELO_STAGING_STORAGE: "file:///srv/staging"');
    expect(stg).toContain("public_staging_role:ps@");
    expect(stg).not.toContain("public_role:");
    expect(stg).not.toContain("CAELO_STAGING_GATE_SECRET");
  });

  it("gives the admin the gate key and the staging gateway's internal URL; the live gateway neither", () => {
    const admin = service("caelo-admin");
    expect(admin).toContain(`CAELO_STAGING_GATE_SECRET: "${"g".repeat(64)}"`);
    expect(admin).toContain('CAELO_STAGING_GATEWAY_URL: "http://caelo-staging-gateway:8091"');
    expect(admin).toContain('CAELO_STAGING_HOST: "staging.example.com"');
    expect(service("caelo-gateway")).not.toContain("STAGING_GATE");
  });
});
