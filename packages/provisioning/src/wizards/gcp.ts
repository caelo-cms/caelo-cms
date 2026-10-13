// SPDX-License-Identifier: MPL-2.0

/**
 * GCP provider wizard — end-to-end automation per §11.C:
 *   1. Detects active gcloud account; prompts `gcloud auth login` if none
 *   2. Lists billing accounts; user picks
 *   3. Captures GCP project id (default suggested from domain)
 *   4. Creates the project (skips if exists)
 *   5. Links billing
 *   6. Enables 13 APIs in one call
 *   7. Creates the provisioner SA + grants 15 IAM roles
 *   8. Lets the operator's gcloud account impersonate that SA (#696): no
 *      key is ever minted; an older install's `sa-key.json` is deleted,
 *      locally and in IAM (provisioner-identity.ts)
 *   9. Pre-flight cost-estimate table; single y/N confirm
 *  10. Ensures the install's ops bucket + KMS key in its own project and
 *      keeps Pulumi's state + install.json there (#696, ops-backend.ts).
 *      An older install whose state is on this machine keeps it there
 *      and its passphrase in secrets/pulumi-passphrase
 *  11. Pulumi up via the Automation SDK; streams progress, then deletes
 *      the firewall rules GCP pre-populates on the default network
 *  12. Prints DNS records + bootstrap URL + a note pointing the
 *      operator at /settings/ai for AI provider key configuration
 *      (the runtime path; pre-v0.3.2 there was a wizard prompt for
 *      the Anthropic key but it landed in Secret Manager + never
 *      reached the running admin — dead code, dropped).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cancel, confirm, isCancel, log, note, select, spinner, text } from "@clack/prompts";
import { bold, cyan, dim, green, red, yellow } from "kleur/colors";
import { checkAdcImpersonation } from "../adc-impersonation.js";
import { CERT_WAIT_TIMEOUT_MS, lbCertProbe, waitForCert } from "../cert-wait.js";
import { redactCredentials } from "../checkpoint-secrets.js";
import { removeDefaultFirewallRules } from "../default-firewall.js";
import {
  checkDeployedRuntimeEnv,
  chooseImageDigests,
  readDeployedImageDigests,
  readDeployedRegion,
} from "../deployed-release.js";
import { formatDnsRecordGroups, groupDnsRecords, type InstallDnsRecord } from "../dns/groups.js";
import { pickDnsAdapter } from "../dns/index.js";
import type { DnsRecord } from "../dns/types.js";
import { ensureGatewayRolePassword, findSqlInstance } from "../gateway-credentials.js";
import {
  activeAccount,
  type BillingAccount,
  createProject,
  createServiceAccount,
  enableApis,
  gcloud,
  gcloudEnv,
  grantProvisionerRoles,
  linkBilling,
  listBillingAccounts,
  PROVISIONER_ROLE_LIST,
  projectExists,
  REQUIRED_API_LIST,
  serviceAccountExists,
} from "../gcloud.js";
import { GCP_STACK_ENV } from "../gcp-names.js";
import {
  adoptStateBackend,
  ensureInstallDir,
  type ImageDigests,
  type InstallMetadata,
  installRoot,
  installStagingHost,
  isStepDone,
  markStepDone,
  readMetadata,
  readSecret,
  recordedImageDigests,
  recordImageDigests,
  writeMetadata,
  writeSecret,
} from "../install-state.js";
import {
  ensureOperatorAccessSync,
  installIapAllowlist,
  resolveOperatorAccessTarget,
} from "../operator-access.js";
import { ensureOpsBackend } from "../ops-backend.js";
import {
  convergeKeylessProvisioner,
  PROVISIONER_ACCOUNT_ID,
  provisionerServiceAccountEmail,
} from "../provisioner-identity.js";
import { decideRegion, detectCliRegion, installableRegions, suggestRegion } from "../regions.js";
import { selfCommand } from "../self-command.js";
import { ABSENT_DEFAULT_FIREWALL_RULES } from "../stack-contract.js";
import {
  chooseInstallBackend,
  describeBackend,
  gcsBackendRecord,
  hasLocalPulumiState,
  type ResolvedBackend,
  resolveBackend,
} from "../state-backend.js";
import { GcsStateStore } from "../state-store.js";
import { estimateGcpCost } from "./gcp-cost.js";
import { GCP_STACK_KNOB_DEFAULTS, pulumiUpGcp, readStackOutput } from "./gcp-pulumi.js";

export interface GcpWizardOpts {
  installId: string;
  domain: string;
  ownerEmail: string;
  projectId: string | null;
  nonInteractive: boolean;
  /** #607 — `--region`; required for a new install when non-interactive. */
  region?: string;
  /**
   * v0.3.1 — provider variant. 'gcp' is the LB-based topology;
   * 'gcp-firebase' adds Firebase Hosting + Cloud Run direct. The
   * variant gates per-provider gcloud steps (e.g. Firebase APIs
   * enablement, Search Console verification prompts).
   */
  provider?: "gcp" | "gcp-firebase";
}

