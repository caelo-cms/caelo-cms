// SPDX-License-Identifier: MPL-2.0

/**
 * The cloud region an install runs in: which regions each provider adapter
 * can be installed in, what the wizard suggests, and the rule that the
 * region is fixed once an install exists (#607).
 *
 * Why a static list instead of asking the cloud at run time: none of the
 * providers offers one query for "every service this stack needs is
 * available here". GCP's `gcloud run regions list` only covers Cloud Run and
 * needs a project with the API already enabled — i.e. after we created
 * billable state. So each catalog below is the intersection of the per-
 * service region lists from the provider's own documentation (URLs next to
 * each list). Azure is the exception: Microsoft documents no static
 * Container Apps list and names `az provider show` as the source of truth,
 * so the Azure catalog adds that live check on top of its static list and
 * fails loudly when it can't run.
 *
 * The region is immutable after install: Cloud SQL, buckets, secrets, Cloud
 * Run services and the scheduler job all live in it, and moving them is a
 * migration Caelo does not do. A different region on a re-run or `upgrade`
 * is refused, never applied.
 */

import { spawn } from "node:child_process";
import {
  AWS_REGIONS,
  AZURE_REGIONS,
  GCP_REGION_NAMES,
  GCP_RESTRICTED_REGIONS,
  GCP_SERVICE_REGIONS,
  GCP_SERVICES,
  type RegionOption,
} from "./region-data.js";

/** Providers whose stack is placed in a cloud region (self-hosted is not). */
export type RegionalProvider = "gcp" | "gcp-firebase" | "aws" | "azure";

/** Result of running a provider CLI. */
export interface CliResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one CLI command (`gcloud`, `aws`, `az`); injectable for tests. */
export type CliRunner = (cmd: string, args: readonly string[]) => Promise<CliResult>;

/** Default {@link CliRunner}: spawns the binary; a missing binary is a failed result. */
export const runCli: CliRunner = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => resolve({ ok: false, stdout: "", stderr: e.message }));
    child.on("close", (code) =>
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });

/**
 * Regions where Azure Container Apps managed environments are offered for
 * the signed-in subscription, as the Azure CLI reports them. Never throws;
 * a missing CLI or no permission is an error result.
 */
async function queryAzureContainerAppsRegions(
  run: CliRunner,
): Promise<{ ok: true; regions: Set<string> } | { ok: false; error: string }> {
  const r = await run("az", [
    "provider",
    "show",
    "--namespace",
    "Microsoft.App",
    "--query",
    "resourceTypes[?resourceType=='managedEnvironments'].locations | [0]",
    "--output",
    "json",
  ]);
  if (!r.ok) {
    return {
      ok: false,
      error: `could not ask Azure where Container Apps is available (az provider show --namespace Microsoft.App): ${r.stderr.trim() || "no output"}. Install the Azure CLI and run \`az login\`, then re-run.`,
    };
  }
  let names: unknown;
  try {
    names = JSON.parse(r.stdout);
  } catch {
    return { ok: false, error: `az provider show returned unparseable output: ${r.stdout.trim()}` };
  }
  if (!Array.isArray(names) || names.length === 0) {
    return { ok: false, error: "az provider show listed no Container Apps regions." };
  }
  // The API reports display names ("West Europe"); region ids are the
  // lower-cased name without spaces ("westeurope").
  return {
    ok: true,
    regions: new Set(names.map((n) => String(n).toLowerCase().replace(/\s+/g, ""))),
  };
}

// ===========================================================================
// Catalogs
// ===========================================================================

/** Where a provider adapter can be installed, and what the wizard suggests. */
export interface RegionCatalog {
  readonly provider: RegionalProvider;
  /** Suggested when the provider CLI has no default region configured. */
  readonly euDefault: string;
  readonly regions: readonly RegionOption[];
  /** The regional services the list was intersected over (for messages + docs). */
  readonly services: readonly string[];
  /** Narrows `regions` with a live provider query, where no static list exists. */
  readonly liveRegions?: (
    run: CliRunner,
  ) => Promise<{ ok: true; regions: Set<string> } | { ok: false; error: string }>;
}

