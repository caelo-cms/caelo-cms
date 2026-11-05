// SPDX-License-Identifier: MPL-2.0

/**
 * Per-resource static price table for the GCP stack — used by the
 * wizard's pre-flight cost estimate. Prices are EUR/USD per month at
 * `europe-west1` list rates as of 2026-05; ship updates with each
 * Caelo release.
 *
 * The estimate is intentionally OVER-conservative — it shows the
 * floor cost (idle + scale-to-zero traffic). Real usage adds egress
 * + AI calls + storage growth on top.
 */

import { GATEWAY_ARMOR_BILLED_RULES } from "../gateway-edge.js";
import {
  ADMIN_MEMORY_DEFAULT,
  memoryQuantityMiB,
  parseSchedulerIntervalMinutes,
  RUNTIME_SECRETS,
  SERVICE_CPU_IDLE,
} from "../stack-contract.js";

export interface CostLine {
  name: string;
  monthlyUsd: number;
  notes?: string;
}

export interface CostEstimateInputs {
  cloudSqlTier: string; // e.g. "db-f1-micro"
  cloudSqlHa: boolean;
  adminMinInstances: number;
  /**
   * #553 — admin memory (`2Gi`). Cloud Run bills memory only while an
   * instance runs, so it costs nothing extra at scale-to-zero and
   * ~$6.50/mo per GiB above 1 GiB for each always-on min instance.
   */
  adminMemory?: string;
  gatewayMinInstances: number;
  wafAdaptiveProtection: boolean;
  /**
   * v0.3.3 — provider variant. 'gcp' is the LB-fronted topology
   * (+$18 LB + Cloud CDN + Cloud Armor lines). 'gcp-firebase'
   * drops all three (no LB, Firebase Hosting native CDN, no Cloud
   * Armor) — saves ~$19/mo. Defaults to 'gcp' for backwards
   * compatibility.
   */
  provider?: "gcp" | "gcp-firebase";
  /** #607 — the install region; shown in the table (prices are {@link PRICED_REGION} rates). */
  region: string;
  /** #1140 — the `schedulerIntervalMinutes` knob (1–15); undefined: the default. */
  schedulerIntervalMinutes?: number;
}

/**
 * #1140 — Workflows steps one scheduler tick costs (scheduler-setup.ts
 * schedulerWorkflowSource): the claims `assign`, the signJwt call (a Google
 * API, billed as an internal step), the `return` — and the POST to the
 * admin, the one external HTTP step.
 */
export const SCHEDULER_TICK_STEPS = { internal: 3, external: 1 } as const;

/**
 * Workflows list prices (USD, cloud.google.com/workflows/pricing, as of
 * 2026-11) and the monthly free tier per billing account.
 */
const WORKFLOWS_PRICE = {
  internalPer1000: 0.01,
  externalPer1000: 0.025,
  freeInternal: 5_000,
  freeExternal: 2_000,
} as const;

/** Cloud Scheduler: $0.10 per job a month; the first 3 per billing account are free. */
const SCHEDULER_JOB_USD = 0.1;

/**
 * #1140 — what the scheduler tick costs a month at `minutes` between ticks:
 * the Cloud Scheduler job (priced as paid — the 3 free jobs are shared
 * with every other project on the billing account) plus the Workflows
 * steps past the free tier. What the tick costs on the admin's side is
 * priced on the admin's own line ({@link adminKeptWarmByTicks}).
 */
export function schedulerTickMonthlyUsd(minutes: number): number {
  const ticks = Math.ceil((30 * 24 * 60) / parseSchedulerIntervalMinutes(minutes));
  const internal = Math.max(
    0,
    ticks * SCHEDULER_TICK_STEPS.internal - WORKFLOWS_PRICE.freeInternal,
  );
  const external = Math.max(
    0,
    ticks * SCHEDULER_TICK_STEPS.external - WORKFLOWS_PRICE.freeExternal,
  );
  const usd =
    SCHEDULER_JOB_USD +
    (internal / 1000) * WORKFLOWS_PRICE.internalPer1000 +
    (external / 1000) * WORKFLOWS_PRICE.externalPer1000;
  return Math.round(usd * 100) / 100;
}

/**
 * Cloud Run instance-based billing (CPU always allocated) list rates, USD,
 * tier-1 region, cloud.google.com/run/pricing as of 2026-11. The free tier
 * is left out: it is shared by every service on the billing account.
 */
const CLOUD_RUN_INSTANCE_PRICE = { vcpuSecond: 0.000018, gibSecond: 0.000002 } as const;