export async function runGcpWizard(opts: GcpWizardOpts): Promise<void> {
  const { installId, domain, ownerEmail } = opts;
  const { secretsDir } = ensureInstallDir(installId);

  // === 1. gcloud auth ===
  await stepActiveGcloud();

  // === 2. Project id ===
  const projectId = await stepProjectId(opts);

  // Persist the project id once we have it.
  const meta = readMetadata(installId);
  if (meta) {
    const updated: InstallMetadata = { ...meta, projectId };
    writeMetadata(installId, updated);
  }

  // === 2.5. Region (#607) — chosen before anything billable exists, then
  // fixed: every later step and every lifecycle command reads it from
  // install.json.
  const region = await stepRegion(opts, projectId, meta);
  if (meta) writeMetadata(installId, { ...meta, projectId, region });

  // === 3. Project create ===
  await stepProjectCreate(installId, projectId);

  // === 4. Billing link ===
  await stepBillingLink(installId, projectId, opts.nonInteractive);

  // === 5. Enable APIs ===
  await stepEnableApis(installId, projectId, opts.provider ?? "gcp");

  // === 6. Service account + roles + impersonation (no key, #696) ===
  // v0.3.12 — dropped the firebase-hosting-identity step. The
  // Service Usage GenerateServiceIdentity API doesn't support
  // `firebasehosting.googleapis.com` (returns
  // IAM_SERVICE_NOT_CONFIGURED_FOR_IDENTITIES). The Firebase
  // Hosting SA `service-<projectnum>@gcp-sa-firebasehosting.iam.gserviceaccount.com`
  // is created lazily by Firebase on first deploy with a Cloud
  // Run rewrite. We instead grant `roles/run.invoker` at the
  // PROJECT level (vs the Cloud Run service level) — project IAM
  // accepts deferred google-managed principals; v1 Cloud Run IAM
  // didn't.
  const saEmail = provisionerServiceAccountEmail(projectId);
  await stepServiceAccount(installId, projectId, saEmail);
  await stepGrantRoles(installId, projectId, saEmail);
  await stepKeylessProvisioner(projectId, secretsDir, opts.nonInteractive);

  // === 8. Cost-estimate pre-flight ===
  // v0.3.3 — provider variant threads through so gcp-firebase
  // drops the LB / Cloud CDN / Cloud Armor lines (saves ~$19/mo
  // vs gcp). Default 'gcp' for backwards compatibility with
  // installs that don't set the field.
  const costInputs = {
    ...GCP_STACK_KNOB_DEFAULTS,
    provider: opts.provider ?? ("gcp" as const),
    region,
  };
  const estimate = estimateGcpCost(costInputs);
  note(
    [
      bold(
        "Estimated monthly cost (resource floor — actual usage adds AI calls + egress + storage growth)",
      ),
      `  ${estimate.regionNote}`,
      "",
      ...estimate.lines.map(
        (l) =>
          `  ${dim(l.name.padEnd(40))} ${green(`$${l.monthlyUsd}`.padStart(5))}/mo  ${dim(l.notes ?? "")}`,
      ),
      "",
      `  ${bold("TOTAL".padEnd(40))} ${bold(`$${estimate.totalUsd}`.padStart(5))}/mo`,
      "",
      `  ${dim(`Also deletes the default network's pre-populated firewall rules ${ABSENT_DEFAULT_FIREWALL_RULES.map((r) => r.name).join(" + ")} (Caelo runs no VMs and does not use that network).`)}`,
    ].join("\n"),
    "Pre-flight",
  );
  if (!opts.nonInteractive) {
    const proceed = await confirm({
      message: `Provision ~${estimate.totalUsd} USD/mo on GCP project ${bold(projectId)} in ${bold(region)}?`,
      initialValue: true,
    });
    if (isCancel(proceed) || !proceed) {
      cancel("Cancelled at cost confirmation.");
      process.exit(0);
    }
  }

  // === 8.5. Where Pulumi's state lives (#696) ===
  // A new install: the ops bucket + KMS key in its own project — after the
  // cost confirmation, which lists them (CLAUDE.md §11.C: nothing billable
  // before the y/N). An older install keeps its local state + passphrase.
  const backend = await stepStateBackend(installId, projectId, region, saEmail);

  // === 9. Image digests to deploy ===
  // An install that already runs a recorded release (from an earlier
  // wizard run or from `upgrade`) keeps it: re-running the wizard converges
  // infrastructure, it never changes versions — that is `upgrade`'s job,
  // which also migrates the database before shifting traffic. Without this
  // a re-run silently rolled a pinned/rc install back to `:latest`.
  //
  // An install provisioned before the record existed keeps what its
  // services run. A new install resolves the floating `:latest` tag to a
  // fixed sha256 digest: Cloud Run keys revisions by image reference, so a
  // tag would never trigger a new revision.
  const deployed = isStepDone(installId, `pulumi-up-${projectId}`);
  if (deployed) {
    // The kept release must be able to use the env the stack deploys.
    const runtimeEnv = await checkDeployedRuntimeEnv({ projectId, region });
    if (!runtimeEnv.ok) {
      cancel(runtimeEnv.error);
      process.exit(1);
    }
  }
  const choice = await chooseImageDigests({
    recorded: meta ? recordedImageDigests(meta) : null,
    deployed,
    readLive: () => readDeployedImageDigests({ projectId, region }),
    resolveLatest: resolveImageDigests,
  });
  if (!choice.ok) {
    cancel(choice.error);
    process.exit(1);
  }
  const imageDigests = choice.digests;
  if (choice.source !== "latest") {
    log.info(
      `Keeping the release this install runs (admin ${dim(`${imageDigests.admin.slice(0, 19)}...`)}). Change versions with ${bold("upgrade")}.`,
    );
  }

  // === 9.5. Drain the legacy `caelo_admin` SQL user before pulumi-up ===
  // The 3a81c37 rename (caelo_admin → admin_role) leaves the old role
  // in pg_roles owning N objects (sequences/grants survive ALTER TABLE
  // OWNER). Pulumi's User-resource delete fails with "role cannot be
  // dropped because some objects depend on it" (Postgres 400). REASSIGN
  // OWNED + DROP OWNED clears the dependencies first; the DO block
  // is a no-op when caelo_admin already doesn't exist (fresh installs +
  // post-cleanup re-runs both pass through cleanly).
  await stepDrainLegacyCaeloAdminUser(projectId, region);

  // === 10. Pulumi up via Automation SDK ===
  // Pre-built signed images live at the Caelo-team public AR repo
  // (caelo-website/caelo-cms-images by default). Cloud Run reads them
  // directly with no operator-side IAM binding — anonymous public pull.
  await stepPulumiUp(installId, {
    projectId,
    domain,
    // #650 — the wizard recorded it (or the install predates the setting).
    stagingDomain: installStagingHost({
      domain,
      stagingDomain: readMetadata(installId)?.stagingDomain,
    }),
    ownerEmail,
    region,
    impersonateServiceAccount: saEmail,
    backend,
    cloudSqlTier: costInputs.cloudSqlTier,
    cloudSqlHa: costInputs.cloudSqlHa,
    adminMinInstances: costInputs.adminMinInstances,
    adminMemory: costInputs.adminMemory,
    gatewayMinInstances: costInputs.gatewayMinInstances,
    wafAdaptiveProtection: costInputs.wafAdaptiveProtection,
    // Same list the operator-access sync job keeps (installIapAllowlist).
    iapAllowlist: installIapAllowlist(ownerEmail),
    imageDigests,
    // v0.3.1 — route pulumi up at the right stack folder + use the
    // matching config namespace.
    provider: opts.provider ?? "gcp",
  });
  recordImageDigests(installId, imageDigests);

  // === 10.1. Remove the default network's pre-populated firewall rules ===
  // GCP creates them when Compute Engine is enabled (step 5). Run after
  // Pulumi rather than right after enabling the API: the default network
  // can appear asynchronously, and by now it has. Idempotent, every pass.
  await stepRemoveDefaultFirewallRules(projectId);

  // === 10. Wait for managed cert to flip from PROVISIONING → ACTIVE ===
  // Pulumi reports the cert "created" the moment GCP queues it; the
  // actual issuance + DNS validation takes 5-30 min depending on
  // load + DNS propagation. The bootstrap URL is meaningless until
  // ACTIVE — without this step the wizard would tell the operator
  // "you're done" while HTTPS still ERR_CONNECTION_CLOSEDs.
  //
  // v0.3.14 — gcp-firebase has no LB and no managed cert; Firebase
  // Hosting's HostingCustomDomain resource handles TLS issuance
  // internally (status surfaces via dnsRecordsRequired output).
  // Skip the cert wait on that provider.
  //
  // The DNS records come first: the certificate only validates once the
  // admin host resolves to the load balancer. Only the "set now" records
  // are applied here — the main domain moves at go-live (dns/groups.ts).
  if ((opts.provider ?? "gcp") === "gcp") {
    await stepGcpDnsRecords(installId);
    await stepWaitForCertActive(projectId, `admin.${domain}`);
  }

  // === 11. Apply DB migrations against Cloud SQL via a one-shot Job ===
  // Cloud SQL lives on a private VPC IP that's only reachable from
  // inside the VPC. Spawn a Cloud Run Job using the same admin image
  // (which carries packages/migrations) to apply admin + public schema.
  // Idempotent — drizzle's __drizzle_migrations table tracks applied
  // versions, so re-runs only apply NEW migrations on subsequent ups.
  // P21 ship 3 — shared with `cms-provision upgrade`. Aborts the
  // wizard with a clear error if migrations fail (vs. silently
  // continuing with a half-migrated DB).
  {
    const { runMigrationsViaCloudRunJob } = await import("../migration-runner.js");
    const r = await runMigrationsViaCloudRunJob({ projectId, region });
    if (!r.ok) {
      cancel(`Migrations failed: ${r.error}. Inspect the Cloud Run Job logs and re-run.`);
      process.exit(1);
    }
  }

  // === 11.2. The gateway's database login (#613) ===
  // Migration 0248 created gateway_role without a password; it gets the
  // gateway-role-password secret's value here. The gateway (deployed by
  // Pulumi before migrations) retries its database on every request, so it
  // starts serving /api/* as soon as this lands — no restart.
  await stepGatewayRolePassword(projectId);

  // === 11.5. Operator access: IAP follows the Caelo user list ===
  await stepOperatorAccessSync(projectId, region, opts.provider ?? "gcp", ownerEmail);

  // === 12. Upload the fresh-install placeholder to the static bucket ===
  // Without this, https://<domain>/ returns the raw GCS NoSuchKey XML
  // until the operator publishes their first deploy. Idempotent: skips
  // if any object already exists at the bucket root (i.e. the static
  // generator has already published).
  //
  // v0.3.14 — gcp-firebase serves the static site from Firebase
  // Hosting, not a GCS bucket; the static-publisher's first deploy
  // creates the initial Firebase Hosting version. Skip the GCS
  // placeholder upload on that provider.
  if ((opts.provider ?? "gcp") === "gcp") {
    await stepUploadStaticPlaceholder(installId, projectId, domain);
  }

  // === 12. DNS records + bootstrap URL ===
  // IAP is enabled directly on the LB BackendService (Pulumi-managed);
  // no post-up gcloud step needed.
  await stepFinalize(installId);

  // Reference unused params to silence the linter.
  void domain;
  void ownerEmail;
}

