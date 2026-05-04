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
 *  13. Post-up: enables IAP on the admin Cloud Run service
 *  14. Prints DNS records + bootstrap URL
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

  // === 9. Create Artifact Registry repo + copy public GHCR images ===
  // Cloud Run can't pull from ghcr.io directly, and AR's remote-repo
  // proxy needs upstream creds even for public images (GCP constraint).
  // Wizard handles the image-copy out-of-band so the Pulumi stack only
  // declares the IAM binding + the image URLs.
  await stepCopyImages(installId, projectId, region);

  // === 10. Pulumi up via Automation SDK ===
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
  });

  // === 10. IAP enable post-up ===
  await stepIapEnable(installId, projectId, region);

  // === 11. DNS records + bootstrap URL ===
  await stepFinalize(installId);

  // Reference unused params to silence the linter.
  void domain;
  void ownerEmail;
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

/**
 * Create an Artifact Registry repo (if missing) + copy the public
 * ghcr.io/caelo-cms/{admin,gateway} images into it. Cloud Run requires
 * images at `gcr.io|*.docker.pkg.dev|docker.io`; AR remote-repo proxies
 * always need upstream credentials even for public GHCR (per GCP), so
 * the wizard handles the copy out-of-band to keep §11.C's one-command
 * UX intact.
 */
async function stepCopyImages(installId: string, projectId: string, region: string): Promise<void> {
  const stepName = `copy-images-${projectId}`;
  if (isStepDone(installId, stepName)) {
    log.success(`Images copied to AR ${dim("(checkpointed)")}`);
    return;
  }
  const repoId = "caelo-production-images";
  const tag = "main";
  const services = ["admin", "gateway"];

  const sCheck = spinner();
  sCheck.start(`Ensuring Artifact Registry repo ${bold(repoId)} exists...`);
  const desc = await gcloud([
    "artifacts",
    "repositories",
    "describe",
    repoId,
    "--location",
    region,
    "--project",
    projectId,
  ]);
  if (!desc.ok) {
    const create = await gcloud([
      "artifacts",
      "repositories",
      "create",
      repoId,
      "--location",
      region,
      "--repository-format=docker",
      "--project",
      projectId,
      "--description",
      "Caelo CMS — operator-owned image cache",
    ]);
    if (!create.ok) {
      sCheck.stop(red(`AR repo create failed: ${create.stderr.trim()}`));
      cancel("Aborted.");
      process.exit(1);
    }
  }
  sCheck.stop(green(`AR repo ready: ${region}/${repoId}`));

  // Configure docker to authenticate against the AR host. Idempotent.
  const sAuth = spinner();
  sAuth.start(`Configuring docker auth for ${region}-docker.pkg.dev...`);
  const auth = await gcloud(["auth", "configure-docker", `${region}-docker.pkg.dev`, "--quiet"]);
  if (!auth.ok) {
    sAuth.stop(red(`docker auth config failed: ${auth.stderr.trim()}`));
    cancel("Aborted.");
    process.exit(1);
  }
  sAuth.stop(green(`docker auth configured`));

  // Pull from public GHCR + retag + push to AR. We do this with local
  // docker because `gcloud artifacts docker images copy` was removed
  // from gcloud SDK in late 2025 (it now lives in the `crane` Go tool
  // GCP doesn't ship). Local docker is universally available; the OSS
  // installer doc lists Docker Desktop as a prereq for non-Compose
  // installs.
  for (const service of services) {
    const src = `ghcr.io/caelo-cms/${service}:${tag}`;
    const dest = `${region}-docker.pkg.dev/${projectId}/${repoId}/${service}:${tag}`;
    const sCopy = spinner();
    sCopy.start(`Pulling ${src}...`);
    const pull = await runShell("docker", ["pull", "--platform", "linux/amd64", src]);
    if (!pull.ok) {
      sCopy.stop(red(`docker pull failed: ${pull.stderr.trim()}`));
      cancel("Aborted.");
      process.exit(1);
    }
    sCopy.message(`Tagging → ${dim(dest)}`);
    const tagR = await runShell("docker", ["tag", src, dest]);
    if (!tagR.ok) {
      sCopy.stop(red(`docker tag failed: ${tagR.stderr.trim()}`));
      cancel("Aborted.");
      process.exit(1);
    }
    sCopy.message(`Pushing ${service} → AR...`);
    const push = await runShell("docker", ["push", dest]);
    if (!push.ok) {
      sCopy.stop(red(`docker push failed: ${push.stderr.trim()}`));
      cancel("Aborted.");
      process.exit(1);
    }
    sCopy.stop(green(`Copied ${service}`));
  }
  markStepDone(installId, stepName, { repoId, services });
}

async function runShell(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      resolve({ ok: false, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
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

async function stepIapEnable(installId: string, projectId: string, region: string): Promise<void> {
  const stepName = `iap-enable-${projectId}`;
  if (isStepDone(installId, stepName)) {
    log.success(`IAP enabled on admin Cloud Run ${dim("(checkpointed)")}`);
    return;
  }
  const s = spinner();
  s.start("Enabling Identity-Aware Proxy on the admin Cloud Run...");
  const r = await gcloud([
    "beta",
    "run",
    "services",
    "update",
    "caelo-production-admin",
    "--region",
    region,
    "--project",
    projectId,
    "--iap",
    "--quiet",
  ]);
  if (!r.ok) {
    s.stop(red(`Failed: ${r.stderr.trim()}`));
    log.warn(
      `Continue manually: ${bold(`gcloud beta run services update caelo-production-admin --region=${region} --project=${projectId} --iap`)}.`,
    );
    return;
  }
  s.stop(green("IAP enabled — admin reachable only via your IAP allowlist"));
  markStepDone(installId, stepName, {});
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
