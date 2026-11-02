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

import {
  ADMIN_MEMORY_DEFAULT,
  memoryQuantityMiB,
  parseSchedulerIntervalMinutes,
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
 * steps past the free tier. A tick with nothing due takes the admin well
 * under a second of request-billed CPU, inside Cloud Run's free tier.
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
      // FIXME(issue #1361): ~$1 once the admin runs request-billed CPU
      // (SERVICE_CPU_IDLE). Until then each editing session is billed for
      // as long as the instance stays up, ~15 minutes past its last request.
      monthlyUsd:
        inputs.adminMinInstances === 0
          ? 7
          : Math.round(1 + inputs.adminMinInstances * perMinInstanceUsd),
      notes:
        inputs.adminMinInstances === 0
          ? "scale-to-zero, CPU always allocated while running; ~$7/mo light editorial use"
          : `${inputs.adminMinInstances} min-instance${inputs.adminMinInstances > 1 ? "s" : ""} (no cold start)`,
    },
    {
      name: "Quality checks (Cloud Run audit job)",
      monthlyUsd: 2,
      notes:
        "one container per Lighthouse run, all in parallel (up to 5 pages x 3 runs, ~90 s at 2 vCPU each): ~$0.05 per audited Stage, partly in the free tier; results bucket ~$0",
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
      // #1328 — remote MCP's sign-in service, its own service on every
      // install (E14 a of #763): always provisioned, zero minimum instances,
      // CPU only during requests, so it costs nothing while nobody connects.
      name: "Cloud Run MCP-Auth-Proxy",
      monthlyUsd: 0,
      notes:
        "scale-to-zero, request-based CPU; only external AI apps' sign-in and MCP calls wake it, mostly in the free tier",
    },
    // v0.3.3 — LB / Cloud CDN / Cloud Armor lines apply only to the
    // gcp variant. gcp-firebase has no LB (Firebase Hosting is the
    // edge); no Cloud CDN line (Firebase Hosting has its own CDN
    // included in free tier); no Cloud Armor (admin is gated by
    // Cloud Run IAP, gateway by run.invoker IAM).
    ...(provider === "gcp"
      ? ([
          {
            name: "Load balancer + managed SSL cert",
            monthlyUsd: 18,
            notes: "Global LB base fee + cert (free) — flat",
          },
          {
            name: "Cloud CDN cache",
            monthlyUsd: 1,
            notes: "Free egress at edge cache hits",
          },
          {
            name: "Cloud Armor WAF",
            monthlyUsd: inputs.wafAdaptiveProtection ? 5 : 0,
            notes: inputs.wafAdaptiveProtection
              ? "Adaptive protection (ML-based bot mitigation)"
              : "Free tier — rate limit + OWASP basic rules",
          },
          {
            // #1328 — the MCP-Auth-Proxy's own backend (serverless NEG +
            // backend service, no extra LB fee: same URL map) with its own
            // Cloud Armor policy carrying the remote-MCP throttle
            // (src/remote-mcp-edge.ts) and the default rule. Cloud Armor
            // Standard: $0.006849315/policy-hour (~$5/mo) and
            // $0.001369863/rule-hour (~$1/mo), plus $0.75 per million
            // requests on a global policy — cloud.google.com/armor/pricing,
            // checked 2026-11-02.
            name: "MCP-Auth-Proxy backend + Cloud Armor policy",
            monthlyUsd: 7,
            notes:
              "own policy ($5) with 2 rules ($2): per-IP throttle for remote MCP clients; requests ~$0",
          },
        ] satisfies CostLine[])
      : ([
          {
            name: "Firebase Hosting",
            monthlyUsd: 0,
            notes: "Free tier: 10 GB storage + 360 MB/day egress",
          },
        ] satisfies CostLine[])),
    {
      name:
        provider === "gcp"
          ? "Cloud Storage (static + media)"
          : "Cloud Storage (media only — static lives on Firebase)",
      monthlyUsd: 1,
      notes: "~5 GB storage + low egress; growth roughly $0.02/GB",
    },
    {
      name: "Secret Manager (runtime secrets)",
      monthlyUsd: 0.2,
      notes:
        "6 active versions free, then ~$0.06 each; the Google sign-in client (#914) and the remote-MCP seal key (#806)",
    },
    {
      name: "BigQuery edge log sink",
      monthlyUsd: 0,
      notes: "Free tier — pay only on >1 TB/mo query",
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
      notes: `one job starts a ${SCHEDULER_TICK_STEPS.internal + SCHEDULER_TICK_STEPS.external}-step workflow that calls the admin's periodic work and plugin workers; ~${Math.ceil((30 * 24 * 60) / schedulerMinutes)} ticks/mo, the admin's share inside the Cloud Run free tier`,
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
