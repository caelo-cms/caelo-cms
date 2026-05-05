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
 *   9. Captures Anthropic API key (input-hidden) → secrets/anthropic-api-key
 *  10. Generates Pulumi passphrase if absent → secrets/pulumi-passphrase
 *  11. Pre-flight cost-estimate table; single y/N confirm
 *  12. Pulumi up via the Automation SDK; streams progress
 *  13. Prints DNS records + bootstrap URL (IAP runs on the LB
 *      BackendService; no post-up gcloud step needed)
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  cancel,
  confirm,
  isCancel,
  log,
  note,
  password,
  select,
  spinner,
  text,
} from "@clack/prompts";
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
  await stepEnableApis(installId, projectId);

  // === 6. Service account + roles + key ===
  const saEmail = `${SA_ACCOUNT_ID}@${projectId}.iam.gserviceaccount.com`;
  await stepServiceAccount(installId, projectId, saEmail);
  await stepGrantRoles(installId, projectId, saEmail);
  const keyPath = await stepMintKey(installId, projectId, saEmail, secretsDir);

  // === 7. Anthropic API key + Pulumi passphrase ===
  const anthropicKey = await stepAnthropicKey(installId, opts.nonInteractive);
  const pulumiPassphrase = stepPulumiPassphrase(installId);

  const region = "europe-west1";
  if (meta) writeMetadata(installId, { ...meta, projectId, region });

  // === 8. Cost-estimate pre-flight ===
  const costInputs = {
    cloudSqlTier: "db-f1-micro",
    cloudSqlHa: false,
    adminMinInstances: 0,
    gatewayMinInstances: 0,
    wafAdaptiveProtection: false,
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
    anthropicApiKey: anthropicKey,
    cloudSqlTier: costInputs.cloudSqlTier,
    cloudSqlHa: costInputs.cloudSqlHa,
    adminMinInstances: costInputs.adminMinInstances,
    gatewayMinInstances: costInputs.gatewayMinInstances,
    wafAdaptiveProtection: costInputs.wafAdaptiveProtection,
    iapAllowlist: [`user:${ownerEmail}`],
    imageDigests,
  });

  // === 10. Wait for managed cert to flip from PROVISIONING → ACTIVE ===
  // Pulumi reports the cert "created" the moment GCP queues it; the
  // actual issuance + DNS validation takes 5-30 min depending on
  // load + DNS propagation. The bootstrap URL is meaningless until
  // ACTIVE — without this step the wizard would tell the operator
  // "you're done" while HTTPS still ERR_CONNECTION_CLOSEDs.
  await stepWaitForCertActive(projectId);

  // === 11. Upload the fresh-install placeholder to the static bucket ===
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
    s.stop(green(`${service}: ${dim(digest.slice(0, 19) + "...")}`));
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

async function stepEnableApis(installId: string, projectId: string): Promise<void> {
  const stepName = `enable-apis-${projectId}`;
  if (isStepDone(installId, stepName)) {
    log.success(`APIs enabled ${dim(`(${REQUIRED_API_LIST.length} services, checkpointed)`)}`);
    return;
  }
  const s = spinner();
  s.start(`Enabling ${REQUIRED_API_LIST.length} GCP APIs (15-30s)...`);
  const r = await enableApis(projectId);
  if (!r.ok) {
    s.stop(red(`Failed: ${r.stderr.trim()}`));
    cancel("Aborted.");
    process.exit(1);
  }
  s.stop(green(`${REQUIRED_API_LIST.length} APIs enabled`));
  markStepDone(installId, stepName, { count: REQUIRED_API_LIST.length });
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

async function stepAnthropicKey(installId: string, nonInteractive: boolean): Promise<string> {
  const existing = readSecret(installId, "anthropic-api-key");
  if (existing) {
    log.success(`Anthropic API key ${dim("(reused from secrets/, not re-prompted)")}`);
    return existing;
  }
  if (nonInteractive) {
    log.error(red("Missing Anthropic API key + --non-interactive — cannot proceed."));
    log.warn(
      `Write the key to ${bold(`~/.caelo-${installId}/secrets/anthropic-api-key`)} (mode 600) then re-run.`,
    );
    cancel("Aborted.");
    process.exit(1);
  }
  const value = await password({
    message: "Anthropic API key (input hidden; saved to secrets/anthropic-api-key)",
    validate: (v) => {
      if (!v || v.length < 20) return "Looks too short — Anthropic keys start with sk-ant-";
      if (!v.startsWith("sk-")) return "Should start with sk-";
      return undefined;
    },
  });
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  const key = (value as string).trim();
  writeSecret(installId, "anthropic-api-key", key);
  log.success(`Anthropic key saved → ${dim(`~/.caelo-${installId}/secrets/anthropic-api-key`)}`);
  return key;
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
  anthropicApiKey: string;
  cloudSqlTier: string;
  cloudSqlHa: boolean;
  adminMinInstances: number;
  gatewayMinInstances: number;
  wafAdaptiveProtection: boolean;
  iapAllowlist: string[];
  imageDigests: Record<string, string>;
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