function gcpCatalog(provider: "gcp" | "gcp-firebase"): RegionCatalog {
  const services: string[] = [...GCP_SERVICES];
  if (provider === "gcp-firebase") services.push("Cloud Run domain mapping");
  const lists = services.map((s) => new Set(GCP_SERVICE_REGIONS[s] ?? []));
  const regions = Object.keys(GCP_REGION_NAMES)
    .filter((id) => !GCP_RESTRICTED_REGIONS.includes(id) && lists.every((l) => l.has(id)))
    .map((id) => ({ id, name: GCP_REGION_NAMES[id] as string }));
  return { provider, euDefault: "europe-west1", regions, services };
}

/** The region catalog for `provider`. */
export function regionCatalog(provider: RegionalProvider): RegionCatalog {
  switch (provider) {
    case "gcp":
    case "gcp-firebase":
      return gcpCatalog(provider);
    case "aws":
      return {
        provider,
        euDefault: "eu-central-1",
        regions: AWS_REGIONS,
        services: ["ECS Fargate", "RDS for PostgreSQL", "S3", "Secrets Manager"],
      };
    case "azure":
      return {
        provider,
        euDefault: "westeurope",
        regions: AZURE_REGIONS,
        services: ["Container Apps", "Database for PostgreSQL flexible server", "Key Vault"],
        liveRegions: queryAzureContainerAppsRegions,
      };
  }
}

/**
 * The regions `provider` can be installed in right now: the static catalog,
 * narrowed by the live query where the catalog has one.
 */
export async function installableRegions(
  provider: RegionalProvider,
  run: CliRunner = runCli,
): Promise<{ ok: true; regions: RegionOption[] } | { ok: false; error: string }> {
  const catalog = regionCatalog(provider);
  if (!catalog.liveRegions) return { ok: true, regions: [...catalog.regions] };
  const live = await catalog.liveRegions(run);
  if (!live.ok) return live;
  return { ok: true, regions: catalog.regions.filter((r) => live.regions.has(r.id)) };
}

/** The "valid regions" list for error messages. */
export function formatRegionList(regions: readonly RegionOption[]): string {
  return regions.map((r) => `${r.id} (${r.name})`).join(", ");
}

/**
 * Check `region` against the installable regions. The error names every
 * valid region, so a non-interactive caller can fix its `--region`.
 */
export function checkRegion(
  provider: RegionalProvider,
  region: string,
  regions: readonly RegionOption[],
): { ok: true } | { ok: false; error: string } {
  if (regions.some((r) => r.id === region)) return { ok: true };
  const services = regionCatalog(provider).services.join(", ");
  return {
    ok: false,
    error: `"${region}" is not a region the ${provider} install can use (it needs ${services} in the same region). Valid regions: ${formatRegionList(regions)}.`,
  };
}

/**
 * The default region configured in the provider's CLI, or null when none
 * is set or the CLI isn't installed (the wizard then suggests the EU
 * default; the operator confirms either way).
 */
