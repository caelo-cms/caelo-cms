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
 *   8. Mints a JSON SA key into `~/.caelo-<install-id>/secrets/sa-key.json`
 *   9. Generates Pulumi passphrase if absent → secrets/pulumi-passphrase
 *  10. Pre-flight cost-estimate table; single y/N confirm
 *  11. Pulumi up via the Automation SDK; streams progress
 *  12. Prints DNS records + bootstrap URL + a note pointing the
 *      operator at /security/ai for AI provider key configuration
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
import { pickDnsAdapter } from "../dns/index.js";
import {
  activeAccount,
  type BillingAccount,
  createProject,
  createServiceAccount,
  createServiceAccountKey,
  enableApis,
  gcloud,
  grantProvisionerRoles,
  linkBilling,
  listBillingAccounts,
  PROVISIONER_ROLE_LIST,
  projectExists,
  REQUIRED_API_LIST,
  serviceAccountExists,
} from "../gcloud.js";
import {
  ensureInstallDir,
  type InstallMetadata,
  installRoot,
  isStepDone,
  markStepDone,
  readMetadata,
  readSecret,
  writeMetadata,
  writeSecret,
} from "../install-state.js";
import { estimateGcpCost } from "./gcp-cost.js";
import { pulumiUpGcp } from "./gcp-pulumi.js";

const SA_ACCOUNT_ID = "caelo-provisioner";

export interface GcpWizardOpts {
  installId: string;
  domain: string;
  ownerEmail: string;
  projectId: string | null;
  nonInteractive: boolean;
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

  // === 3. Project create ===
  await stepProjectCreate(installId, projectId);

  // === 4. Billing link ===
  await stepBillingLink(installId, projectId, opts.nonInteractive);

  // === 5. Enable APIs ===
  await stepEnableApis(installId, projectId, opts.provider ?? "gcp");

  // === 6. Service account + roles + key ===
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
  const saEmail = `${SA_ACCOUNT_ID}@${projectId}.iam.gserviceaccount.com`;
  await stepServiceAccount(installId, projectId, saEmail);
  await stepGrantRoles(installId, projectId, saEmail);
  const keyPath = await stepMintKey(installId, projectId, saEmail, secretsDir);

  // === 7. Pulumi passphrase ===
  // v0.3.2 — removed the legacy `stepAnthropicKey` prompt. The
  // runtime AI provider configuration lives at /security/ai (the
  // key is encrypted under the project KEK and stored in
  // ai_providers). Pre-v0.3.2 the wizard captured a key + stored
  // it in Secret Manager but the Cloud Run service never read it,
  // so the prompt was dead UX cost.
  const pulumiPassphrase = stepPulumiPassphrase(installId);

  const region = "europe-west1";
  if (meta) writeMetadata(installId, { ...meta, projectId, region });

  // === 8. Cost-estimate pre-flight ===
  // v0.3.3 — provider variant threads through so gcp-firebase
  // drops the LB / Cloud CDN / Cloud Armor lines (saves ~$19/mo
  // vs gcp). Default 'gcp' for backwards compatibility with
  // installs that don't set the field.
  const costInputs = {
    cloudSqlTier: "db-f1-micro",
    cloudSqlHa: false,
    adminMinInstances: 0,
    gatewayMinInstances: 0,
    wafAdaptiveProtection: false,
    provider: opts.provider ?? ("gcp" as const),
  };
  const estimate = estimateGcpCost(costInputs);
  note(
    [
      bold(
        "Estimated monthly cost (resource floor — actual usage adds AI calls + egress + storage growth)",
      ),
      "",
      ...estimate.lines.map(
        (l) =>
          `  ${dim(l.name.padEnd(40))} ${green(`$${l.monthlyUsd}`.padStart(5))}/mo  ${dim(l.notes ?? "")}`,
      ),
      "",
      `  ${bold("TOTAL".padEnd(40))} ${bold(`$${estimate.totalUsd}`.padStart(5))}/mo`,
    ].join("\n"),
    "Pre-flight",
  );
  if (!opts.nonInteractive) {
    const proceed = await confirm({
      message: `Provision ~${estimate.totalUsd} USD/mo on GCP project ${bold(projectId)}?`,
      initialValue: true,
    });
    if (isCancel(proceed) || !proceed) {
      cancel("Cancelled at cost confirmation.");
      process.exit(0);
    }
  }