/** Seconds in the 30-day month the table prices. */
const MONTH_SECONDS = 30 * 24 * 60 * 60;

/**
 * #1140 — whether the scheduler tick keeps a scale-to-zero admin instance
 * up around the clock. Cloud Run keeps an idle instance for up to 15
 * minutes after its last request, and the tick comes at most every 15
 * minutes, so with CPU always allocated (`SERVICE_CPU_IDLE.admin` false
 * until #1361) the instance never stops and is billed every second. With
 * request-billed CPU an idle instance costs nothing between ticks.
 */
export function adminKeptWarmByTicks(adminMinInstances: number): boolean {
  return adminMinInstances === 0 && !SERVICE_CPU_IDLE.admin;
}

/** One always-on admin instance (1 vCPU, `gib` memory) a month at instance-based list rates. */
export function alwaysOnAdminInstanceUsd(gib: number): number {
  const perSecond = CLOUD_RUN_INSTANCE_PRICE.vcpuSecond + gib * CLOUD_RUN_INSTANCE_PRICE.gibSecond;
  return Math.round(perSecond * MONTH_SECONDS);
}

/**
 * Cloud Armor Standard list prices, USD a month (cloud.google.com/armor/pricing,
 * checked 2026-11-02): $0.006849315 per policy-hour and $0.001369863 per
 * rule-hour, rounded; plus $0.75 per million requests on a global policy.
 */
export const CLOUD_ARMOR_POLICY_USD = 5;
export const CLOUD_ARMOR_RULE_USD = 1;

/**
 * Secret Manager: $0.06 per active secret version a month, the first 6 per
 * billing account free (cloud.google.com/secret-manager/pricing); access
 * operations are cents at Caelo's volume.
 */
const SECRET_VERSION_USD = 0.06;
const SECRET_FREE_VERSIONS = 6;

/** What `count` secrets with one active version each cost a month. */
export function secretManagerMonthlyUsd(count: number): number {
  return Math.round(Math.max(0, count - SECRET_FREE_VERSIONS) * SECRET_VERSION_USD * 100) / 100;
}

/** The region the price table's list rates are for. */
const PRICED_REGION = "europe-west1";

const SQL_TIER_USD: Record<string, number> = {
  // Shared-core legacy tiers, ENTERPRISE edition
  "db-f1-micro": 9.5,
  "db-g1-small": 30,
  // Per-N tiers (ENTERPRISE_PLUS only)
  "db-perf-optimized-N-2": 50,
  "db-perf-optimized-N-4": 95,
  "db-perf-optimized-N-8": 180,
  // Custom-machine fallback (rough)
  "db-custom-1-3840": 35,
  "db-custom-2-7680": 65,
  "db-custom-4-15360": 130,
};