/**
 * Resolve the floating `:latest` tag on each service's public AR image
 * to its current sha256 digest, so the Pulumi stack can pin Cloud Run
 * to the exact image rather than the mutable tag. Without this, a
 * fresh release doesn't trigger a new Cloud Run revision because the
 * image reference in the stack (":latest") is unchanged.
 *
 * `latest` = newest release — the same channel `cms-provision upgrade`
 * defaults to. Deliberately NOT the `:main` dev tag: fresh installs
 * start on a released version, and the per-merge dev images are pruned
 * after 7 days (docs/maintainer-public-registry-setup.md, "Retention").
 */
async function resolveImageDigests(): Promise<ImageDigests> {
  // The Caelo public image registry — not the install region.
  const project = "caelo-website";
  const registryRegion = "europe-west1";
  const repo = "caelo-cms-images";
  const out = { admin: "", gateway: "" };
  for (const service of ["admin", "gateway"] as const) {
    const s = spinner();
    s.start(`Resolving ${service}:latest → digest...`);
    // gcloud's --filter='tag=latest' is in a transitional state (warns +
    // matches nothing) and 'tag:latest' substring-matching is unreliable.
    // List all tags and grep for the exact-match row in JS.
    const r = await gcloud([
      "artifacts",
      "docker",
      "tags",
      "list",
      `${registryRegion}-docker.pkg.dev/${project}/${repo}/${service}`,
      "--format=value(tag,version)",
    ]);
    if (!r.ok) {
      s.stop(red(`Could not list ${service} tags: ${r.stderr.trim() || "(no output)"}`));
      cancel("Aborted.");
      process.exit(1);
    }
    const exact = r.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find(([tag]) => tag === "latest");
    const digest = exact?.[1] ?? "";
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      s.stop(red(`No usable 'latest' release image for ${service} (got: ${digest || "no tag"})`));
      cancel(
        "Aborted — the public mirror has no released image. Releases live at https://github.com/caelo-cms/caelo-cms/releases.",
      );
      process.exit(1);
    }
    s.stop(green(`${service}: ${dim(`${digest.slice(0, 19)}...`)}`));
    out[service] = digest;
  }
  return out;
}

// =========================================================================
// Per-step helpers
// =========================================================================

async function stepActiveGcloud(): Promise<void> {
  const stepName = "gcloud-active";
  const account = await activeAccount();
  if (!account) {
    log.error(red("No active gcloud account."));
    log.warn(
      `Run ${bold("gcloud auth login")} in another terminal, then re-run ${bold(selfCommand())}.`,
    );
    cancel("Aborted — no gcloud auth.");
    process.exit(2);
  }
  log.success(`gcloud auth: ${bold(account)}`);
  void stepName;
}

async function stepProjectId(opts: GcpWizardOpts): Promise<string> {
  if (opts.projectId) {
    log.info(`Project id: ${bold(opts.projectId)} ${dim("(supplied via --project-id)")}`);
    return opts.projectId;
  }
  const guess = opts.domain.split(".")[0]?.replace(/[^a-z0-9-]/g, "-") ?? "caelo";
  const value = await text({
    message: "GCP project id (will be created if absent)",
    placeholder: guess,
    defaultValue: guess,
    validate: (v) => {
      if (!v || v.length < 6 || v.length > 30) {
        return "GCP project id must be 6–30 chars";
      }
      if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(v)) {
        return "GCP project id: lowercase letters, digits, hyphens; start with letter; no trailing hyphen";
      }
      return undefined;
    },
  });
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value as string;
}

/**
 * Settle the install region (#607). A recorded region — or, for an install
 * deployed before install.json recorded one, the region its services run
 * in — is kept and a different `--region` is refused. A new install takes
 * a validated `--region`, or asks: the picker lists only regions with every
 * service the stack needs and preselects the gcloud default region (else
 * the EU default). Non-interactive without `--region` aborts with the list.
 */
