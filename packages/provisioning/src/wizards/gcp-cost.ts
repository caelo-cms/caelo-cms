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

export interface CostLine {
  name: string;
  monthlyUsd: number;
  notes?: string;
}

export interface CostEstimateInputs {
  cloudSqlTier: string; // e.g. "db-f1-micro"
  cloudSqlHa: boolean;
  adminMinInstances: number;
  gatewayMinInstances: number;
  wafAdaptiveProtection: boolean;
}

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
} {
  const sqlBase = SQL_TIER_USD[inputs.cloudSqlTier] ?? 30;
  const sqlMultiplier = inputs.cloudSqlHa ? 2.0 : 1.0;
  const sqlMonthly = Math.round(sqlBase * sqlMultiplier);

  const lines: CostLine[] = [
    {
      name: `Cloud SQL Postgres (${inputs.cloudSqlTier}${inputs.cloudSqlHa ? ", HA" : ""})`,
      monthlyUsd: sqlMonthly,
      notes: inputs.cloudSqlHa
        ? "REGIONAL availability (synchronous replica)"
        : "ZONAL — single zone, automated backups",
    },
    {
      name: "Cloud Run admin",
      monthlyUsd: inputs.adminMinInstances === 0 ? 1 : 1 + inputs.adminMinInstances * 15,
      notes:
        inputs.adminMinInstances === 0
          ? "scale-to-zero; ~$1/mo light editorial use"
          : `${inputs.adminMinInstances} min-instance${inputs.adminMinInstances > 1 ? "s" : ""} (no cold start)`,
    },
    {
      name: "Cloud Run gateway",
      monthlyUsd: inputs.gatewayMinInstances === 0 ? 1 : 1 + inputs.gatewayMinInstances * 15,
      notes:
        inputs.gatewayMinInstances === 0
          ? "scale-to-zero; ~$1/mo light traffic"
          : `${inputs.gatewayMinInstances} min-instance${inputs.gatewayMinInstances > 1 ? "s" : ""}`,
    },
    {
      name: "Load balancer + managed SSL cert",
      monthlyUsd: 18,
      notes: "Global LB base fee + cert (free) — flat",
    },
    {
      name: "Cloud Storage (static + media)",
      monthlyUsd: 1,
      notes: "~5 GB storage + low egress; growth roughly $0.02/GB",
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
      name: "Secret Manager (5 secrets)",
      monthlyUsd: 0,
      notes: "Free tier",
    },
    {
      name: "BigQuery edge log sink",
      monthlyUsd: 0,
      notes: "Free tier — pay only on >1 TB/mo query",
    },
  ];

  const totalUsd = lines.reduce((sum, l) => sum + l.monthlyUsd, 0);
  return { lines, totalUsd };
}
