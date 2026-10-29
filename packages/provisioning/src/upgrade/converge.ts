// SPDX-License-Identifier: MPL-2.0

/**
 * The converge half of an upgrade (epic #696): everything that changes IAM,
 * service accounts, secrets or other cloud resources so the install matches
 * what the release's stacks declare — the gateway's run SA and the
 * CLI-generated runtime secrets, the stack's IAM/CDN/firewall invariants,
 * MCP access through IAP, public_role's Cloud SQL role memberships (#633),
 * the gateway's and public_role's database logins, the operator-access sync
 * job, the quality-audit job (#875), the remote-MCP load-balancer rules and
 * identity env (#806), and dropping bindings nothing reads any more.
 *
 * It needs the rights of whoever provisioned the install: `cms-provision
 * upgrade` runs it as the operator's own identity, and the converge job
 * (#819, converge-job.ts) runs the same upgrade as the install's
 * `caelo-provisioner` account. Never the in-cloud upgrader job, which only
 * app-rolls and refuses while {@link needsConverge} says the install is
 * behind.
 *
 * The keyless-provisioner step (#696, provisioner-identity.ts) is converge
 * too; it needs the operator's local install dir, so the CLI injects it as
 * {@link ConvergeDeps.provisionerIdentity} (the converge job, which IS the
 * provisioner, has nothing to move and passes none).
 *
 * Some steps must sit between app-roll steps (a role migration 0248 creates
 * gets its password after migrations, before the gateway rolls onto it), so
 * a converge is a {@link ConvergeSession}: a part before the app-roll, the
 * {@link AppRollHooks} the app-roll calls in between, and a part after it.
 */

import { ensureAuditJob, resolveAdminImage } from "../audit-job-setup.js";
import { ensureCaptureJob } from "../capture-job-setup.js";
import { ensureConvergeJob } from "../converge-job-setup.js";
import { findSqlInstance, planPublicRoleSwitch } from "../gateway-credentials.js";
import type { GcloudRunner, Sleep } from "../gcloud-retry.js";
import { upgraderServiceAccountEmail } from "../gcp-names.js";
import type { InstallMetadata } from "../install-state.js";
import { ensureMcpIapAccess, type IapResource } from "../mcp-iap.js";
import { ensureOperatorAccessSync, resolveOperatorAccessTarget } from "../operator-access.js";
import { revokePublicRoleMemberships } from "../public-role-isolation.js";
import { ensureRemoteMcpEdge, resolveRemoteMcpIdentity } from "../remote-mcp.js";
import {
  ensureGatewayServiceAccount,
  ensureGeneratedSecrets,
  type HttpFetch,
  plainGeneratedSecretSeed,
  readSecretReplication,
} from "../runtime-secrets.js";
import { selfCommand } from "../self-command.js";
import {
  AUDIT_JOB_ENV_VAR,
  AUDIT_RESULTS_BUCKET_ENV_VAR,
  CAPTURE_BUCKET_ENV_VAR,
  CAPTURE_JOB_ENV_VAR,
  type CloudRunEnvVar,
  CONVERGE_JOB_ENV_VAR,
  MCP_ENV_VAR,
  OPERATOR_ACCESS_JOB_ENV_VAR,
  remoteMcpIdentityEnv,
  UPGRADER_JOB_ENV_VAR,
} from "../stack-contract.js";
import {
  deleteRetiredSecrets,
  ensureStackInvariants,
  liveEnvHasInlinePassword,
  removeRetiredIamBindings,
} from "../stack-converge.js";
import { ensureUpgraderJob, resolveUpgraderTarget } from "../upgrader-setup.js";
import { ensureUrlMapRedirectsAccess } from "../url-map-redirects-access.js";
import type { AppRollHooks, AppRollPlan, RollPlan, RollSlug } from "./app-roll.js";
import { lookupFailure } from "./gcp-lookup.js";
import type { UpgradeReporter } from "./reporter.js";

/**
 * Whether the install must converge before an app-roll to a release that
 * expects infrastructure contract `targetVersion` (infra-contract.ts). An
 * install with no recorded version has never completed a converge under
 * this scheme and always needs one.
 */
export function needsConverge(
  install: Pick<InstallMetadata, "infraContractVersion">,
  targetVersion: number,
): boolean {
  return (install.infraContractVersion ?? 0) < targetVersion;
}