async function stepRegion(
  opts: GcpWizardOpts,
  projectId: string,
  meta: InstallMetadata | null,
): Promise<string> {
  const provider = opts.provider ?? "gcp";
  const abort = (error: string): never => {
    log.error(red(error));
    cancel("Aborted.");
    process.exit(1);
  };
  // A region becomes fixed with the first `pulumi up`. One recorded by an
  // earlier run that stopped before it (cancelled at the cost table, a
  // failed setup step) is only preselected and may still change.
  const installed = isStepDone(opts.installId, `pulumi-up-${projectId}`);
  let deployed: string | null = null;
  if (!meta?.region && installed) {
    const live = await readDeployedRegion({ projectId });
    if (!live.ok) abort(live.error);
    else deployed = live.region;
  }
  const available = await installableRegions(provider);
  if (!available.ok) return abort(available.error);
  const regions = available.regions;
  const decision = decideRegion({
    provider,
    installId: opts.installId,
    recorded: installed ? (meta?.region ?? null) : null,
    deployed,
    preselected: installed ? null : (meta?.region ?? null),
    requested: opts.region,
    nonInteractive: opts.nonInteractive,
    regions,
  });
  switch (decision.kind) {
    case "refuse":
      return abort(decision.error);
    case "keep":
      log.info(
        `Region: ${bold(decision.region)} ${dim(`(${decision.from === "install.json" ? "recorded at install" : "where the install runs"} — fixed)`)}`,
      );
      return decision.region;
    case "use":
      log.info(`Region: ${bold(decision.region)} ${dim("(fixed once installed)")}`);
      return decision.region;
    case "prompt":
      break;
  }
  const suggestion: {
    region: string;
    source: "earlier-run" | "cli" | "eu-default";
    note?: string;
  } = decision.preselected
    ? { region: decision.preselected, source: "earlier-run" }
    : suggestRegion(provider, await detectCliRegion(provider), regions);
  if (suggestion.note) log.warn(suggestion.note);
  const sourceHint = {
    "earlier-run": "picked in your earlier run",
    cli: "your gcloud default",
    "eu-default": "EU default",
  }[suggestion.source];
  const choice = await select<string>({
    message: `Region for Cloud SQL, storage and the services ${dim("(fixed after install)")}`,
    initialValue: suggestion.region,
    maxItems: 12,
    options: regions.map((r) => ({
      value: r.id,
      label: r.id,
      hint: r.id === suggestion.region ? `${r.name} — ${sourceHint}` : r.name,
    })),
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return choice as string;
}

async function stepProjectCreate(installId: string, projectId: string): Promise<void> {
  const stepName = `project-create-${projectId}`;
  if (isStepDone(installId, stepName)) {
    log.success(`Project ${bold(projectId)} ${dim("(already created)")}`);
    return;
  }
  if (await projectExists(projectId)) {
    log.success(`Project ${bold(projectId)} ${dim("(exists)")}`);
    markStepDone(installId, stepName, { existed: true });
    return;
  }
  const s = spinner();
  s.start(`Creating GCP project ${projectId}...`);
  const r = await createProject(projectId, "Caelo CMS");
  if (!r.ok) {
    s.stop(red(`Failed: ${r.stderr.trim()}`));
    log.error(
      `gcloud projects create failed. Check that the id ${bold(projectId)} is globally unique + that you have project-create rights on the org.`,
    );
    cancel("Aborted.");
    process.exit(1);
  }
  s.stop(green(`Project ${bold(projectId)} created`));
  markStepDone(installId, stepName, { created: true });
}

async function stepBillingLink(
  installId: string,
  projectId: string,
  nonInteractive: boolean,
): Promise<void> {
  const stepName = `billing-link-${projectId}`;
  if (isStepDone(installId, stepName)) {
    log.success(`Billing already linked ${dim("(checkpoint)")}`);
    return;
  }
  const accounts = await listBillingAccounts();
  const open = accounts.filter((a) => a.open);
  if (open.length === 0) {
    log.error(red("No open billing accounts found."));
    log.warn(
      `Open one at https://console.cloud.google.com/billing then re-run ${bold(selfCommand())}.`,
    );
    cancel("Aborted.");
    process.exit(1);
  }
  let chosen: BillingAccount;
  if (open.length === 1) {
    [chosen] = open as [BillingAccount];
    log.info(`Billing account: ${bold(chosen.displayName)} ${dim(`(${chosen.id})`)}`);
  } else if (nonInteractive) {
    log.error(
      red(
        `Multiple billing accounts but --non-interactive passed. Re-run with --billing-account=<id> (one of: ${open.map((a) => a.id).join(", ")}).`,
      ),
    );
    cancel("Aborted.");
    process.exit(1);
  } else {
    const choice = await select<string>({
      message: "Pick a billing account",
      options: open.map((a) => ({
        value: a.id,
        label: a.displayName,
        hint: a.id,
      })),
    });
    if (isCancel(choice)) {
      cancel("Cancelled.");
      process.exit(0);
    }
    const found = open.find((a) => a.id === (choice as string));
    if (!found) {
      cancel("Picked account not found in list — internal error.");
      process.exit(1);
    }
    chosen = found;
  }
  const s = spinner();
  s.start(`Linking billing ${chosen.id}...`);
  const r = await linkBilling(projectId, chosen.id);
  if (!r.ok) {
    s.stop(red(`Failed: ${r.stderr.trim()}`));
    cancel("Aborted.");
    process.exit(1);
  }
  s.stop(green("Billing linked"));
  markStepDone(installId, stepName, { billingAccountId: chosen.id });
}

async function stepEnableApis(
  installId: string,
  projectId: string,
  provider: "gcp" | "gcp-firebase" = "gcp",
): Promise<void> {
  // v0.3.1 — gcp-firebase needs the Firebase Management + Firebase
  // Hosting APIs on top of the gcp baseline. Re-key the step name
  // so installs that initially ran with `gcp` and then re-ran with
  // `gcp-firebase` (re-key clears the checkpoint) re-enable the
  // additional APIs. The base APIs are idempotent → re-enabling
  // is a no-op.
  const stepName = `enable-apis-${provider}-${projectId}`;
  const apiCount =
    provider === "gcp-firebase" ? REQUIRED_API_LIST.length + 2 : REQUIRED_API_LIST.length;
  if (isStepDone(installId, stepName)) {
    log.success(`APIs enabled ${dim(`(${apiCount} services, checkpointed)`)}`);
    return;
  }
  const s = spinner();
  s.start(`Enabling ${apiCount} GCP APIs (15-30s)...`);
  const r = await enableApis(projectId, provider);
  if (!r.ok) {
    s.stop(red(`Failed: ${r.stderr.trim()}`));
    cancel("Aborted.");
    process.exit(1);
  }
  s.stop(green(`${apiCount} APIs enabled`));
  markStepDone(installId, stepName, { count: apiCount });
}

async function stepServiceAccount(
  installId: string,
  projectId: string,
  saEmail: string,
): Promise<void> {
  const stepName = `service-account-${PROVISIONER_ACCOUNT_ID}`;
  if (isStepDone(installId, stepName)) {
    log.success(`Provisioner SA ${dim("(already created)")}`);
    return;
  }
  if (await serviceAccountExists(projectId, saEmail)) {
    log.success(`Provisioner SA ${bold(saEmail)} ${dim("(exists)")}`);
    markStepDone(installId, stepName, { existed: true, saEmail });
    return;
  }
  const s = spinner();
  s.start(`Creating provisioner service account...`);
  const r = await createServiceAccount(projectId, PROVISIONER_ACCOUNT_ID, "Caelo provisioner");
  if (!r.ok) {
    s.stop(red(`Failed: ${r.stderr.trim()}`));
    cancel("Aborted.");
    process.exit(1);
  }
  s.stop(green(`Provisioner SA ${bold(saEmail)} created`));
  markStepDone(installId, stepName, { created: true, saEmail });
}

async function stepGrantRoles(
  installId: string,
  projectId: string,
  saEmail: string,
): Promise<void> {
  const stepName = `grant-roles-${projectId}`;
  if (isStepDone(installId, stepName)) {
    log.success(
      `IAM roles granted ${dim(`(${PROVISIONER_ROLE_LIST.length} roles, checkpointed)`)}`,
    );
    return;
  }
  const s = spinner();
  s.start(`Granting ${PROVISIONER_ROLE_LIST.length} IAM roles to the provisioner SA...`);
  const { granted, failed } = await grantProvisionerRoles(projectId, saEmail);
  if (failed.length > 0) {
    s.stop(
      red(`Granted ${granted}; failed ${failed.length}: ${failed.map((f) => f.role).join(", ")}`),
    );
    for (const f of failed) log.error(`${f.role}: ${f.error}`);
    log.error(
      `Some role bindings failed. You can re-run safely (idempotent), or grant the failed roles manually via gcloud.`,
    );
    cancel("Aborted.");
    process.exit(1);
  }
  s.stop(green(`${granted} IAM roles granted`));
  markStepDone(installId, stepName, { granted });
}

/**
 * Give `gateway_role` (created by migration 0248) its password from the
 * `gateway-role-password` secret (#613). public_role already has its own:
 * the stack set it from `public-role-password`. Idempotent, so it runs on
 * every wizard pass.
 */
async function stepGatewayRolePassword(projectId: string): Promise<void> {
  const s = spinner();
  s.start("Setting the gateway's database login (gateway_role)...");
  const install = { projectId, env: GCP_STACK_ENV };
  const sqlInstance = await findSqlInstance(install);
  const r = sqlInstance
    ? await ensureGatewayRolePassword({ ...install, sqlInstance })
    : { status: "failed" as const, error: "the Cloud SQL instance was not found" };
  if (r.status === "failed") {
    s.stop(red(`Failed: ${r.error ?? ""}`));
    log.error("Re-run the wizard once the cause is fixed (this step is idempotent).");
    cancel("Aborted.");
    process.exit(1);
  }
  s.stop(green("gateway_role ready"));
}

/**
 * Set up the operator-access sync job (operator-access.ts): the only
 * principal that may change who passes IAP, run as the operator's gcloud
 * identity. After migrations, because the job's database user gets the role
 * migration 0239 creates. Idempotent, so it runs on every wizard pass.
 */
async function stepOperatorAccessSync(
  projectId: string,
  region: string,
  provider: "gcp" | "gcp-firebase",
  ownerEmail: string,
): Promise<void> {
  const s = spinner();
  s.start("Setting up the operator-access sync job (Google IAP follows the user list)...");
  const resolved = await resolveOperatorAccessTarget({
    provider,
    projectId,
    region,
    env: GCP_STACK_ENV,
    ownerEmail,
  });
  const r = resolved.ok
    ? await ensureOperatorAccessSync(resolved.target)
    : { ok: false as const, done: [], error: resolved.error };
  if (!r.ok) {
    s.stop(red(`Failed: ${r.error}`));
    log.error("Re-run the wizard once the cause is fixed (this step is idempotent).");
    cancel("Aborted.");
    process.exit(1);
  }
  s.stop(green(`Operator-access sync job ready (${r.done.length} steps)`));
}

/**
 * Delete the firewall rules GCP pre-populates on the `default` network
 * (SSH, RDP, ICMP, internal; default-firewall.ts). A customised rule of the
 * same name, `default-allow-internal` while VMs sit on the default network,
 * or a failed delete is reported with the next step but does not stop
 * the install: the rules open nothing Caelo runs, and `upgrade` retries.
 */
async function stepRemoveDefaultFirewallRules(projectId: string): Promise<void> {
  const s = spinner();
  s.start("Removing the default network's pre-populated firewall rules...");
  const outcomes = await removeDefaultFirewallRules(projectId);
  const failed = outcomes.filter((o) => o.status === "failed");
  const deleted = outcomes.filter((o) => o.status === "applied");
  const summary =
    deleted.length > 0
      ? `deleted ${deleted.length} default firewall rule(s)`
      : "no pre-populated default-network firewall rules present";
  if (failed.length > 0) s.stop(yellow(`Default firewall rules: ${failed.length} not removed`));
  else s.stop(green(`Default firewall rules ok (${summary})`));
  for (const o of deleted) log.info(`  deleted: ${o.id} ${dim(`(${o.why})`)}`);
  for (const o of failed)
    log.warn(yellow(`  not removed: ${o.id} — ${o.why}\n    ${o.error ?? ""}`));
}

/**
 * #696 — make the provisioner SA usable without a key: the operator's gcloud
 * account gets TokenCreator on it, an older install's `sa-key.json` is
 * deleted (locally and in IAM), and the credential chain Pulumi will use —
 * Application Default Credentials impersonating the SA — is verified before
 * anything billable runs. Idempotent; runs on every wizard pass.
 */
async function stepKeylessProvisioner(
  projectId: string,
  secretsDir: string,
  nonInteractive: boolean,
): Promise<void> {
  const sa = provisionerServiceAccountEmail(projectId);
  const account = await activeAccount();
  if (!account) {
    cancel("No active gcloud account. Run `gcloud auth login`, then re-run.");
    process.exit(2);
  }
  const s = spinner();
  s.start(`Letting ${account} impersonate ${sa} (no key file)...`);
  const converged = await convergeKeylessProvisioner({
    projectId,
    secretsDir,
    operatorAccount: account,
    justCreated: true,
  });
  if (!converged.ok) {
    s.stop(red("Could not set up impersonation of the provisioner"));
    log.error(converged.error);
    cancel("Aborted.");
    process.exit(1);
  }
  if (converged.grant === "no-provisioner") {
    // stepServiceAccount ensured it and the lookup waited out propagation.
    s.stop(red(`${sa} does not exist`));
    cancel("Aborted — re-run the installer.");
    process.exit(1);
  }
  s.stop(
    green(
      converged.grant === "granted"
        ? `${account} may now impersonate ${sa}`
        : `${account} may impersonate ${sa} ${dim("(already)")}`,
    ),
  );
  if (converged.legacyKey === "removed") {
    log.warn(
      yellow("Removed the provisioner's long-lived key; this install now uses impersonation."),
    );
    for (const line of converged.lines) log.info(`  ${line}`);
  }

  const check = async () =>
    checkAdcImpersonation({
      projectId,
      operatorAccount: account,
      freshGrant: converged.grant === "granted",
    });
  const sAdc = spinner();
  sAdc.start("Checking that your Application Default Credentials can impersonate it...");
  let adc = await check();
  if (!adc.ok && adc.reason === "no-adc" && !nonInteractive) {
    sAdc.stop(yellow("No Application Default Credentials yet"));
    const login = await confirm({
      message: `Run ${bold("gcloud auth application-default login")} now (opens your browser; sign in as ${account})?`,
      initialValue: true,
    });
    if (isCancel(login) || !login) {
      log.error(adc.error);
      cancel("Aborted.");
      process.exit(1);
    }
    const { spawnSync } = await import("node:child_process");
    spawnSync("gcloud", ["auth", "application-default", "login"], { stdio: "inherit" });
    sAdc.start("Checking again...");
    adc = await check();
  }
  if (!adc.ok) {
    sAdc.stop(red("Infrastructure credentials not ready"));
    log.error(adc.error);
    cancel("Aborted.");
    process.exit(1);
  }
  sAdc.stop(green(`Pulumi will run as ${sa} via impersonation`));
}

/**
 * Decide and prepare where the install's Pulumi state lives (#696,
 * state-backend.ts chooseInstallBackend) and resolve it for Pulumi.
 *
 * For the ops bucket: ensures bucket + KMS key + IAM (idempotent, every
 * run), then records the backend in install.json and moves install.json +
 * progress.json into the bucket. A project whose bucket already holds
 * another install's install.json is refused — this machine would overwrite
 * that install's record; this install's own copy from an interrupted run is
 * taken over.
 */
async function stepStateBackend(
  installId: string,
  projectId: string,
  region: string,
  provisionerEmail: string,
): Promise<ResolvedBackend> {
  const root = installRoot(installId);
  const meta = readMetadata(installId);
  if (!meta) throw new Error(`No install.json for install '${installId}'.`);
  const kind = chooseInstallBackend(
    meta,
    hasLocalPulumiState(root),
    isStepDone(installId, `pulumi-up-${projectId}`),
  );
  if (kind === "local") {
    stepPulumiPassphrase(installId);
    log.info(
      `Pulumi state: ${dim(describeBackend(meta, root))} (this install predates state in project ${projectId}). Move it there, so any machine you sign in on can manage the install: ${bold(selfCommand("state", "migrate", "--install", installId))}`,
    );
    return resolveBackend(meta, {
      installRoot: root,
      readPassphrase: () => readSecret(installId, "pulumi-passphrase"),
    });
  }

  const account = await activeAccount();
  if (!account) {
    cancel("No active gcloud account. Run `gcloud auth login`, then re-run.");
    process.exit(1);
  }
  const s = spinner();
  s.start(`Ensuring the install's state bucket + KMS key in ${projectId}...`);
  const r = await ensureOpsBackend({
    projectId,
    region,
    operatorAccount: account,
    provisionerEmail,
  });
  if (!r.ok) {
    s.stop(red("Could not set up where the install's state lives"));
    log.error(r.error);
    cancel("Aborted before anything else was provisioned; fix the above and re-run.");
    process.exit(1);
  }
  s.stop(
    green(
      r.actions.length > 0
        ? `State bucket + KMS key ready ${dim(`(${r.actions.length} change(s))`)}`
        : `State bucket + KMS key ok ${dim("(already in place)")}`,
    ),
  );
  for (const a of r.actions) log.info(dim(`  ${a}`));

  if (meta.stateBackend?.kind !== "gcs") {
    const record = gcsBackendRecord(projectId, region);
    const existing = new GcsStateStore(record.bucket, root).peek("install.json");
    const other = existing === null ? null : (JSON.parse(existing) as Partial<InstallMetadata>);
    // The same install (id + creation time) is this machine's own earlier
    // run, interrupted between writing the bucket and the local copy:
    // finishing the move is safe. Anything else is another install.
    if (other && !(other.installId === meta.installId && other.createdAt === meta.createdAt)) {
      cancel(
        `Project ${projectId} already has a Caelo install (${other.domain ?? "unknown domain"}) whose state lives in gs://${record.bucket}. This run would overwrite that install's record. To manage it from this machine run: ${selfCommand("attach", "--project", projectId)}`,
      );
      process.exit(1);
    }
    adoptStateBackend(installId, record);
    log.success(
      `Pulumi state + install metadata live in ${bold(describeBackend({ stateBackend: record }, root))}`,
    );
  }
  const current = readMetadata(installId);
  if (!current) throw new Error(`install.json for '${installId}' vanished from its store.`);
  return resolveBackend(current, { installRoot: root, readPassphrase: () => null });
}

function stepPulumiPassphrase(installId: string): string {
  const existing = readSecret(installId, "pulumi-passphrase");
  if (existing) {
    log.success(`Pulumi passphrase ${dim("(reused from secrets/, not regenerated)")}`);
    return existing;
  }
  const passphrase = randomBytes(32).toString("hex");
  writeSecret(installId, "pulumi-passphrase", passphrase);
  log.success(
    `Pulumi passphrase generated → ${dim(`~/.caelo-${installId}/secrets/pulumi-passphrase`)}`,
  );
  return passphrase;
}

interface PulumiUpOpts {
  projectId: string;
  domain: string;
  /** #650 — the protected staging site's host (install setting). */
  stagingDomain: string;
  ownerEmail: string;
  region: string;
  /** #696 — the provisioner SA Pulumi impersonates (no key file). */
  impersonateServiceAccount: string;
  /** #696 — the install's state backend (state-backend.ts). */
  backend: ResolvedBackend;
  cloudSqlTier: string;
  cloudSqlHa: boolean;
  adminMinInstances: number;
  adminMemory: string;
  gatewayMinInstances: number;
  wafAdaptiveProtection: boolean;
  iapAllowlist: string[];
  imageDigests: ImageDigests;
  /** v0.3.1 — provider variant; routes pulumi up at the right stack. */
  provider?: "gcp" | "gcp-firebase";
}

async function stepPulumiUp(installId: string, opts: PulumiUpOpts): Promise<void> {
  const stepName = `pulumi-up-${opts.projectId}`;
  if (isStepDone(installId, stepName)) {
    log.success(`Pulumi up ${dim("(checkpointed — re-running for drift refresh)")}`);
  }
  const { secretsDir } = ensureInstallDir(installId);
  const root = installRoot(installId);
  log.info(`Pulumi up — wall-clock 8–15 min (Cloud SQL is the long pole). Streaming progress...`);

  let resourceCount = 0;
  const result = await pulumiUpGcp(
    {
      installId,
      installRoot: root,
      secretsDir,
      ...opts,
      provider: opts.provider ?? "gcp",
    },
    (kind, message) => {
      if (kind === "resource") {
        resourceCount++;
        if (resourceCount % 5 === 0) {
          process.stdout.write(`\r${dim(`  ${resourceCount} resources updated`)}`);
        }
      } else if (kind === "error") {
        process.stdout.write("\n");
        log.error(red(redactCredentials(message)));
      }
      // logs: silent — too noisy for a live progress UI; pulumi
      // diagnostics will print on failure via the SDK's onOutput.
    },
  );
  process.stdout.write("\n");
  log.success(
    green(
      `Pulumi up complete — ${result.resourceCount.created} created, ${result.resourceCount.updated} updated, ${result.resourceCount.deleted} deleted`,
    ),
  );
  markStepDone(installId, stepName, { outputs: result.outputs });
}

/**
 * Poll the load balancer's managed certificates until one serves the admin
 * host (cert-wait.ts). Pulumi reports a certificate "created" the moment GCP
 * queues it; validation takes 5-60 min after DNS resolves. Without this step
 * the wizard would print the bootstrap URL while HTTPS still fails. Only the
 * admin host is waited for: the main domain validates after go-live.
 */
async function stepWaitForCertActive(projectId: string, adminHost: string): Promise<void> {
  // clack's spinner swallows SIGINT; exit explicitly so Ctrl-C stops the wait.
  const s = spinner({
    cancelMessage: "Stopped. Re-run the installer to resume waiting for the certificate.",
    onCancel: () => process.exit(130),
  });
  s.start(
    `Waiting for the TLS certificate of ${adminHost} (usually 15-60 min once DNS resolves)...`,
  );
  log.info(
    dim(
      "Safe to stop with Ctrl-C: re-running the installer resumes here; finished steps are skipped.",
    ),
  );
  const r = await waitForCert({
    probe: () => lbCertProbe(gcloud, { projectId, hostname: adminHost }),
    timeoutMs: CERT_WAIT_TIMEOUT_MS,
    intervalMs: 30 * 1000,
    onUpdate: (detail) => s.message(`Certificate: ${detail}`),
  });
  if (r.ok) {
    s.stop(green(`TLS certificate for ${adminHost} is ACTIVE`));
    return;
  }
  if (r.reason === "error") {
    s.stop(red(r.error));
    cancel("Aborted.");
    process.exit(1);
  }
  s.stop(yellow(`The certificate for ${adminHost} is not ACTIVE after 60 min.`));
  log.warn(
    [
      "It may still finish on its own. Check its status with:",
      `  ${bold(`gcloud compute ssl-certificates list --global --project=${projectId}`)}`,
      "Common causes if it never turns ACTIVE:",
      `  - ${adminHost} does not resolve to the load balancer IP yet (check \`dig +short ${adminHost}\`)`,
      "  - the load balancer's port 80/443 is not reachable from the internet",
    ].join("\n"),
  );
}

/**
 * Run REASSIGN OWNED BY caelo_admin TO admin_role + DROP OWNED BY
 * caelo_admin in both cms_admin + cms_public, via a one-shot Cloud Run
 * Job. Idempotent: the SQL is wrapped in DO IF EXISTS so fresh installs
 * (no caelo_admin) + post-cleanup re-runs both pass through cleanly.
 *
 * Why this exists: the SQL-user rename in commit 3a81c37 left
 * `caelo_admin` in pg_roles owning N sequences/grants the prior
 * ALTER TABLE OWNER fix didn't reach. Pulumi's User-delete subsequently
 * fails with "role cannot be dropped because some objects depend on
 * it." REASSIGN/DROP OWNED clears them first.
 *
 * Skipped silently when no admin Cloud Run service exists (fresh
 * installs that haven't booted the admin yet).
 */
async function stepDrainLegacyCaeloAdminUser(projectId: string, region: string): Promise<void> {
  const s = spinner();
  s.start("Draining legacy caelo_admin postgres user (idempotent)...");

  // Resolve current admin image; skip if missing (fresh install).
  const adminDescr = await gcloud([
    "run",
    "services",
    "describe",
    "caelo-production-admin-3efcfea",
    "--region",
    region,
    "--project",
    projectId,
    "--format=json",
  ]);
  if (!adminDescr.ok) {
    s.stop(green("No admin service yet — nothing to drain (fresh install)"));
    return;
  }
  let adminImg = "";
  let networkRef = "";
  let subnetRef = "";
  try {
    const d = JSON.parse(adminDescr.stdout) as {
      spec: {
        template: {
          metadata?: { annotations?: Record<string, string> };
          spec: {
            containers: { image?: string }[];
            vpcAccess?: { networkInterfaces?: { network?: string; subnetwork?: string }[] };
          };
        };
      };
    };
    adminImg = d.spec.template.spec.containers[0]?.image ?? "";
    // Cloud Run v2 with Direct VPC stores network refs in the
    // `run.googleapis.com/network-interfaces` annotation (JSON-encoded
    // array), NOT in spec.template.spec.vpcAccess. Read both — newer
    // installs use the annotation; older ones use vpcAccess.
    const annotations = d.spec.template.metadata?.annotations ?? {};
    const niAnnotation = annotations["run.googleapis.com/network-interfaces"];
    if (niAnnotation) {
      try {
        const parsed = JSON.parse(niAnnotation) as { network?: string; subnetwork?: string }[];
        networkRef = parsed[0]?.network ?? "";
        subnetRef = parsed[0]?.subnetwork ?? "";
      } catch {
        // fall through to vpcAccess path
      }
    }
    if (!networkRef || !subnetRef) {
      const ni = d.spec.template.spec.vpcAccess?.networkInterfaces?.[0];
      networkRef ||= ni?.network ?? "";
      subnetRef ||= ni?.subnetwork ?? "";
    }
  } catch {
    s.stop(yellow("Could not parse admin service describe — skipping drain"));
    return;
  }
  if (!adminImg) {
    s.stop(green("No admin image to spawn drain job — skipping"));
    return;
  }
  if (!networkRef || !subnetRef) {
    s.stop(yellow("Could not resolve VPC network from admin service — skipping drain"));
    return;
  }

  // Read postgres superuser password from Secret Manager.
  const secretFetch = await gcloud([
    "secrets",
    "versions",
    "access",
    "latest",
    "--secret",
    "caelo-production-postgres-password",
    "--project",
    projectId,
  ]);
  if (!secretFetch.ok) {
    s.stop(yellow("Could not read postgres-password secret — skipping drain"));
    return;
  }
  const pgPass = secretFetch.stdout.trim();

  // Sync the SQL `postgres` user's password to the Secret Manager value
  // (Pulumi may have rotated the secret without applying to the user yet).
  await gcloud([
    "sql",
    "users",
    "set-password",
    "postgres",
    "--instance",
    "caelo-production-pg-1d65811",
    "--project",
    projectId,
    "--password",
    pgPass,
  ]);

  // Resolve the SQL instance's private IP from gcloud (avoids reading
  // Pulumi outputs from inside the wizard).
  const sqlDescr = await gcloud([
    "sql",
    "instances",
    "describe",
    "caelo-production-pg-1d65811",
    "--project",
    projectId,
    "--format=value(ipAddresses[0].ipAddress)",
  ]);
  const pgHost = (sqlDescr.stdout || "").trim();
  if (!pgHost) {
    s.stop(yellow("Could not resolve Cloud SQL private IP — skipping drain"));
    return;
  }

  const adminPg = `postgres://postgres:${pgPass}@${pgHost}:5432/cms_admin`;
  const publicPg = `postgres://postgres:${pgPass}@${pgHost}:5432/cms_public`;

  // The cleanup script — uses bun's globalThis.Bun.SQL (already proven
  // pattern in hooks.server.ts + the migration runner). DO block makes
  // it safe to re-run.
  //
  // Per-step rationale (validated against caelo-website production):
  //   - WITH INHERIT TRUE on both grants: PG 16 default is NOINHERIT,
  //     so plain "GRANT caelo_admin TO postgres" makes postgres a member
  //     but doesn't give it caelo_admin's privileges. REASSIGN OWNED
  //     fails with "Only roles with privileges of role caelo_admin may
  //     reassign objects owned by it." WITH INHERIT TRUE fixes it.
  //   - ALTER SCHEMA public OWNER TO admin_role: in PG 16 the default
  //     `public` schema is owned by cloudsqladmin (Cloud SQL) /
  //     pg_database_owner (vanilla). The REASSIGN's per-function ACL
  //     check ("permission denied for schema public") fails until
  //     admin_role owns it.
  //   - We count pg_proc (not pg_class): the legacy caelo_admin role
  //     left behind owned FUNCTIONS, not tables. The before count was
  //     31 on the caelo-website install; after was 0.
  const script = `const SQL = globalThis.Bun.SQL; async function fix(name, u){ const s = new SQL(u); console.log(\`[\${name}] connected\`); const before = await s.unsafe(\`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_roles r ON p.proowner=r.oid WHERE r.rolname = 'caelo_admin';\`); console.log(\`[\${name}] caelo_admin functions=\`, before); await s.unsafe(\`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='caelo_admin') THEN EXECUTE 'GRANT caelo_admin TO CURRENT_USER WITH INHERIT TRUE'; EXECUTE 'GRANT admin_role TO CURRENT_USER WITH INHERIT TRUE'; EXECUTE 'ALTER SCHEMA public OWNER TO admin_role'; EXECUTE 'REASSIGN OWNED BY caelo_admin TO admin_role'; EXECUTE 'DROP OWNED BY caelo_admin'; END IF; END $$;\`); const after = await s.unsafe(\`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_roles r ON p.proowner=r.oid WHERE r.rolname = 'caelo_admin';\`); console.log(\`[\${name}] after functions=\`, after); await s.end(); } await fix('cms_admin', process.env.ADMIN_PG); await fix('cms_public', process.env.PUBLIC_PG); console.log('drained');`;

  // Delete-then-create so we always run with the freshest config.
  await gcloud([
    "run",
    "jobs",
    "delete",
    "caelo-drain-legacy-user",
    "--region",
    region,
    "--project",
    projectId,
    "--quiet",
  ]);
  const create = await gcloud([
    "run",
    "jobs",
    "create",
    "caelo-drain-legacy-user",
    `--image=${adminImg}`,
    "--region",
    region,
    "--project",
    projectId,
    "--service-account",
    `caelo-production-run-sa@${projectId}.iam.gserviceaccount.com`,
    "--network",
    networkRef.split("/").pop() ?? networkRef,
    "--subnet",
    subnetRef.split("/").pop() ?? subnetRef,
    "--vpc-egress=private-ranges-only",
    "--command=bun",
    // ^|^ delimiter form — JS contains commas so we can't use the default.
    // Wrap in async IIFE so top-level `await` in SCRIPT works (sync eval()
    // doesn't support TLA; new Function('return (async () => { ... })()')
    // does, and avoids needing to write SCRIPT to disk).
    `--args=^|^--bun|-e|(new Function('return (async () => { ' + process.env.SCRIPT + ' })()'))()`,
    `--set-env-vars=^|^SCRIPT=${script}|ADMIN_PG=${adminPg}|PUBLIC_PG=${publicPg}`,
    "--max-retries=0",
    "--task-timeout=2m",
    "--quiet",
  ]);
  if (!create.ok) {
    s.stop(yellow(`Drain job create failed: ${create.stderr.trim()} — continuing`));
    return;
  }
  const exec = await gcloud([
    "run",
    "jobs",
    "execute",
    "caelo-drain-legacy-user",
    "--region",
    region,
    "--project",
    projectId,
    "--wait",
  ]);
  if (!exec.ok) {
    s.stop(red(`Drain job failed: ${exec.stderr.trim()}`));
    cancel(
      "Could not drain legacy caelo_admin user. Inspect the Cloud Run Job logs " +
        "(`gcloud logging read 'resource.type=cloud_run_job AND " +
        "resource.labels.job_name=caelo-drain-legacy-user' --project=" +
        projectId +
        "`) and re-run the wizard. Aborting before pulumi-up to avoid the " +
        "predictable pg user-delete failure downstream.",
    );
    process.exit(1);
  }
  s.stop(green("Legacy caelo_admin user drained"));
}

/**
 * Upload the static placeholder so https://<domain>/ shows a friendly
 * "Coming soon" landing instead of GCS's raw NoSuchKey XML. Skipped
 * if anything is already in the bucket root (the static-generator's
 * first publish replaces this transparently).
 */
async function stepUploadStaticPlaceholder(
  installId: string,
  projectId: string,
  domain: string,
): Promise<void> {
  const stepName = `static-placeholder-${projectId}`;
  if (isStepDone(installId, stepName)) {
    log.success(`Static placeholder uploaded ${dim("(checkpointed)")}`);
    return;
  }
  // Resolve bucket name from Pulumi outputs.
  const lsRoot = await gcloud([
    "storage",
    "buckets",
    "list",
    "--project",
    projectId,
    "--filter",
    "name~caelo-production-static",
    "--format=value(name)",
  ]);
  const bucketName = (lsRoot.stdout || "").trim().split(/\s+/)[0];
  if (!bucketName) {
    log.warn(yellow("Static bucket not found; skipping placeholder upload."));
    return;
  }
  // Idempotency: skip if anything is in the bucket root already.
  const existing = await gcloud([
    "storage",
    "ls",
    `gs://${bucketName}/index.html`,
    "--project",
    projectId,
  ]);
  if (existing.ok) {
    log.success(`Static bucket already populated ${dim("(skipping placeholder)")}`);
    markStepDone(installId, stepName, { skipped: "exists" });
    return;
  }

  // Resolve the placeholder asset relative to this file (works in dev
  // from src/ and in the published tarball from dist/).
  const here = new URL(import.meta.url).pathname;
  const candidates = [
    join(here, "..", "..", "..", "static", "welcome.html"),
    join(here, "..", "..", "..", "..", "static", "welcome.html"),
  ];
  let html = "";
  for (const path of candidates) {
    if (existsSync(path)) {
      html = readFileSync(path, "utf8");
      break;
    }
  }
  if (!html) {
    log.warn(yellow("welcome.html template not found; skipping placeholder upload."));
    return;
  }
  // Substitute the admin URL.
  html = html.replaceAll("{{ADMIN_URL}}", `https://admin.${domain}`);

  const s = spinner();
  s.start(`Uploading welcome page → gs://${bucketName}/index.html`);
  // Pipe via stdin so we don't write a temp file.
  const { spawn } = await import("node:child_process");
  const upload = await new Promise<{ ok: boolean; stderr: string }>((resolve) => {
    const child = spawn(
      "gcloud",
      [
        "storage",
        "cp",
        "--content-type",
        "text/html; charset=utf-8",
        "--cache-control",
        "no-cache, max-age=60",
        "-",
        `gs://${bucketName}/index.html`,
        "--project",
        projectId,
      ],
      { stdio: ["pipe", "inherit", "pipe"], env: gcloudEnv() },
    );
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ ok: code === 0, stderr }));
    child.stdin.write(html);
    child.stdin.end();
  });
  if (!upload.ok) {
    s.stop(red(`Upload failed: ${upload.stderr.trim()}`));
    return;
  }
  s.stop(green(`Welcome page live at https://${domain}/`));
  markStepDone(installId, stepName, { bucket: bucketName });
}

