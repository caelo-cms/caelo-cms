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
import {
  deriveInstallId,
  ensureInstallDir,
  type InstallMetadata,
  listInstalls,
  type Provider,
  readMetadata,
  writeMetadata,
} from "./install-state.js";
import { runGcpWizard } from "./wizards/gcp.js";
import { runGcpFirebaseWizard } from "./wizards/gcp-firebase.js";

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

  // 1. Resume-existing-install fast path. Before prompting for anything,
  //    scan ~/.caelo-* for installs and offer them as "resume X" options.
  //    Picking an existing install carries domain + owner + projectId
  //    over and skips re-prompting; "new install" falls through to the
  //    fresh-flow below.
  //
  //    v0.3.18 — previously the wizard re-asked for provider + domain +
  //    owner-email + project EVERY re-run. With this fast path, a
  //    re-run is a single Enter to "resume <id>".
  let provider: Provider;
  let domain: string;
  let ownerEmail: string;
  let projectIdHint: string | null;
  let installId: string;

  const existing = opts.nonInteractive ? [] : listInstalls();
  const resumeChoice =
    existing.length > 0 && !opts.provider && !opts.domain && !opts.ownerEmail
      ? await pickInstallToResume(existing)
      : null;

  if (resumeChoice) {
    provider = resumeChoice.provider;
    domain = resumeChoice.domain;
    ownerEmail = resumeChoice.ownerEmail;
    projectIdHint = resumeChoice.projectId;
    installId = resumeChoice.installId;
    ensureInstallDir(installId);
  } else {
    provider = opts.provider ?? (await pickProvider());
    domain = opts.domain ?? (await promptDomain());
    ownerEmail = opts.ownerEmail ?? (await promptOwnerEmail());
    projectIdHint = opts.projectId ?? null;
    installId = deriveInstallId(provider, projectIdHint ?? domain);
    ensureInstallDir(installId);

    // If the user picked "new install" but the derived id collides with
    // an existing one (e.g. retyped the same domain), confirm resume.
    const existingForId = readMetadata(installId);
    if (existingForId && !opts.nonInteractive) {
      const resume = await confirm({
        message: `Existing install '${installId}' detected (created ${dim(existingForId.createdAt)}). Resume?`,
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
        projectId: projectIdHint,
        domain,
        ownerEmail,
        region: null,
        createdAt: new Date().toISOString(),
      });
    }
  }

  // 4. Delegate to the provider-specific wizard.
  switch (provider) {
    case "gcp":
      await runGcpWizard({
        installId,
        domain,
        ownerEmail,
        projectId: projectIdHint,
        nonInteractive: opts.nonInteractive ?? false,
      });
      break;
    case "gcp-firebase":
      await runGcpFirebaseWizard({
        installId,
        domain,
        ownerEmail,
        projectId: projectIdHint,
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

/**
 * Offer the operator the list of existing installs (newest first)
 * plus a "start a new install" option. Returning `null` means the
 * operator picked "new" and the wizard falls through to the fresh-
 * inputs prompts. Returning an install means resume — every input
 * (provider, domain, owner, project) carries over from metadata.
 */
async function pickInstallToResume(installs: InstallMetadata[]): Promise<InstallMetadata | null> {
  const first = installs[0];
  // v0.5.14 — added per-install "Upgrade" entries that route to
  // upgradeCommand (Cloud Run image roll) without re-running the
  // wizard. Operator complaint: running bare `bunx @caelo-cms/
  // provisioning@latest` on a working install dropped them into
  // the wizard and they assumed it would upgrade. It didn't — the
  // wizard provisions, only `upgrade` rolls a running deployment.
  // Surfacing both intents in the same picker closes the gap.
  const choice = await select<string>({
    message:
      installs.length === 1 && first
        ? `What do you want to do with '${first.installId}'?`
        : "Pick an existing install (or start a new one):",
    options: [
      ...installs.flatMap((m) => [
        {
          value: `upgrade:${m.installId}`,
          label: `Upgrade ${bold(m.installId)} ${dim(`(${m.provider}, ${m.domain})`)}`,
          hint: `roll Cloud Run to the latest image — does not re-run the wizard`,
        },
        {
          value: `resume:${m.installId}`,
          label: `Resume wizard for ${bold(m.installId)} ${dim(`(${m.provider}, ${m.domain})`)}`,
          hint: `created ${m.createdAt.slice(0, 10)} — re-runs provisioning steps`,
        },
      ]),
      { value: "__new__", label: "Start a new install", hint: "fresh inputs" },
    ],
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  if (choice === "__new__") return null;
  // v0.5.14 — upgrade short-circuit. Dispatch to upgradeCommand
  // directly and exit; we don't fall through to runWizard's main flow.
  if (choice.startsWith("upgrade:")) {
    const installId = choice.slice("upgrade:".length);
    const target = installs.find((m) => m.installId === installId);
    if (!target) {
      cancel(`Could not find install metadata for '${installId}'.`);
      process.exit(1);
    }
    const { upgradeCommand } = await import("./lifecycle.js");
    // Defaults to channel=stable / tag=:latest — explicit-version is
    // available via `cms-provision upgrade --version vX.Y.Z`.
    await upgradeCommand();
    process.exit(0);
  }
  const installId = choice.startsWith("resume:") ? choice.slice("resume:".length) : choice;
  return installs.find((m) => m.installId === installId) ?? null;
}

async function pickProvider(): Promise<Provider> {
  const choice = await select<Provider>({
    message: "Where do you want to deploy?",
    options: [
      {
        value: "gcp",
        label: "Google Cloud Platform",
        hint: "Cloud Run + Cloud SQL + Cloud Storage + Cloud CDN. Single LB serves admin + gateway + static.",
      },
      {
        value: "gcp-firebase",
        label: "Google Cloud Platform (Firebase Hosting)",
        hint: "Cloud Run + Cloud SQL + Firebase Hosting (no LB). Lower fixed cost, native clean URLs + preview channels. Gateway via Firebase rewrites (no Cloud Armor).",
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
      if (
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(v)
      ) {
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
