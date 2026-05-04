// SPDX-License-Identifier: MPL-2.0

/**
 * `bunx @caelo-cms/provisioning` — interactive wizard.
 *
 * Per CLAUDE.md §11.C, this is the primary surface OSS users interact
 * with: one command, end-to-end, < 20 min, on the user's own cloud.
 *
 * Top-level shape:
 *   1. Pick provider (gcp / aws / azure / self-hosted)
 *   2. Detect existing install at `~/.caelo-<id>/` and offer to resume
 *   3. Prompt for the few inputs the provider needs (domain, owner email,
 *      project id, Anthropic key — input-hidden)
 *   4. Show cost estimate + final confirm
 *   5. Delegate to the provider-specific wizard which handles project
 *      bootstrap → Pulumi up → DNS → cert → IAP enable → bootstrap URL
 *
 * Each provider wizard is a separate file under `wizards/<provider>.ts`
 * so adding a new provider is one new file, not a sprawling switch.
 */

import { cancel, confirm, intro, isCancel, outro, select, spinner, text } from "@clack/prompts";
import { bold, cyan, dim } from "kleur/colors";
import { runGcpWizard } from "./wizards/gcp.js";
import {
  deriveInstallId,
  ensureInstallDir,
  type Provider,
  readMetadata,
  writeMetadata,
} from "./install-state.js";

export interface WizardOptions {
  /** Skip prompts; require all inputs via flags. CI-friendly. */
  nonInteractive?: boolean;
  /** Pre-supplied provider — skips the picker. */
  provider?: Provider;
  /** Pre-supplied domain — skips the prompt. */
  domain?: string;
  /** Pre-supplied owner email — skips the prompt. */
  ownerEmail?: string;
  /** Pre-supplied GCP project id — skips the prompt for gcp. */
  projectId?: string;
}

export async function runWizard(opts: WizardOptions = {}): Promise<void> {
  intro(bold(cyan("Caelo CMS provisioner")) + dim(" — one-command deploy"));

  // 1. Provider — pre-supplied via flag OR picker.
  const provider = opts.provider ?? (await pickProvider());

  // 2. Common inputs the provider wizard always needs. Provider-specific
  //    inputs (GCP project id, AWS region, etc.) are prompted inside the
  //    per-provider wizard.
  const domain = opts.domain ?? (await promptDomain());
  const ownerEmail = opts.ownerEmail ?? (await promptOwnerEmail());

  // 3. Per-install state directory + resume detection. The install id is
  //    derived from (provider, projectId-or-domain) so re-runs land here.
  //    For GCP we don't have the project id yet (it's the next prompt);
  //    use domain as the seed, then rewrite metadata once project id is
  //    set in the GCP wizard.
  const installId = deriveInstallId(provider, opts.projectId ?? domain);
  ensureInstallDir(installId);

  const existing = readMetadata(installId);
  if (existing && !opts.nonInteractive) {
    const resume = await confirm({
      message: `Existing install '${installId}' detected (created ${dim(existing.createdAt)}). Resume?`,
      initialValue: true,
    });
    if (isCancel(resume)) {
      cancel("Cancelled.");
      process.exit(0);
    }
    if (!resume) {
      cancel(`Aborted. Run with a different domain or remove ~/.caelo-${installId}/ first.`);
      process.exit(0);
    }
  } else {
    writeMetadata(installId, {
      installId,
      provider,
      projectId: opts.projectId ?? null,
      domain,
      ownerEmail,
      region: null,
      createdAt: new Date().toISOString(),
    });
  }

  // 4. Delegate to the provider-specific wizard.
  switch (provider) {
    case "gcp":
      await runGcpWizard({
        installId,
        domain,
        ownerEmail,
        projectId: opts.projectId ?? null,
        nonInteractive: opts.nonInteractive ?? false,
      });
      break;
    case "self-hosted":
      cancel(
        "Self-hosted wizard is the existing `cms-provision init` flow. Run `bunx @caelo-cms/provisioning init --domain ... --owner-email ...` for now; wizard polish lands in a follow-up commit.",
      );
      process.exit(0);
      break;
    case "aws":
    case "azure":
      cancel(
        `${provider.toUpperCase()} provider wizard not yet implemented. GCP is the first cloud target; AWS + Azure follow the same shape and land in upcoming commits.`,
      );
      process.exit(0);
      break;
  }

  outro(bold("Done. Welcome to Caelo CMS."));
}

async function pickProvider(): Promise<Provider> {
  const choice = await select<Provider>({
    message: "Where do you want to deploy?",
    options: [
      {
        value: "gcp",
        label: "Google Cloud Platform",
        hint: "Cloud Run + Cloud SQL + Cloud Storage + Cloud CDN. Default for v0.1.",
      },
      {
        value: "self-hosted",
        label: "Self-hosted (Docker Compose)",
        hint: "Single Linux box. Postgres + Caddy + the admin + the gateway.",
      },
      {
        value: "aws",
        label: "Amazon Web Services",
        hint: "Lambda + RDS + S3 + CloudFront. Lands in a follow-up commit.",
      },
      {
        value: "azure",
        label: "Microsoft Azure",
        hint: "Container Apps + Azure DB + Blob + Front Door. Lands in a follow-up commit.",
      },
    ],
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return choice as Provider;
}

async function promptDomain(): Promise<string> {
  const value = await text({
    message: "Domain you'd like to use",
    placeholder: "mysite.com",
    validate: (v) => {
      if (!v || v.length === 0) return "Domain is required";
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(v)) {
        return "Looks like an invalid domain (e.g. mysite.com)";
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

async function promptOwnerEmail(): Promise<string> {
  const value = await text({
    message: "Owner email (you'll be the IAP allowlisted Owner; can add more later)",
    placeholder: "you@example.com",
    validate: (v) => {
      if (!v || v.length === 0) return "Email is required";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "Looks like an invalid email";
      return undefined;
    },
  });
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value as string;
}

// Re-export the spinner factory so per-provider wizards use a consistent UX.
export { spinner };