/**
 * The Owner setup link from the install's stack (`bootstrapUrlOut`). A
 * secret: read here, at the moment it is shown, never checkpointed (#656).
 * Fails loudly when the stack can't be read: the run's last step, so a
 * re-run picks it up.
 */
async function readBootstrapUrl(installId: string, provider: string): Promise<string> {
  const meta = readMetadata(installId);
  if (!meta) throw new Error(`No install.json for install '${installId}'.`);
  const value = await readStackOutput({
    backend: resolveBackend(meta, {
      installRoot: installRoot(installId),
      readPassphrase: () => readSecret(installId, "pulumi-passphrase"),
    }),
    provider: provider === "gcp-firebase" ? "gcp-firebase" : "gcp",
    name: "bootstrapUrlOut",
  });
  if (typeof value !== "string" || value === "") {
    throw new Error(
      "The stack has no bootstrapUrlOut output. Re-run the installer to refresh the stack.",
    );
  }
  return value;
}

/** The install's Pulumi outputs, as the `pulumi-up` step recorded them. */
async function recordedStackOutputs(
  installId: string,
  projectId: string,
): Promise<Record<string, unknown>> {
  const payload = (await import("../install-state.js")).getStepPayload<{
    outputs: Record<string, unknown>;
  }>(installId, `pulumi-up-${projectId}`);
  return payload?.outputs ?? {};
}