  // === 9. Resolve image digests so each pulumi up rolls Cloud Run ===
  // Cloud Run keys revisions by image reference; if the reference is
  // a floating tag like ":main", a fresh image push doesn't trigger a
  // new revision because the reference text is unchanged. Resolve the
  // floating tag to its current sha256 digest so each provisioning run
  // pulls the freshest published image.
  const imageDigests = await resolveImageDigests(["admin", "gateway"]);

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
    ownerEmail,
    region,
    saKeyPath: keyPath,
    pulumiPassphrase,
    cloudSqlTier: costInputs.cloudSqlTier,
    cloudSqlHa: costInputs.cloudSqlHa,
    adminMinInstances: costInputs.adminMinInstances,
    gatewayMinInstances: costInputs.gatewayMinInstances,
    wafAdaptiveProtection: costInputs.wafAdaptiveProtection,
    iapAllowlist: [`user:${ownerEmail}`],
    imageDigests,
    // v0.3.1 — route pulumi up at the right stack folder + use the
    // matching config namespace.
    provider: opts.provider ?? "gcp",
  });

  // === 10. Wait for managed cert to flip from PROVISIONING → ACTIVE ===
  // Pulumi reports the cert "created" the moment GCP queues it; the
  // actual issuance + DNS validation takes 5-30 min depending on
  // load + DNS propagation. The bootstrap URL is meaningless until
  // ACTIVE — without this step the wizard would tell the operator
  // "you're done" while HTTPS still ERR_CONNECTION_CLOSEDs.
  await stepWaitForCertActive(projectId);

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

  // === 12. Upload the fresh-install placeholder to the static bucket ===
  // Without this, https://<domain>/ returns the raw GCS NoSuchKey XML
  // until the operator publishes their first deploy. Idempotent: skips
  // if any object already exists at the bucket root (i.e. the static
  // generator has already published).
  await stepUploadStaticPlaceholder(installId, projectId, domain);

  // === 12. DNS records + bootstrap URL ===
  // IAP is enabled directly on the LB BackendService (Pulumi-managed);
  // no post-up gcloud step needed.
  await stepFinalize(installId);

  // Reference unused params to silence the linter.
  void region;
  void domain;
  void ownerEmail;
}

/**
 * Resolve the floating `:main` tag on each service's public AR image
 * to its current sha256 digest, so the Pulumi stack can pin Cloud Run
 * to the exact image rather than the mutable tag. Without this, a
 * fresh release-images push doesn't trigger a new Cloud Run revision
 * because the image reference in the stack (":main") is unchanged.
 */
