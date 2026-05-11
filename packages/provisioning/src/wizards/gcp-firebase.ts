// SPDX-License-Identifier: MPL-2.0

/**
 * v0.3.0 — GCP Firebase Hosting provider wizard.
 *
 * Architectural differences from the `gcp` wizard:
 *   - No load balancer / url-map / TLS cert / BackendBucket
 *   - Static site → Firebase Hosting (apex domain)
 *   - admin.<domain> → Cloud Run direct + IAP-on-Cloud-Run
 *   - <domain>/api/* → Firebase Hosting `rewrites` → Cloud Run gateway
 *
 * The Pulumi stack at packages/provisioning/stacks/gcp-firebase/
 * provisions all of the above. The wizard's pre-Pulumi work
 * (gcloud auth, project, billing, APIs, SA, secrets, anthropic-api-key
 * capture) is structurally identical to the `gcp` wizard — same
 * helpers, same flow — only the final Pulumi invocation differs.
 *
 * For v0.3.0 the wizard delegates to the same gcp pre-Pulumi steps
 * via the shared `runGcpWizard` flow and only swaps the Pulumi
 * runtime target. If `runGcpWizard`'s flow needs to diverge further
 * (e.g. Firebase API enablement, Firebase project initialization),
 * we'll split it. Until then the duplication is one fn call.
 */

import { log, note } from "@clack/prompts";
import { bold, cyan } from "kleur/colors";

export interface GcpFirebaseWizardOpts {
  installId: string;
  domain: string;
  ownerEmail: string;
  projectId: string | null;
  nonInteractive: boolean;
}

export async function runGcpFirebaseWizard(opts: GcpFirebaseWizardOpts): Promise<void> {
  log.step(bold("GCP Firebase Hosting provider"));
  note(
    [
      "This provider variant uses:",
      `  ${cyan("Firebase Hosting")} for the static site (clean URLs + native preview channels)`,
      `  ${cyan("Cloud Run direct")} for admin (admin.<domain>, IAP-on-Cloud-Run)`,
      `  ${cyan("Firebase rewrites")} for the gateway (no LB, no Cloud Armor)`,
      "",
      "Lower fixed cost than the `gcp` provider (no LB ~$18/mo savings).",
      "Trade-off: no Cloud Armor on the gateway — in-app rate limits + Firebase Edge DDoS only.",
    ].join("\n"),
  );

  // For v0.3.0 the wizard delegates the gcloud pre-Pulumi steps to
  // the shared `runGcpWizard` since they're structurally identical
  // (project, billing, APIs, SA, secrets capture). The Pulumi stack
  // differs but the wizard arguments stay the same.
  //
  // The shared wizard knows to use the gcp-firebase stack folder
  // via the `provider` config the operator set earlier in
  // saveProvider().
  const { runGcpWizard } = await import("./gcp.js");
  await runGcpWizard({
    installId: opts.installId,
    domain: opts.domain,
    ownerEmail: opts.ownerEmail,
    projectId: opts.projectId,
    nonInteractive: opts.nonInteractive,
  });

  note(
    [
      `Next: run \`pulumi up\` against the gcp-firebase stack:`,
      `  cd packages/provisioning/stacks/gcp-firebase`,
      `  pulumi stack init prod`,
      `  pulumi config set caelo-gcp-firebase:domain ${opts.domain}`,
      `  pulumi config set caelo-gcp-firebase:ownerEmail ${opts.ownerEmail}`,
      `  pulumi up`,
      "",
      `Once Pulumi finishes, DNS instructions for the apex (${opts.domain}) and admin (admin.${opts.domain}) print to the console.`,
    ].join("\n"),
    "Pulumi (gcp-firebase stack)",
  );
}