/** The stack's `dnsRecordsRequiredOut`, as records. */
function stackDnsRecords(outputs: Record<string, unknown>): InstallDnsRecord[] {
  return Array.isArray(outputs.dnsRecordsRequiredOut)
    ? (outputs.dnsRecordsRequiredOut as InstallDnsRecord[])
    : [];
}

const ADAPTER_RECORD_TYPES = new Set<string>(["A", "AAAA", "CNAME", "TXT"]);

/**
 * `gcp`: make the "set now" DNS records real through the DNS adapter
 * (Cloudflare API, or print + poll for a manual registrar) before the
 * certificate wait, which needs them. The main-domain records that switch a
 * live site are never applied here — the summary lists them for go-live.
 * Idempotent: a finished step is skipped on re-runs.
 */
async function stepGcpDnsRecords(installId: string): Promise<void> {
  const meta = readMetadata(installId);
  if (!meta?.projectId) return;
  const stepName = `dns-${meta.projectId}`;
  if (isStepDone(installId, stepName)) return;
  const records = stackDnsRecords(await recordedStackOutputs(installId, meta.projectId));
  if (records.length === 0) {
    cancel(
      "The stack reported no DNS records (dnsRecordsRequiredOut). Re-run the installer to refresh its outputs.",
    );
    process.exit(1);
  }
  const { setNow, atGoLive } = groupDnsRecords(records, meta.domain);
  if (atGoLive.length > 0) {
    log.warn(
      yellow(
        `Not touching ${meta.domain} itself: its records switch a live website to Caelo and are listed at the end for go-live.`,
      ),
    );
  }
  const toApply = setNow.filter((r): r is InstallDnsRecord & { type: DnsRecord["type"] } =>
    ADAPTER_RECORD_TYPES.has(r.type),
  );
  const adapter = await pickDnsAdapter({ domain: meta.domain });
  log.info(`DNS adapter: ${bold(adapter.name)}`);
  try {
    await adapter.applyRecords(
      toApply.map((r) => ({ hostname: r.hostname, type: r.type, value: r.value })),
    );
    markStepDone(installId, stepName, { adapter: adapter.name });
  } catch (e) {
    log.warn(
      yellow(`DNS records not confirmed yet: ${e instanceof Error ? e.message : String(e)}`),
    );
    log.warn(`Set them at your registrar, then re-run ${bold(selfCommand())} to resume.`);
    cancel("Stopped at the DNS step.");
    process.exit(1);
  }
}