export interface ConvergeDeps {
  readonly run: GcloudRunner;
  readonly sleep?: Sleep;
  /** Cloud SQL Admin API calls (database role passwords). */
  readonly http?: HttpFetch;
  readonly reporter: UpgradeReporter;
  /**
   * The operator's own identity step, run first: the CLI moves the
   * provisioner SA to keyless impersonation (provisioner-identity.ts), which
   * needs the operator's gcloud account and local install dir. False aborts.
   */
  readonly provisionerIdentity?: () => Promise<boolean>;
  /**
   * The release's caelo-ops image, digest-pinned — what the upgrader job
   * runs (upgrader-setup.ts). Null when it could not be resolved: the step
   * then fails and the converge stays incomplete.
   */
  readonly opsImageRef?: string | null;
}

export interface ConvergeSession {
  /**
   * Before the app-roll: runtime identities + secrets, stack invariants,
   * public_role's Cloud SQL role memberships (#633), MCP access. False when a step the install cannot work without failed —
   * nothing app-side changed then.
   */
  beforeAppRoll(): Promise<boolean>;
  /** The steps the app-roll runs between its own. */
  readonly hooks: AppRollHooks;
  /** After a successful app-roll: retire bindings nothing reads any more. */
  afterAppRoll(): Promise<void>;
  /**
   * Whether every converge step succeeded — only then may the install's
   * infrastructure contract version be recorded.
   */
  complete(): boolean;
  /**
   * Whether the part before the app-roll changed access the health check
   * relies on (an IAM binding, MCP access, the gateway's ingress). Google
   * applies such changes only after a while, so the health baseline then
   * waits for a refusal to clear (health.ts, #734).
   */
  accessJustChanged(): boolean;
}

