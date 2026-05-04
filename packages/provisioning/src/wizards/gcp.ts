// SPDX-License-Identifier: MPL-2.0

/**
 * GCP provider wizard — automates the gcloud bootstrap (project +
 * billing + APIs + SA + 15 IAM roles + key) end-to-end.
 *
 * Per §11.C: the user runs `bunx @caelo-cms/provisioning --provider gcp`
 * and never touches `gcloud` themselves. The wizard:
 *   1. Detects active gcloud account; prompts `gcloud auth login` if none
 *   2. Lists billing accounts; user picks
 *   3. Captures GCP project id (default suggested from domain)
 *   4. Creates the project (skips if exists)
 *   5. Links billing
 *   6. Enables 13 APIs in one call
 *   7. Creates the provisioner SA + grants 15 IAM roles
 *   8. Mints a JSON SA key into `~/.caelo-<install-id>/secrets/sa-key.json`
 *
 * Each step is checkpointed via install-state.markStepDone so re-runs
 * skip what's already done. Failures print the underlying gcloud
 * error + a "fix this then re-run" suggestion (per §11.C "fail loudly,
 * surface actionable next steps").
 *
 * Pulumi up + DNS + IAP enable land in commit 3 of the §11.C plan.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { cancel, isCancel, log, note, select, spinner, text } from "@clack/prompts";
import { bold, cyan, dim, green, red, yellow } from "kleur/colors";
import {
  activeAccount,
  type BillingAccount,
  createProject,
  createServiceAccount,
  createServiceAccountKey,
  enableApis,
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
  writeMetadata,
} from "../install-state.js";

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

  // === Done ===
  note(
    [
      green("✓ GCP project bootstrapped."),
      "",
      `${dim("project")}        ${bold(projectId)}`,
      `${dim("region")}         ${bold("europe-west1")} ${dim("(default; change via --region)")}`,
      `${dim("provisioner SA")} ${bold(saEmail)}`,
      `${dim("SA key")}         ${bold(keyPath)} ${dim("(mode 600)")}`,
      `${dim("install dir")}    ${bold(installRoot(installId))}`,
      "",
      cyan(
        "Next: cost-estimate pre-flight + Pulumi up + DNS + IAP enable. Lands in §11.C commit 3.",
      ),
    ].join("\n"),
    "Bootstrap complete",
  );

  log.info(
    `Until commit 3 ships: re-run ${bold("bunx @caelo-cms/provisioning")} once that commit lands and the wizard resumes from this checkpoint.`,
  );

  // Update install metadata with the region for now (default).
  if (meta) {
    writeMetadata(installId, { ...meta, projectId, region: "europe-west1" });
  }

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
    log.success(`IAM roles granted ${dim(`(${PROVISIONER_ROLE_LIST.length} roles, checkpointed)`)}`);
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

// kleur unused-import guard for the yellow color helper kept for future warnings.
void yellow;