export function estimateGcpCost(inputs: CostEstimateInputs): {
  lines: CostLine[];
  totalUsd: number;
  /** The region line the pre-flight table shows above the costs. */
  regionNote: string;
} {
  const sqlBase = SQL_TIER_USD[inputs.cloudSqlTier] ?? 30;
  const sqlMultiplier = inputs.cloudSqlHa ? 2.0 : 1.0;
  const sqlMonthly = Math.round(sqlBase * sqlMultiplier);

  const provider = inputs.provider ?? "gcp";
  const schedulerMinutes = parseSchedulerIntervalMinutes(inputs.schedulerIntervalMinutes);
  const adminMemory = inputs.adminMemory ?? ADMIN_MEMORY_DEFAULT;
  const adminMiB = memoryQuantityMiB(adminMemory);
  if (adminMiB === null) {
    throw new Error(`adminMemory "${adminMemory}" is not a memory quantity (e.g. 2Gi)`);
  }
  const adminGiB = adminMiB / 1024;
  // An always-on instance is priced at 1 GiB (the $15 line); extra memory
  // is billed per GiB-second (~$6.50 per GiB-month).
  const perMinInstanceUsd = 15 + Math.max(0, adminGiB - 1) * 6.5;

  const lines: CostLine[] = [
    {
      name: `Cloud SQL Postgres (${inputs.cloudSqlTier}${inputs.cloudSqlHa ? ", HA" : ""})`,
      monthlyUsd: sqlMonthly,
      notes: inputs.cloudSqlHa
        ? "REGIONAL availability (synchronous replica)"
        : "ZONAL — single zone, automated backups",
    },
    {
      name: `Cloud Run admin (${adminMemory})`,
      // FIXME(issue #1361): with request-billed CPU (SERVICE_CPU_IDLE) the
      // ticks stop keeping the instance up and this line drops to ~$7 of
      // editing sessions. Until then the scheduler tick (#1140) keeps one
      // instance up around the clock, billed at the always-on rate.
      monthlyUsd: adminKeptWarmByTicks(inputs.adminMinInstances)
        ? alwaysOnAdminInstanceUsd(adminGiB)
        : inputs.adminMinInstances === 0
          ? 7
          : Math.round(1 + inputs.adminMinInstances * perMinInstanceUsd),
      notes: adminKeptWarmByTicks(inputs.adminMinInstances)
        ? `scale-to-zero, but CPU is always allocated and the scheduler tick (every ${schedulerMinutes} min) comes before Cloud Run's 15-minute idle shutdown, so one instance (1 vCPU, ${adminMemory}) runs around the clock until request-billed CPU lands (#1361)`
        : inputs.adminMinInstances === 0
          ? "scale-to-zero, request-billed CPU; ~$7/mo light editorial use, ticks inside the free tier"
          : `${inputs.adminMinInstances} min-instance${inputs.adminMinInstances > 1 ? "s" : ""} (no cold start); the scheduler tick adds nothing, the instance is up anyway`,
    },
    {
      name: "Quality checks (Cloud Run audit job)",
      monthlyUsd: 2,
      notes:
        "one container per Lighthouse run, all in parallel (up to 5 pages x 3 runs, ~90 s at 2 vCPU each; a page whose runs disagree gets 2 more): ~$0.05 per audited Stage, at most ~$0.08, partly in the free tier; results bucket ~$0",
    },
    {
      name: "Screenshots (Cloud Run capture job)",
      monthlyUsd: 1,
      notes:
        "one short container per server-side screenshot or page render (~20-40 s at 1 vCPU / 2 GiB): ~$0.001 each, a 50-page site import ~$0.05; mostly in the free tier; capture bucket ~$0",
    },
    {
      // #1328 — on gcp-firebase the visitor gateway is the new
      // `caelo-<env>-data-gateway` service; same billing either way.
      name: provider === "gcp" ? "Cloud Run gateway" : "Cloud Run data gateway",
      monthlyUsd: inputs.gatewayMinInstances === 0 ? 1 : 1 + inputs.gatewayMinInstances * 15,
      notes:
        inputs.gatewayMinInstances === 0
          ? "scale-to-zero; ~$1/mo light traffic"
          : `${inputs.gatewayMinInstances} min-instance${inputs.gatewayMinInstances > 1 ? "s" : ""}`,
    },
    {
      // #1330 — the staging gateway serves the staged site behind the
      // staging gate. Like every public service it is always provisioned at
      // zero minimum instances with request-based CPU (E14 a of #763), and
      // answers a fixed 404 while no staging host is set.
      name: "Cloud Run staging gateway",
      monthlyUsd: 0,
      notes:
        "scale-to-zero, request-based CPU; only the team's visits to staging wake it, mostly in the free tier",
    },
    {
      // #1328 — remote MCP's sign-in service, its own service on every
      // install (E14 a of #763): always provisioned, zero minimum instances,
      // CPU only during requests, so it costs nothing while nobody connects.
      name: "Cloud Run MCP-Auth-Proxy",
      monthlyUsd: 0,
      notes:
        "scale-to-zero, request-based CPU; only external AI apps' sign-in and MCP calls wake it, mostly in the free tier",
    },
    // Only the gcp variant has a load balancer, Cloud CDN and Cloud Armor.
    // gcp-firebase has none of them (E3 of #763): Firebase Hosting is the
    // edge with its own CDN, the admin is gated by IAP on Cloud Run, and the
    // public services protect themselves without a WAF
    // (docs/dev/gateway-hardening.md).
    ...(provider === "gcp"
      ? ([
          {
            name: "Load balancer + managed SSL cert",
            monthlyUsd: 18,
            notes:
              "Global LB base fee (up to 5 forwarding rules) + certificates (free) — flat; the staging host's route and certificate (#1330) add nothing",
          },
          {
            name: "Cloud CDN cache",
            monthlyUsd: 1,
            notes: "Free egress at edge cache hits",
          },
          {
            // #1339 — the gateway's policy (src/gateway-edge.ts): its rules
            // plus the default rule, each billed; the staging gateway's
            // backend shares it. Prices: CLOUD_ARMOR_POLICY_USD above.
            name: "Cloud Armor policy (gateway + staging gateway)",
            monthlyUsd:
              CLOUD_ARMOR_POLICY_USD +
              GATEWAY_ARMOR_BILLED_RULES * CLOUD_ARMOR_RULE_USD +
              (inputs.wafAdaptiveProtection ? 5 : 0),
            notes: `policy ($${CLOUD_ARMOR_POLICY_USD}) with ${GATEWAY_ARMOR_BILLED_RULES} rules ($${GATEWAY_ARMOR_BILLED_RULES * CLOUD_ARMOR_RULE_USD}): per-IP bans on credential operations and the visitor API, a captcha throttle, OWASP sqli/xss at sensitivity 1${inputs.wafAdaptiveProtection ? "; adaptive protection (ML-based bot mitigation) +$5" : ""}; an extra layer, the gateways rate-limit themselves; requests ~$0`,
          },
          {
            // #1328 — the MCP-Auth-Proxy's own backend (serverless NEG +
            // backend service, no extra LB fee: same URL map) with its own
            // Cloud Armor policy carrying the remote-MCP throttle
            // (src/remote-mcp-edge.ts) and the default rule.
            name: "MCP-Auth-Proxy backend + Cloud Armor policy",
            monthlyUsd: CLOUD_ARMOR_POLICY_USD + 2 * CLOUD_ARMOR_RULE_USD,
            notes:
              "own policy ($5) with 2 rules ($2): per-IP throttle for remote MCP clients; requests ~$0",
          },
          {
            name: "Cloud Storage (static + media + staging)",
            monthlyUsd: 1,
            notes:
              "~5 GB storage + low egress; the staging bucket holds two complete builds (#1330 A/B slots); growth roughly $0.02/GB",
          },
          {
            name: "BigQuery edge log sink",
            monthlyUsd: 0,
            notes: "Free tier — pay only on >1 TB/mo query",
          },
        ] satisfies CostLine[])
      : ([
          {
            name: "Firebase Hosting (live + staging site)",
            monthlyUsd: 0,
            notes:
              "Free tier: 10 GB storage + 360 MB/day egress; the staging site (#1330) only rewrites to the staging gateway and stores nothing",
          },
          {
            name: "Cloud Storage (media + staging)",
            monthlyUsd: 1,
            notes:
              "~5 GB storage + low egress; static lives on Firebase; the private staging bucket holds two complete builds (#1330 A/B slots); growth roughly $0.02/GB",
          },
          {
            name: "Cloud Logging (service logs, the edge log sink)",
            monthlyUsd: 0,
            notes: "Free tier: the first 50 GiB of logs a month",
          },
        ] satisfies CostLine[])),
    {
      name: "Secret Manager (runtime secrets)",
      monthlyUsd: secretManagerMonthlyUsd(RUNTIME_SECRETS.length),
      notes: `${RUNTIME_SECRETS.length} secrets, one active version each: 6 free, then $${SECRET_VERSION_USD} each (the database logins of the admin and both gateways, the Google sign-in client, the remote-MCP seal key, the staging gate key and three internal keys; the staging database shares the Cloud SQL instance at no extra cost)`,
    },
    {
      name: "Install state (ops bucket + Cloud KMS key)",
      monthlyUsd: 0.06,
      notes:
        "< $0.10/mo — versioned bucket with Pulumi state + install metadata, 1 KMS key version ($0.06)",
    },
    {
      name: "Operator-access sync (Cloud Run job + Cloud Scheduler)",
      monthlyUsd: 0,
      notes:
        "Hourly ~20 s job keeps Google IAP in step with the user list; within the Cloud Run free tier, 1 of 3 free scheduler jobs",
    },
    {
      name: `Scheduler tick (Cloud Scheduler + Workflows, every ${schedulerMinutes} min)`,
      monthlyUsd: schedulerTickMonthlyUsd(schedulerMinutes),
      notes: `one job starts a ${SCHEDULER_TICK_STEPS.internal + SCHEDULER_TICK_STEPS.external}-step workflow that calls the admin's periodic work and plugin workers; ~${Math.ceil((30 * 24 * 60) / schedulerMinutes)} ticks/mo; what the ticks cost on the admin is on the admin line`,
    },
  ];

  // Cents, so a sub-dollar line (the KMS key) doesn't print float noise.
  const totalUsd = Math.round(lines.reduce((sum, l) => sum + l.monthlyUsd, 0) * 100) / 100;
  const regionNote =
    inputs.region === PRICED_REGION
      ? `Region: ${inputs.region} (fixed after install)`
      : `Region: ${inputs.region} (fixed after install) — prices below are ${PRICED_REGION} list rates; ${inputs.region} rates may differ`;
  return { lines, totalUsd, regionNote };
}