/** Start a converge for the install `plan` rolls. */
export function startConverge(
  plan: AppRollPlan,
  ownerEmail: string,
  deps: ConvergeDeps,
): ConvergeSession {
  const { install } = plan;
  const { reporter: r, run } = deps;
  const runDeps = { run, ...(deps.sleep ? { sleep: deps.sleep } : {}) };
  const service = (slug: RollSlug) => plan.services.find((s) => s.slug === slug) as RollPlan;
  const services = { admin: service("admin").serviceName, gateway: service("gateway").serviceName };
  const target = {
    provider: install.provider,
    projectId: install.projectId,
    region: install.region,
    env: install.env,
    services,
  };
  let incomplete = false;
  let accessChanged = false;
  // Env vars the rolls must leave as the services have them, because the
  // thing they point at could not be set up.
  const leaveUntouched: string[] = [];
  let publicRole: ReturnType<typeof planPublicRoleSwitch> | null = null;

  async function runtimeIdentities(): Promise<boolean> {
    // The gateway's own run SA and the CLI-generated secrets the env
    // contract references. Created once, never overwritten; must exist
    // before the invariants bind them and the rolls reference them.
    const s = r.step("Ensuring the gateway service account + generated runtime secrets...");
    const secretsTarget = { projectId: install.projectId, env: install.env };
    const replication = await readSecretReplication(secretsTarget, runDeps);
    const outcomes = [
      await ensureGatewayServiceAccount(secretsTarget, runDeps),
      ...(replication.ok
        ? await ensureGeneratedSecrets(
            {
              ...secretsTarget,
              region: install.region,
              replication: replication.replication,
              seed: plainGeneratedSecretSeed(service("admin").liveEnv),
            },
            runDeps,
          )
        : [{ id: "secret replication", status: "failed" as const, error: replication.error }]),
    ];
    const failed = outcomes.filter((o) => o.status === "failed");
    if (failed.length > 0) {
      s.failed("Runtime identities/secrets could not be ensured. Aborting upgrade.");
      for (const o of failed) r.error(`  FAILED: ${o.id}\n    ${o.error ?? ""}`);
      r.warn("No traffic was shifted and no migrations ran. Fix the above and re-run.");
      return false;
    }
    s.done("Gateway service account + runtime secrets ok");
    for (const o of outcomes.filter((o) => o.status === "applied")) {
      r.info(`  created: ${o.id}${o.detail ? ` (${o.detail})` : ""}`);
    }
    return true;
  }

  async function stackInvariants(): Promise<boolean> {
    // IAM bindings + CDN policy added to the stacks after this install was
    // provisioned (stack-contract.ts), a gcp-firebase gateway's ingress
    // (#732), and GCP's SSH/RDP-from-anywhere firewall rules removed
    // (default-firewall.ts). Before the app-roll: its health baseline
    // reaches the gateway through that ingress. Idempotent.
    const s = r.step(
      "Ensuring the IAM bindings, CDN settings and gateway ingress the stack declares, removing the default network's pre-populated firewall rules...",
    );
    const report = await ensureStackInvariants(target, runDeps);
    const applied = report.outcomes.filter((o) => o.status === "applied");
    const failed = report.outcomes.filter((o) => o.status === "failed");
    if (report.mustAbort) s.failed("Stack invariants could not be ensured. Aborting upgrade.");
    else {
      s.done(
        `Stack invariants ok (${report.outcomes.length - failed.length}/${report.outcomes.length}, ${applied.length} applied)`,
      );
    }
    if (applied.length > 0) accessChanged = true;
    for (const o of applied) r.info(`  applied: ${o.id} (${o.why})`);
    for (const o of failed) {
      const line = `  ${o.onFailure === "abort" ? "FAILED" : "not applied"}: ${o.id} — ${o.why}\n    ${o.error ?? ""}`;
      if (o.onFailure === "abort") r.error(line);
      else r.warn(line);
    }
    if (failed.length > 0) incomplete = true;
    if (report.mustAbort) {
      r.warn("No traffic was shifted and no migrations ran. Fix the bindings above and re-run.");
      return false;
    }
    return true;
  }

  async function publicRoleIsolation(): Promise<boolean> {
    // #633 — the Admin API made public_role a member of cloudsqlsuperuser.
    // Revoked here, before migrations, because the migration job's role
    // audit is what verifies it and fails the upgrade while it remains.
    const s = r.step("Removing public_role from the Cloud SQL superuser group...");
    const outcome = await revokePublicRoleMemberships(
      { projectId: install.projectId, env: install.env, credentials: install.credentials },
      runDeps,
    );
    if (outcome.status === "failed") {
      s.failed("public_role's role memberships could not be revoked. Aborting upgrade.");
      r.error(`  ${outcome.error ?? ""}`);
      r.warn("No traffic was shifted and no migrations ran. Fix the above and re-run.");
      return false;
    }
    s.done(`public_role holds no database roles (${outcome.detail ?? "revoked"})`);
    return true;
  }

  async function mcpAccess(): Promise<void> {
    // Issue #37 — the MCP service account + its IAP/token-creator bindings.
    // Also what the deep health check signs its IAP credential as. A failure
    // costs MCP access, so it warns and the admin keeps its current value.
    const s = r.step("Ensuring MCP access through IAP...");
    // Signing as the MCP account goes through the IAM Credentials API, which
    // installs from before #678 may not have enabled.
    const api = await run([
      "services",
      "enable",
      "iamcredentials.googleapis.com",
      `--project=${install.projectId}`,
    ]);
    const resource = api.ok ? await adminIapResource() : null;
    const mcp = !api.ok
      ? {
          ok: false as const,
          error: `enable the IAM Credentials API (iamcredentials.googleapis.com): ${api.stderr.trim()}`,
        }
      : resource
        ? await ensureMcpIapAccess({ projectId: install.projectId, resource, ...runDeps })
        : { ok: false as const, error: "admin IAP backend service not found" };
    if (mcp.ok) {
      s.done(`MCP access ready (${mcp.serviceAccount}; ${mcp.operators.length} operator(s))`);
      if (mcp.granted.length > 0) accessChanged = true;
      for (const g of mcp.granted) r.info(`  granted: ${g}`);
      return;
    }
    s.warned(`MCP access not configured: ${mcp.error}`);
    r.warn("The upgrade continues; external MCP clients stay blocked by IAP until this succeeds.");
    incomplete = true;
    leaveUntouched.push(MCP_ENV_VAR);
  }

  async function urlMapRedirectsAccess(): Promise<void> {
    // #587 — on `gcp` the admin writes the redirects table into the URL map
    // on Confirm-publish, through a custom role the stack declares. Without
    // it Confirm-publish fails loudly (403); the rest of the install works,
    // so a failure here warns.
    if (install.provider !== "gcp") return;
    const s = r.step("Ensuring the admin may write redirects into the URL map...");
    const access = await ensureUrlMapRedirectsAccess({
      projectId: install.projectId,
      env: install.env,
      ...runDeps,
    });
    if (access.ok) {
      s.done(`URL-map redirects role ready (${access.role})`);
      return;
    }
    s.warned(`URL-map redirects role not set up: ${access.error}`);
    r.warn(
      "The upgrade continues; Confirm-publish fails with a permission error until this succeeds. Re-run upgrade with an account that may manage IAM roles.",
    );
    incomplete = true;
  }

  async function auditJob(): Promise<void> {
    // #875 — the job the quality audit fans its Lighthouse runs out to.
    // Deployed with the admin's CURRENT image (the admin still runs it until
    // the app-roll moves both together, and the job refuses a batch from
    // another version). A failure only costs Stage audits, so it warns and
    // the admin keeps its current env.
    const s = r.step("Ensuring the quality-audit job (parallel Lighthouse runs)...");
    const image = await resolveAdminImage(
      { projectId: install.projectId, region: install.region, env: install.env },
      { run },
    );
    const aj = image.ok
      ? await ensureAuditJob(
          {
            provider: install.provider,
            projectId: install.projectId,
            region: install.region,
            env: install.env,
            adminImageRef: image.imageRef,
          },
          runDeps,
        )
      : { ok: false as const, done: [], error: image.error };
    for (const step of aj.done) r.info(`  ${step}`);
    if (aj.ok) {
      s.done("Quality-audit job ready (Stage audits run in parallel)");
      return;
    }
    s.warned(`Quality-audit job not set up: ${aj.error}`);
    r.warn(
      "The upgrade continues; Stage audits fail with the missing job until this succeeds. Re-run upgrade once the cause is fixed.",
    );
    incomplete = true;
    leaveUntouched.push(AUDIT_JOB_ENV_VAR, AUDIT_RESULTS_BUCKET_ENV_VAR);
  }

  async function captureJob(): Promise<void> {
    // #1217 — the job every server-side browser render runs in, so no
    // Chromium runs in the admin. Deployed with the admin's CURRENT image
    // (the app-roll then moves both together; the job refuses an order from
    // another version). A failure only costs server-side screenshots, so it
    // warns and the admin keeps its current env.
    const s = r.step("Ensuring the capture job (server-side screenshots outside the admin)...");
    const image = await resolveAdminImage(
      { projectId: install.projectId, region: install.region, env: install.env },
      { run },
    );
    const cj = image.ok
      ? await ensureCaptureJob(
          {
            provider: install.provider,
            projectId: install.projectId,
            region: install.region,
            env: install.env,
            adminImageRef: image.imageRef,
          },
          runDeps,
        )
      : { ok: false as const, done: [], error: image.error };
    for (const step of cj.done) r.info(`  ${step}`);
    if (cj.ok) {
      s.done("Capture job ready (screenshots run outside the admin)");
      return;
    }
    s.warned(`Capture job not set up: ${cj.error}`);
    r.warn(
      "The upgrade continues; server-side screenshots fail with the missing job until this succeeds. Re-run upgrade once the cause is fixed.",
    );
    incomplete = true;
    leaveUntouched.push(CAPTURE_JOB_ENV_VAR, CAPTURE_BUCKET_ENV_VAR);
  }

  async function remoteMcpEdge(): Promise<void> {
    // #806 — on `gcp` the load balancer routes the remote-MCP discovery
    // paths to the gateway and Cloud Armor lets agent traffic through on
    // /api/mcp/* (remote-mcp-edge.ts). Only remote MCP depends on it, so a
    // failure warns.
    if (install.provider !== "gcp") return;
    const s = r.step("Ensuring the load balancer's remote-MCP routes and Cloud Armor rule...");
    const edge = await ensureRemoteMcpEdge(
      {
        provider: install.provider,
        projectId: install.projectId,
        env: install.env,
        domain: install.domain,
      },
      { ...runDeps, ...(deps.http ? { http: deps.http } : {}) },
    );
    if (edge.ok) {
      for (const line of edge.done) r.info(`  ${line}`);
      s.done("Remote-MCP load-balancer rules ready");
      return;
    }
    s.warned(`Remote-MCP load-balancer rules not set up: ${edge.error}`);
    r.warn(
      "The upgrade continues; remote MCP (Settings → MCP → Remote) cannot be reached through the site's domain until this succeeds. Re-run upgrade once the cause is fixed.",
    );
    incomplete = true;
  }

  async function remoteMcpIdentity(): Promise<Record<RollSlug, CloudRunEnvVar[]> | null> {
    // #806 — CAELO_ADMIN_URL / CAELO_MCP_PUBLIC_URL / CAELO_IAP_AUDIENCE
    // name identities the env contract cannot (stack-contract.ts
    // RemoteMcpIdentity). Resolved here, read-only, and set by the rolls
    // (AppRollHooks.afterMigrations `extraEnv`), so they ride the new
    // revisions. The stack declares the same derived values from the config
    // the installer writes before `up` (#1082), so neither writer undoes the
    // other. A failure leaves the vars as the services have them and warns:
    // only remote MCP depends on them.
    const s = r.step("Resolving the remote-MCP URLs and IAP audience...");
    const resolved = await resolveRemoteMcpIdentity(
      {
        provider: install.provider,
        projectId: install.projectId,
        region: install.region,
        env: install.env,
        domain: install.domain,
        services,
      },
      runDeps,
    );
    if (resolved.ok) {
      s.done(
        `Google sign-in and remote MCP can be set up under Settings → Google sign-in (${resolved.identity.mcpPublicUrl})`,
      );
      if (resolved.orgDomainError) {
        // #914 — the admin then refuses new users until Google sign-in is
        // set up (it cannot tell who IAP's built-in sign-in admits). Not a
        // converge failure: the Owner's sign-in setup resolves it.
        r.warn(
          `Could not read this project's Google organisation (${resolved.orgDomainError}). Until Google sign-in is set up under Settings → Google sign-in, the admin refuses to add users; or re-run upgrade as an account with the Organization Viewer role.`,
        );
      }
      return remoteMcpIdentityEnv(resolved.identity);
    }
    s.warned(`Remote-MCP env not resolved: ${resolved.error}`);
    r.warn(
      "The upgrade continues; Settings → Google sign-in and Settings → MCP report this install as not prepared until this succeeds. Re-run upgrade once the cause is fixed.",
    );
    incomplete = true;
    return null;
  }

  /** The admin's IAP resource: the service on gcp-firebase, the LB backend on gcp. */
  async function adminIapResource(): Promise<IapResource | null> {
    if (install.provider === "gcp-firebase") {
      return { kind: "cloud-run", service: services.admin, region: install.region };
    }
    const res = await run([
      "compute",
      "backend-services",
      "list",
      "--global",
      `--project=${install.projectId}`,
      `--filter=name~^caelo-${install.env}-admin-backend`,
      "--format=value(name)",
    ]);
    const name = res.ok ? res.stdout.trim().split("\n")[0]?.trim() : "";
    return name ? { kind: "backend-services", service: name } : null;
  }

  async function databaseLogins(): Promise<boolean> {
    // #613 — public_role moves onto its own password right before the
    // gateway's roll. The gateway has no other database login (#635).
    const s = r.step("Preparing the gateway's database login (public_role)...");
    const lookup = await findSqlInstance(install, { run });
    if (lookup.status !== "found") {
      s.failed(
        `${lookupFailure(lookup, "Cloud SQL instance", install.credentials)}. Aborting upgrade.`,
      );
      r.warn("Migrations ran; no traffic was shifted. Re-run upgrade once the instance is found.");
      return false;
    }
    const sqlInstance = lookup.name;
    const roleTarget = { projectId: install.projectId, env: install.env, sqlInstance };
    const roleDeps = { ...runDeps, ...(deps.http ? { http: deps.http } : {}) };
    s.done("public_role ready to switch");
    publicRole = planPublicRoleSwitch(roleTarget, service("gateway").liveEnv, roleDeps);
    return true;
  }

  let upgraderReady = false;
  /** The upgrader's SA exists from an earlier run though this one failed. */
  let upgraderSignerExists = false;

  async function upgraderJob(): Promise<void> {
    // #696 — the job "Install update" starts. After migrations: its
    // database user gets the role migration 0267 creates. Before the
    // operator-access step, which must keep its caelo-mcp signing grant.
    // A failure only costs in-product updates, so it warns.
    const s = r.step("Ensuring the upgrader job (Settings → Updates → Install update)...");
    const resolved = deps.opsImageRef
      ? await resolveUpgraderTarget(
          {
            projectId: install.projectId,
            region: install.region,
            env: install.env,
            opsImageRef: deps.opsImageRef,
          },
          { run },
        )
      : { ok: false as const, error: "the release's caelo-ops image could not be resolved" };
    const up = resolved.ok
      ? await ensureUpgraderJob(resolved.target, runDeps)
      : { ok: false as const, done: [], error: resolved.error };
    for (const step of up.done) r.info(`  ${step}`);
    if (up.ok) {
      upgraderReady = true;
      s.done("Upgrader job ready (the Owner can install updates from the admin)");
      return;
    }
    // An upgrader set up by an earlier run keeps its caelo-mcp grant, or
    // the next sync would take away its health check (a failure here is
    // often transient; its job and the admin's env stay as they were too).
    const sa = upgraderServiceAccountEmail(install.projectId, install.env);
    const exists = await run([
      "iam",
      "service-accounts",
      "describe",
      sa,
      `--project=${install.projectId}`,
      "--format=value(email)",
    ]);
    upgraderSignerExists = exists.ok;
    s.warned(`Upgrader job not set up: ${up.error}`);
    r.warn(
      "The upgrade continues; Settings → Updates keeps showing the command to run instead of an Install button until this succeeds.",
    );
    incomplete = true;
    leaveUntouched.push(UPGRADER_JOB_ENV_VAR);
  }

  async function convergeJob(): Promise<void> {
    // #819 — the job "Install update" starts for the next release that
    // changes the cloud setup, on this release's ops image. After
    // migrations: its database login gets the role migration 0267 creates.
    // A failure only costs in-Caelo converges (the terminal path stays), so
    // it warns.
    const s = r.step("Ensuring the converge job (cloud-setup updates from Settings → Updates)...");
    const resolved = deps.opsImageRef
      ? await resolveUpgraderTarget(
          {
            projectId: install.projectId,
            region: install.region,
            env: install.env,
            opsImageRef: deps.opsImageRef,
          },
          { run },
        )
      : { ok: false as const, error: "the release's caelo-ops image could not be resolved" };
    const cj = resolved.ok
      ? await ensureConvergeJob(resolved.target, runDeps)
      : { ok: false as const, done: [], error: resolved.error };
    for (const step of cj.done) r.info(`  ${step}`);
    if (cj.ok) {
      s.done("Converge job ready (updates that change the cloud setup install from the admin)");
      return;
    }
    if (cj.reason === "no-provisioner") {
      // #883 review — optional for contract 9: an install without a
      // provisioner (installed before it existed) has nothing the job could
      // run as, and creating one is a privileged identity no update should
      // mint. It stays fully converged; its admin keeps no
      // CAELO_CONVERGE_JOB and so routes cloud-setup releases to the
      // terminal, saying so on Settings → Updates.
      s.done("No converge job: this install has no caelo-provisioner to run it as");
      r.info(
        "Updates that change the cloud setup keep installing from Cloud Shell or the computer you installed from; Settings → Updates says so when one comes.",
      );
      leaveUntouched.push(CONVERGE_JOB_ENV_VAR);
      return;
    }
    s.warned(`Converge job not set up: ${cj.error}`);
    r.warn(
      "The upgrade continues; releases that change the cloud setup keep installing from a terminal until this succeeds.",
    );
    incomplete = true;
    leaveUntouched.push(CONVERGE_JOB_ENV_VAR);
  }

  async function operatorAccess(): Promise<void> {
    // The job that keeps IAP in step with the user list (operator-access.ts).
    // After migrations: its database user gets the role migration 0239
    // creates. A failure only costs IAP following the user list, so it warns.
    const s = r.step("Ensuring the operator-access sync job...");
    const resolved = await resolveOperatorAccessTarget(
      {
        provider: install.provider,
        projectId: install.projectId,
        region: install.region,
        env: install.env,
        ownerEmail,
        imageRef: service("admin").imageRef,
      },
      { run },
    );
    const oa = resolved.ok
      ? await ensureOperatorAccessSync(
          {
            ...resolved.target,
            ...(upgraderReady || upgraderSignerExists
              ? {
                  mcpSigners: [
                    `serviceAccount:${upgraderServiceAccountEmail(install.projectId, install.env)}`,
                  ],
                }
              : {}),
          },
          runDeps,
        )
      : { ok: false as const, done: [], error: resolved.error };
    for (const step of oa.done) r.info(`  ${step}`);
    if (oa.ok) {
      s.done("Operator-access sync job ready (IAP follows the user list)");
      return;
    }
    s.warned(`Operator-access sync job not set up: ${oa.error}`);
    r.warn(
      "The upgrade continues; user changes will report that Google IAP could not be updated until this succeeds. Re-run upgrade once the cause is fixed.",
    );
    incomplete = true;
    leaveUntouched.push(OPERATOR_ACCESS_JOB_ENV_VAR);
  }

  return {
    async beforeAppRoll() {
      if (deps.provisionerIdentity && !(await deps.provisionerIdentity())) return false;
      if (!(await runtimeIdentities())) return false;
      if (!(await stackInvariants())) return false;
      if (!(await publicRoleIsolation())) return false;
      await mcpAccess();
      await urlMapRedirectsAccess();
      await auditJob();
      await captureJob();
      await remoteMcpEdge();
      return true;
    },

    hooks: {
      async afterMigrations() {
        if (!(await databaseLogins())) return { ok: false };
        await upgraderJob();
        await convergeJob();
        await operatorAccess();
        const extraEnv = await remoteMcpIdentity();
        return {
          ok: true,
          leaveUntouched: [...leaveUntouched],
          ...(extraEnv ? { extraEnv } : {}),
        };
      },
      async beforeRoll(slug) {
        if (slug !== "gateway" || !publicRole) return { ok: true };
        const moved = await publicRole.beforeGatewayRoll();
        return moved.status === "failed"
          ? {
              ok: false,
              error: `public_role could not be moved onto its own password: ${moved.error ?? ""}`,
            }
          : { ok: true };
      },
      async afterRollback(slug) {
        // The prior gateway revision reads public_role's old password.
        if (slug !== "gateway" || !publicRole) return;
        const outcome = await publicRole.afterGatewayRollFailed();
        if (outcome.startsWith("could NOT")) r.error(`  ${outcome}`);
        else r.info(`  ${outcome}`);
      },
    },

    async afterAppRoll() {
      // #613 — with both services on their new revisions, drop the bindings
      // nothing reads through any more (above all the gateway SA's access to
      // admin_role's password). Loud on failure.
      const retired = [
        ...(await removeRetiredIamBindings(target, runDeps)),
        // #914 — secrets nothing references any more (the renamed Google
        // sign-in client); their IAM bindings go with them.
        ...(await deleteRetiredSecrets(target, runDeps)),
      ];
      for (const o of retired) {
        if (o.status === "removed") r.info(`  removed: ${o.id} (${o.why})`);
        if (o.status === "failed") {
          incomplete = true;
          r.error(
            `  NOT removed: ${o.id} — ${o.why}\n    ${o.error ?? ""}\n    Re-run upgrade with an account that may change IAM and secrets, or remove it by hand.`,
          );
        }
      }
      if (publicRole?.moves) {
        // Until this upgrade the gateway held admin_role's password; anyone
        // who ever compromised it could have kept a copy.
        r.warn(
          `The gateway no longer holds admin_role's password, but it did until now. Rotate it: ${selfCommand("rotate-secret", "postgres-password", "--install", install.domain)}`,
        );
      }
      if (plan.services.some((s) => liveEnvHasInlinePassword(s.liveEnv))) {
        // The services moved their database password to Secret Manager, but
        // every earlier revision still shows it in its env.
        r.warn(
          `The database password was stored in plain env vars before this upgrade and stays readable in the services' old revisions. Rotate it now: ${selfCommand("rotate-secret", "postgres-password", "--install", install.domain)}`,
        );
      }
    },

    complete: () => !incomplete,
    accessJustChanged: () => accessChanged,
  };
}