export async function detectCliRegion(
  provider: RegionalProvider,
  run: CliRunner = runCli,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | null> {
  const first = (r: CliResult) => {
    const v = r.ok ? r.stdout.trim().split("\n")[0]?.trim() : "";
    return v && v !== "(unset)" ? v : null;
  };
  switch (provider) {
    case "gcp":
    case "gcp-firebase":
      return (
        first(await run("gcloud", ["config", "get-value", "run/region"])) ??
        first(await run("gcloud", ["config", "get-value", "compute/region"]))
      );
    case "aws":
      return (
        env.AWS_REGION?.trim() ||
        env.AWS_DEFAULT_REGION?.trim() ||
        first(await run("aws", ["configure", "get", "region"]))
      );
    case "azure":
      return first(
        await run("az", ["config", "get", "defaults.location", "--query", "value", "-o", "tsv"]),
      );
  }
}

/**
 * The region the picker preselects: the CLI default when it is installable,
 * otherwise the catalog's EU default. `note` explains a skipped CLI default.
 */
export function suggestRegion(
  provider: RegionalProvider,
  cliRegion: string | null,
  regions: readonly RegionOption[],
): { region: string; source: "cli" | "eu-default"; note?: string } {
  const euDefault = regionCatalog(provider).euDefault;
  if (cliRegion && regions.some((r) => r.id === cliRegion)) {
    return { region: cliRegion, source: "cli" };
  }
  return {
    region: euDefault,
    source: "eu-default",
    ...(cliRegion
      ? {
          note: `Your CLI's default region ${cliRegion} lacks a service this install needs (${regionCatalog(provider).services.join(", ")}); suggesting ${euDefault} instead.`,
        }
      : {}),
  };
}

/** Why a region differs from the one an install was created in. */
export function regionChangeRefusal(
  installId: string,
  recorded: string,
  requested: string,
): string {
  return (
    `Install ${installId} runs in ${recorded}; its region is fixed after install, so ${requested} can't be applied. ` +
    `Its Cloud SQL database, buckets, secrets and services live in ${recorded}, and moving them is a migration Caelo does not do. ` +
    `Re-run without --region (or with --region ${recorded}). For another region, provision a new install there.`
  );
}

/**
 * What the wizard does about the region, given what is already known.
 * Pure: the caller detects the deployed region and prompts.
 *
 *   - recorded region of a deployed install, or the deployed region → keep
 *     it; a different `--region` is refused.
 *   - otherwise `--region` → validated, used.
 *   - otherwise a preselected region (earlier run, never deployed) →
 *     preselected in the prompt, used as-is when non-interactive.
 *   - otherwise interactive → prompt; non-interactive → refuse with the list.
 */
export type RegionDecision =
  | { readonly kind: "keep"; readonly region: string; readonly from: "install.json" | "deployed" }
  | { readonly kind: "use"; readonly region: string }
  | { readonly kind: "prompt"; readonly preselected?: string }
  | { readonly kind: "refuse"; readonly error: string };

/** Decide the install region; see {@link RegionDecision}. */
export function decideRegion(input: {
  readonly provider: RegionalProvider;
  readonly installId: string;
  readonly recorded: string | null;
  readonly deployed: string | null;
  /**
   * A region picked in an earlier run that never got as far as deploying
   * (cancelled at the cost table, a failed setup step). Not fixed yet: it
   * is preselected, and `--region` may still change it.
   */
  readonly preselected?: string | null;
  readonly requested: string | undefined;
  readonly nonInteractive: boolean;
  readonly regions: readonly RegionOption[];
}): RegionDecision {
  if (input.recorded && input.deployed && input.recorded !== input.deployed) {
    return {
      kind: "refuse",
      error: `install.json records region ${input.recorded} for ${input.installId}, but its services run in ${input.deployed}. Fix install.json to the region the install runs in, then re-run.`,
    };
  }
  const fixed = input.recorded ?? input.deployed;
  if (fixed) {
    if (input.requested && input.requested !== fixed) {
      return {
        kind: "refuse",
        error: regionChangeRefusal(input.installId, fixed, input.requested),
      };
    }
    return { kind: "keep", region: fixed, from: input.recorded ? "install.json" : "deployed" };
  }
  if (input.requested) {
    const check = checkRegion(input.provider, input.requested, input.regions);
    return check.ok
      ? { kind: "use", region: input.requested }
      : { kind: "refuse", error: check.error };
  }
  const preselected =
    input.preselected && checkRegion(input.provider, input.preselected, input.regions).ok
      ? input.preselected
      : null;
  if (input.nonInteractive) {
    if (preselected) return { kind: "use", region: preselected };
    return {
      kind: "refuse",
      error: `--region is required with --non-interactive: the region is fixed after install, so Caelo won't pick one for you. Valid regions: ${formatRegionList(input.regions)}.`,
    };
  }
  return preselected ? { kind: "prompt", preselected } : { kind: "prompt" };
}

/**
 * The region an existing install runs in, for lifecycle commands. Throws an
 * actionable error when install.json has none (no silent default — §2).
 */
export function requireInstallRegion(meta: {
  readonly installId: string;
  readonly region: string | null;
}): string {
  if (!meta.region) {
    throw new Error(
      `install ${meta.installId} has no region recorded in install.json. Re-run the installer (\`bunx @caelo-cms/provisioning\`, pick "Resume wizard"): it reads the region from the deployed services and records it.`,
    );
  }
  return meta.region;
}

/**
 * Refuse a `--region` that differs from the install's recorded one (used by
 * `upgrade`, which never moves an install). No `requested` passes.
 */
export function assertRegionUnchanged(
  meta: { readonly installId: string; readonly region: string | null },
  requested: string | undefined,
): string {
  const recorded = requireInstallRegion(meta);
  if (requested && requested !== recorded) {
    throw new Error(regionChangeRefusal(meta.installId, recorded, requested));
  }
  return recorded;
}