async function resolveImageDigests(services: string[]): Promise<Record<string, string>> {
  const project = "caelo-website";
  const region = "europe-west1";
  const repo = "caelo-cms-images";
  const out: Record<string, string> = {};
  for (const service of services) {
    const s = spinner();
    s.start(`Resolving ${service}:main → digest...`);
    // gcloud's --filter='tag=main' is in a transitional state (warns + matches
    // nothing) and 'tag:main' substring-matches main-<sha> too. List all tags
    // and grep for the exact-match row in JS.
    const r = await gcloud([
      "artifacts",
      "docker",
      "tags",
      "list",
      `${region}-docker.pkg.dev/${project}/${repo}/${service}`,
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
      .find(([tag]) => tag === "main");
    const digest = exact?.[1] ?? "";
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      s.stop(red(`Unexpected digest format for ${service}: ${digest}`));
      cancel("Aborted.");
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
      `Run ${bold("gcloud auth login")} in another terminal, then re-run ${bold("bunx @caelo-cms/provisioning")}.`,
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
      `Open one at https://console.cloud.google.com/billing then re-run ${bold("bunx @caelo-cms/provisioning")}.`,
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
  const stepName = `service-account-${SA_ACCOUNT_ID}`;
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
  const r = await createServiceAccount(projectId, SA_ACCOUNT_ID, "Caelo provisioner");
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
    s.stop(red(`Granted ${granted}; failed ${failed.length}: ${failed.join(", ")}`));
    log.error(
      `Some role bindings failed. You can re-run safely (idempotent), or grant the failed roles manually via gcloud.`,
    );
    cancel("Aborted.");
    process.exit(1);
  }
  s.stop(green(`${granted} IAM roles granted`));
  markStepDone(installId, stepName, { granted });
}

async function stepMintKey(
  installId: string,
  projectId: string,
  saEmail: string,
  secretsDir: string,
): Promise<string> {
  const stepName = `mint-key-${projectId}`;
  const keyPath = join(secretsDir, "sa-key.json");
  if (isStepDone(installId, stepName) && existsSync(keyPath)) {
    log.success(`SA key ${dim("(already minted, kept)")}`);
    return keyPath;
  }
  const s = spinner();
  s.start(`Minting SA key → ${dim(keyPath)}`);
  const r = await createServiceAccountKey(saEmail, keyPath);
  if (!r.ok) {
    s.stop(red(`Failed: ${r.stderr.trim()}`));
    cancel("Aborted.");
    process.exit(1);
  }
  s.stop(green(`SA key minted (mode 600)`));
  markStepDone(installId, stepName, { path: keyPath });
  return keyPath;
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
  ownerEmail: string;
  region: string;
  saKeyPath: string;
  pulumiPassphrase: string;
  cloudSqlTier: string;
  cloudSqlHa: boolean;
  adminMinInstances: number;
  gatewayMinInstances: number;
  wafAdaptiveProtection: boolean;
  iapAllowlist: string[];
  imageDigests: Record<string, string>;
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
        log.error(red(message));
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
 * Poll the LB managed SSL cert until both domains report ACTIVE.
 * Pulumi reports the cert "created" the moment GCP queues it; the actual
 * ACME-style validation against the LB takes 5-30 min. Without this
 * step the wizard would tell the operator "Done. Welcome to Caelo CMS"
 * while HTTPS still ERR_CONNECTION_CLOSEDs and the bootstrap URL is
 * useless. Times out after 35 min with a clear escalation note.
 */
async function stepWaitForCertActive(projectId: string): Promise<void> {
  const s = spinner();
  s.start("Waiting for managed TLS cert to validate (typically 5-15 min)...");
  const deadline = Date.now() + 35 * 60 * 1000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const r = await gcloud([
      "compute",
      "target-https-proxies",
      "list",
      "--project",
      projectId,
      "--format=value(sslCertificates)",
    ]);
    if (!r.ok) {
      s.stop(red(`gcloud target-https-proxies list failed: ${r.stderr.trim()}`));
      cancel("Aborted.");
      process.exit(1);
    }
    const certUrl = r.stdout.trim().split(/\s+/)[0] ?? "";
    const certName = certUrl.split("/").pop() ?? "";
    if (!certName) {
      s.stop(red("Could not resolve managed cert name from HTTPS proxy."));
      cancel("Aborted.");
      process.exit(1);
    }
    const desc = await gcloud([
      "compute",
      "ssl-certificates",
      "describe",
      certName,
      "--global",
      "--project",
      projectId,
      "--format=value(managed.status,managed.domainStatus)",
    ]);
    const text = (desc.stdout || "").trim();
    if (text !== lastStatus) {
      s.message(`Cert ${certName}: ${text || "(no status yet)"}`);
      lastStatus = text;
    }
    // Status format: "ACTIVE\t{'caelo-cms.com': 'ACTIVE', 'admin.caelo-cms.com': 'ACTIVE'}"
    if (/^ACTIVE\b/.test(text) && !/FAILED/.test(text) && !/PROVISIONING/.test(text)) {
      s.stop(green(`Managed TLS cert is ACTIVE for all domains`));
      return;
    }
    if (/FAILED_NOT_VISIBLE/.test(text)) {
      s.message(
        `${cyan(certName)} validation can't reach the LB yet — check DNS A records resolve to LB IP. Will keep polling.`,
      );
    }
    await new Promise((res) => setTimeout(res, 30 * 1000));
  }
  s.stop(yellow("Cert still not ACTIVE after 35 min."));
  log.warn(
    [
      "The cert may still finish on its own — Google Managed Cert validation can take up to 60 min.",
      "Check status anytime:",
      `  ${bold(`gcloud compute ssl-certificates list --global --project=${projectId}`)}`,
      "Common causes if it never flips ACTIVE:",
      "  - DNS A records don't resolve to the LB IP yet (check `dig +short caelo-cms.com`)",
      "  - The LB's HTTP port-80 listener isn't reachable from the public internet",
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
      { stdio: ["pipe", "inherit", "pipe"] },
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

async function stepFinalize(installId: string): Promise<void> {
  const meta = readMetadata(installId);
  const progress = readSecret(installId, "pulumi-passphrase"); // touch to verify state still present
  void progress;
  if (!meta) return;
  const upStep = `pulumi-up-${meta.projectId}`;
  const upPayload = (await import("../install-state.js")).getStepPayload<{
    outputs: Record<string, unknown>;
  }>(installId, upStep);
  const outputs = upPayload?.outputs ?? {};
  const lbIp = String(outputs.lbIpOut ?? "");
  const bootstrapUrl = outputs.bootstrapUrlOut ?? "<unknown>";
  const adminDomainOut = String(outputs.adminDomainOut ?? `admin.${meta.domain}`);

  // Auto-create DNS via Cloudflare if CLOUDFLARE_API_TOKEN is set;
  // otherwise the manual adapter prints + verify-polls.
  if (lbIp.length > 0 && lbIp !== "<unknown>") {
    const stepName = `dns-${meta.projectId}`;
    if (!isStepDone(installId, stepName)) {
      const adapter = await pickDnsAdapter({ domain: meta.domain });
      log.info(`DNS adapter: ${bold(adapter.name)}`);
      try {
        await adapter.applyRecords([
          { hostname: meta.domain, type: "A", value: lbIp },
          { hostname: adminDomainOut, type: "CNAME", value: "ghs.googlehosted.com." },
        ]);
        markStepDone(installId, stepName, { adapter: adapter.name });
      } catch (e) {
        log.warn(
          yellow(
            `DNS auto-create did not fully succeed: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
        log.warn(
          `Verify your DNS records manually + re-run ${bold("bunx @caelo-cms/provisioning")} to resume.`,
        );
      }
    }
  }

  note(
    [
      green(`✓ ${meta.domain} provisioned.`),
      "",
      bold("Owner setup (open in your browser):"),
      `  ${cyan(String(bootstrapUrl))}`,
      "",
      bold("Configure AI provider:"),
      `  After first login, visit ${cyan(`https://admin.${meta.domain}/security/ai`)} to paste your Anthropic API key.`,
      `  The key is encrypted under the project KEK + stored in ai_providers — no env-var management.`,
      "",
      bold("Lifecycle commands:"),
      `  ${dim("bunx @caelo-cms/provisioning status")}     — health check + monthly cost`,
      `  ${dim("bunx @caelo-cms/provisioning upgrade")}    — pull latest images + roll Cloud Run`,
      `  ${dim("bunx @caelo-cms/provisioning destroy")}    — tear everything down (irreversible)`,
    ].join("\n"),
    "Done",
  );
  void homedir; // unused-import guard
  void readFileSync;
}

// kleur unused-import guard for the yellow color helper kept for future warnings.
void yellow;
