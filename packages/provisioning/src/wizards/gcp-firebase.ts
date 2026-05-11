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

  // v0.3.1 — the gcloud pre-Pulumi steps are structurally identical
  // (project, billing, APIs, SA, secrets capture) and the shared
  // `runGcpWizard` flow now accepts a `provider` arg that:
  //   - enables the additional Firebase APIs in stepEnableApis
  //   - routes the final pulumiUpGcp at stacks/gcp-firebase
  //   - uses the caelo-gcp-firebase config namespace
  const { runGcpWizard } = await import("./gcp.js");
  await runGcpWizard({
    installId: opts.installId,
    domain: opts.domain,
    ownerEmail: opts.ownerEmail,
    projectId: opts.projectId,
    nonInteractive: opts.nonInteractive,
    provider: "gcp-firebase",
  });
}
