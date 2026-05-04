// SPDX-License-Identifier: MPL-2.0

/**
 * GCP provider wizard — scaffold.
 *
 * This file currently stops after metadata collection. The real
 * bootstrap automation (gcloud auth detect, project create, billing
 * link, API enable, SA + IAM, key mint, Pulumi up, DNS, IAP enable,
 * cost estimate) lands in subsequent commits per the §11.C plan.
 *
 * The stub deliberately *fails loudly* with a "not yet implemented"
 * outcome rather than silently swallowing — the contract is "the
 * wizard does it for you OR clearly says it can't yet".
 */

import { cancel, isCancel, log, note, text } from "@clack/prompts";
import { bold, dim, yellow } from "kleur/colors";
import { type InstallMetadata, readMetadata, writeMetadata } from "../install-state.js";

export interface GcpWizardOpts {
  installId: string;
  domain: string;
  ownerEmail: string;
  projectId: string | null;
  nonInteractive: boolean;
}

export async function runGcpWizard(opts: GcpWizardOpts): Promise<void> {
  // 1. GCP project id — operator picks. Default suggestion: derived from
  //    the domain. The wizard creates the project (in commit 2); this
  //    commit just collects + persists the input.
  let projectId = opts.projectId;
  if (!projectId) {
    const guess = opts.domain.split(".")[0]?.replace(/[^a-z0-9-]/g, "-") ?? "caelo";
    const value = await text({
      message: "GCP project id (will be created if absent)",
      placeholder: guess,
      defaultValue: guess,
      validate: (v) => {
        if (!v || v.length < 6 || v.length > 30) {
          return "GCP project id must be 6-30 chars";
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
    projectId = value as string;
  }

  // Persist the project id so re-runs don't re-prompt.
  const meta = readMetadata(opts.installId);
  if (meta) {
    const updated: InstallMetadata = { ...meta, projectId };
    writeMetadata(opts.installId, updated);
  }

  log.info(
    `Captured: ${bold(`project=${projectId}`)} ${dim(`domain=${opts.domain}`)} ${dim(`owner=${opts.ownerEmail}`)}`,
  );

  note(
    yellow(
      "GCP wizard scaffold only — bootstrap automation (project create, billing link, API enable, SA + IAM, Pulumi up, DNS, IAP) lands in subsequent commits.",
    ),
    "Status",
  );

  log.warn(
    `Today: run the gcloud bootstrap manually (see docs-site/install-gcp.md), then \`bunx @caelo-cms/provisioning init\` for the legacy self-hosted-style flow. End-to-end GCP automation: next commits.`,
  );
}