async function stepFinalize(installId: string): Promise<void> {
  const meta = readMetadata(installId);
  if (!meta?.projectId) return;
  const outputs = await recordedStackOutputs(installId, meta.projectId);
  const provider = String(outputs.providerOut ?? "gcp");
  const adminDomainOut = String(outputs.adminDomainOut ?? `admin.${meta.domain}`);
  const adminCloudRunUrl = String(outputs.adminCloudRunUrlOut ?? "");

  // v0.3.15 — On gcp-firebase, the admin DomainMapping is opt-in
  // (`provisionAdminDomain=true` after Search Console verification);
  // without it, `admin.<domain>` doesn't resolve and the bootstrap
  // URL must point at the Cloud Run-generated *.run.app URL. The
  // bootstrap token in Pulumi's output already includes the right
  // path + query; we just swap the host.
  //
  // #656 — the link carries the setup token, so it is never checkpointed;
  // it is read from the stack here, where it is shown.
  const stackBootstrapUrl = await readBootstrapUrl(installId, provider);
  const bootstrapToken = stackBootstrapUrl.match(/token=([^&]+)/)?.[1] ?? "";
  const bootstrapUrl =
    provider === "gcp-firebase" && adminCloudRunUrl.length > 0
      ? `${adminCloudRunUrl}/setup?token=${bootstrapToken}`
      : stackBootstrapUrl;

  // Both providers report their records in `dnsRecordsRequiredOut`; the
  // summary lists them in two groups so the main-domain records that take a
  // live site offline are not set during the install (dns/groups.ts). On gcp
  // the "set now" group was already applied before the certificate wait.
  const dnsRecords = stackDnsRecords(outputs);
  const groups = groupDnsRecords(dnsRecords, meta.domain);
  const dnsLines: string[] = [];
  if (dnsRecords.length > 0) {
    dnsLines.push("", bold(`DNS records for ${meta.domain}:`));
    dnsLines.push(...formatDnsRecordGroups(groups, meta.domain).map((l) => `  ${l}`));
    if (groups.atGoLive.length > 0) {
      dnsLines.push(
        provider === "gcp-firebase"
          ? `    ${dim("Firebase Hosting issues TLS for the main domain itself once its records point at it.")}`
          : `    ${dim(`The certificate for ${meta.domain} is issued after the switch (15-60 min of HTTPS errors on it).`)}`,
      );
    }
  }

  const adminBase = provider === "gcp-firebase" ? adminCloudRunUrl : `https://${adminDomainOut}`;
  const adminNote: string[] =
    provider === "gcp-firebase"
      ? [
          "",
          bold("Admin custom domain (admin.<domain>):"),
          `  Not configured — using the Cloud Run URL above.`,
          `  To bind ${cyan(`admin.${meta.domain}`)}, run`,
          `  ${dim(selfCommand("admin-domain", "enable"))}`,
          `  (it walks you through the one-time Search Console verification, prints the DNS record and waits for the certificate).`,
          "",
          bold("Protected staging site:"),
          `  Stage builds render ${cyan(installStagingHost(meta))}; to serve it, run`,
          `  ${dim(selfCommand("staging-domain", "enable"))}`,
          `  It maps the host, turns on password protection and prints the staging login once;`,
          `  add the DNS record it prints. The host serves pages after the first Stage.`,
        ]
      : [];

  note(
    [
      green(`✓ ${meta.domain} provisioned.`),
      ...dnsLines,
      "",
      bold("Next steps:"),
      `  1. Owner setup — open in your browser (sign in with ${meta.ownerEmail}):`,
      `     ${cyan(String(bootstrapUrl))}`,
      `  2. AI provider — visit ${cyan(`${adminBase}/settings/ai`)} and paste your Anthropic API key`,
      `     (encrypted under the project KEK and stored in the database, no env vars).`,
      `  3. Optional: connect Claude Code or another MCP client — at ${cyan(`${adminBase}/settings/mcp`)}`,
      `     click ${bold("New token")} (scope ${bold("chat")}: Caelo's AI does the work; ${bold("admin")}: your agent drives Caelo's tools),`,
      "     copy the bearer (shown once) and run the `claude mcp add` command the page shows.",
      "     The admin is behind Google IAP, so run `gcloud auth application-default login` once on that machine.",
      `     Details: ${cyan("https://caelo-cms.com/mcp")}`,
      ...adminNote,
      "",
      bold("Lifecycle commands:"),
      `  ${dim(selfCommand("status"))}   — health check, and the exact upgrade command once a new release is out`,
      `  ${dim(selfCommand("destroy"))}  — tear everything down (irreversible)`,
      `  New releases: ${cyan(`${adminBase}/settings/updates`)} shows the exact upgrade command for this install.`,
    ].join("\n"),
    "Done",
  );
  void homedir; // unused-import guard
  void readFileSync;
}

// kleur unused-import guard for the yellow color helper kept for future warnings.
void yellow;
