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

import { ADMIN_MEMORY_DEFAULT, memoryQuantityMiB } from "../stack-contract.js";

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
      monthlyUsd:
        inputs.adminMinInstances === 0
          ? 1
          : Math.round(1 + inputs.adminMinInstances * perMinInstanceUsd),
      notes:
        inputs.adminMinInstances === 0
          ? "scale-to-zero; ~$1/mo light editorial use"
          : `${inputs.adminMinInstances} min-instance${inputs.adminMinInstances > 1 ? "s" : ""} (no cold start)`,
    },
    {
      name: "Quality checks (Lighthouse on the admin)",
      monthlyUsd: 1,
      notes:
        "~1-2 min of admin CPU per audited Stage (up to 5 pages x 3 runs); ~$1/mo at a few Stages a day",
    },
    {
      name: "Cloud Run gateway",
      monthlyUsd: inputs.gatewayMinInstances === 0 ? 1 : 1 + inputs.gatewayMinInstances * 15,
      notes:
        inputs.gatewayMinInstances === 0
          ? "scale-to-zero; ~$1/mo light traffic"
          : `${inputs.gatewayMinInstances} min-instance${inputs.gatewayMinInstances > 1 ? "s" : ""}`,
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
      name: "Secret Manager (5 secrets)",
      monthlyUsd: 0,
      notes: "Free tier",
    },
    {
      name: "BigQuery edge log sink",
      monthlyUsd: 0,
      notes: "Free tier — pay only on >1 TB/mo query",
    },
    {
      name: "Operator-access sync (Cloud Run job + Cloud Scheduler)",
      monthlyUsd: 0,
      notes:
        "Hourly ~20 s job keeps Google IAP in step with the user list; within the Cloud Run free tier, 1 of 3 free scheduler jobs",
    },
  ];

  const totalUsd = lines.reduce((sum, l) => sum + l.monthlyUsd, 0);
  const regionNote =
    inputs.region === PRICED_REGION
      ? `Region: ${inputs.region} (fixed after install)`
      : `Region: ${inputs.region} (fixed after install) — prices below are ${PRICED_REGION} list rates; ${inputs.region} rates may differ`;
  return { lines, totalUsd, regionNote };
}
