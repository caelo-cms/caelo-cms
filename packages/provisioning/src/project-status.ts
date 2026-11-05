// SPDX-License-Identifier: MPL-2.0

/**
 * `cms-provision status --project <id>` (#822): where an install stands, on
 * any machine. The install job keeps running after the Cloud Shell tab is
 * gone, and a reset Cloud Shell has no `~/.caelo-*` left, so this command
 * needs nothing but a signed-in gcloud identity: it reads the project
 * (install.json, install-job.json and progress.json in the ops bucket, the
 * Owner setup link and token in Secret Manager) and writes nothing, here or
 * there.
 *
 * The setup link is a secret (#656). It goes to a terminal only: with stdout
 * piped or redirected it stays unprinted, so it can't land in a CI log or a
 * file. Once Owner setup is done the command says so instead of showing a
 * used link; a link past its 24 hours (#1476) is not shown either.
 *
 * `setup-link --project <id>` is the one command here that writes: what a
 * late Owner runs for a new link ({@link setupLinkCommand}).
 */

import type { OwnerBootstrapToken } from "@caelo-cms/shared";
import { log } from "@clack/prompts";
import { bold, cyan, dim, green, red, yellow } from "kleur/colors";
import { z } from "zod";
import type { AdminInternalResult, GoogleAdminTarget } from "./admin-internal.js";
import { readOwnerSetupState } from "./admin-internal-google.js";
import {
  type DnsRecordGroups,
  formatDnsRecordGroups,
  groupDnsRecords,
  type InstallDnsRecord,
} from "./dns/groups.js";
import { checkRecord } from "./dns/manual.js";
import { checkGcloudAuth, gcloud } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import {
  INSTALL_SETUP_LINK_SECRET,
  isGcpProjectId,
  readRecordedStackOutputs,
  readSetupLink,
  recordedDnsRecords,
} from "./install-job.js";
import {
  issueOwnerSetup,
  type OwnerSetupIssued,
  readOwnerBootstrapToken,
} from "./owner-setup-token.js";
import { selfCommand } from "./self-command.js";
import { readProjectInstall } from "./state-attach.js";
import { realSyncGcloud, type SyncGcloud } from "./state-store.js";
import {
  type InstallJobView,
  installerCommand,
  installJobViewLines,
  readInstallJobView,
} from "./wizards/gcp-install-job.js";

/** The parts of install.json this command reads. */
const InstallRecordSchema = z.object({
  installId: z.string().min(1),
  provider: z.enum(["gcp", "gcp-firebase"]),
  domain: z.string().min(1),
  ownerEmail: z.string().min(1),
  projectId: z.string().min(1),
  region: z.string().min(1).nullable().default(null),
});
type InstallRecord = z.infer<typeof InstallRecordSchema>;

/** The DNS records of an install that public DNS does not answer yet. */
export interface DnsToSet extends DnsRecordGroups<InstallDnsRecord> {
  /** How many records the install knows about, set or not; 0 before the stack ran. */
  readonly total: number;
}

/** Where Owner setup stands, as far as this command can tell. */
export type OwnerSetup =
  /** The install has not got far enough for a link to exist. */
  | { readonly kind: "not-yet" }
  /** An Owner exists; the link is used. */
  | { readonly kind: "done" }
  /** Setup is open, or could not be checked ({@link unverified} says why). */
  | {
      readonly kind: "link";
      readonly link: string;
      readonly expiresAt: string;
      readonly unverified: string | null;
    }
  /** A link exists, but stdout is not a terminal. */
  | { readonly kind: "withheld"; readonly expiresAt: string }
  /**
   * A link exists but cannot work: its token expired on {@link expiresAt}, or
   * (null) the admin has no token for it, the case of an install that finished
   * before #1476 and whose admin now refuses `/setup` until it has one.
   */
  | { readonly kind: "stale"; readonly expiresAt: string | null }
  /** No link in Secret Manager. */
  | { readonly kind: "no-link" }
  /** Reading the link failed; the message says what the account needs. */
  | { readonly kind: "error"; readonly message: string };

/** Everything `status --project` shows. */
export interface ProjectStatus {
  readonly install: InstallRecord;
  readonly job: InstallJobView | null;
  /** Whether the stack ran (its outputs are recorded). */
  readonly provisioned: boolean;
  readonly adminUrl: string | null;
  readonly dns: DnsToSet;
  readonly owner: OwnerSetup;
}

/** Side effects of {@link readProjectStatus}, injectable for tests. */
export interface ProjectStatusDeps {
  readonly run: GcloudRunner;
  readonly syncRun: SyncGcloud;
  /** Whether public DNS answers the record with its value. */
  readonly resolves: (record: InstallDnsRecord) => Promise<boolean>;
  /** Whether the admin still offers Owner setup ({@link readOwnerSetupState}). */
  readonly ownerSetupState: (
    target: GoogleAdminTarget,
  ) => Promise<AdminInternalResult<"open" | "done">>;
  /** Whether stdout is a terminal: the only place the setup link may go. */
  readonly isTerminal: boolean;
  /** The current time in ms. */
  readonly now: () => number;
}

/** The admin's origin from the stack's outputs; null before the stack ran. */
export function adminUrlFromOutputs(
  provider: InstallRecord["provider"],
  outputs: Record<string, unknown>,
): string | null {
  // gcp-firebase binds admin.<domain> only on request; the setup link and
  // the install's summary use the Cloud Run URL there (wizards/gcp.ts).
  if (provider === "gcp-firebase") {
    const url = outputs.adminCloudRunUrlOut;
    return typeof url === "string" && url !== "" ? url : null;
  }
  const host = outputs.adminDomainOut;
  return typeof host === "string" && host !== "" ? `https://${host}` : null;
}

/**
 * Split `records` by what still has to happen: a record public DNS already
 * answers is dropped, the rest fall into {@link groupDnsRecords}'s two groups.
 */
export async function dnsRecordsToSet(
  records: readonly InstallDnsRecord[],
  domain: string,
  resolves: ProjectStatusDeps["resolves"],
): Promise<DnsToSet> {
  const unique = [
    ...new Map(records.map((r) => [`${r.type}:${r.hostname}:${r.value}`, r])).values(),
  ];
  const answered = await Promise.all(unique.map(resolves));
  const open = unique.filter((_, i) => !answered[i]);
  return { ...groupDnsRecords(open, domain), total: unique.length };
}

/** Where {@link readOwnerSetupState} reaches the admin; null without a recorded region. */
function adminTarget(install: InstallRecord): GoogleAdminTarget | null {
  const { provider, projectId, domain, region } = install;
  if (provider === "gcp") return { provider, projectId, domain };
  return region ? { provider, projectId, region } : null;
}

async function readOwnerSetup(
  args: {
    readonly install: InstallRecord;
    readonly adminUrl: string | null;
    readonly job: InstallJobView | null;
    readonly provisioned: boolean;
  },
  deps: ProjectStatusDeps,
): Promise<OwnerSetup> {
  const unfinished = args.job ? args.job.decision.kind !== "done" : !args.provisioned;
  if (unfinished || args.adminUrl === null) return { kind: "not-yet" };
  let link: string | null;
  let token: OwnerBootstrapToken | null;
  try {
    link = await readSetupLink(deps.run, args.install.projectId);
    token = await readOwnerBootstrapToken(deps.run, args.install.projectId);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
  if (link === null) return { kind: "no-link" };
  const target = adminTarget(args.install);
  const state: AdminInternalResult<"open" | "done"> = target
    ? await deps.ownerSetupState(target)
    : { ok: false, error: "install.json records no region" };
  if (state.ok && state.value === "done") return { kind: "done" };
  if (token === null) return { kind: "stale", expiresAt: null };
  if (Date.parse(token.expiresAt) <= deps.now()) {
    return { kind: "stale", expiresAt: token.expiresAt };
  }
  if (!deps.isTerminal) return { kind: "withheld", expiresAt: token.expiresAt };
  return {
    kind: "link",
    link,
    expiresAt: token.expiresAt,
    unverified: state.ok ? null : state.error,
  };
}

/**
 * Read where the install in `projectId` stands from the project alone.
 *
 * @throws when a read fails, with what to do about it
 */
export async function readProjectStatus(
  projectId: string,
  deps: ProjectStatusDeps,
): Promise<ProjectStatus> {
  const record = readProjectInstall(projectId, deps.syncRun);
  if (!record.ok) throw new Error(record.error);
  const parsed = InstallRecordSchema.safeParse(JSON.parse(record.text));
  if (!parsed.success) {
    throw new Error(
      `install.json of ${projectId} is not a Google Cloud install this CLI understands (${parsed.error.message}). Run this command with the CLI of the release the install runs.`,
    );
  }
  const install = parsed.data;
  const job = await readInstallJobView(install, deps);
  const outputs = readRecordedStackOutputs(projectId, deps.syncRun);
  const provisioned = Object.keys(outputs).length > 0;
  const adminUrl = adminUrlFromOutputs(install.provider, outputs);
  const dns = await dnsRecordsToSet(
    [...recordedDnsRecords(outputs), ...(job?.status.dnsRecords ?? [])],
    install.domain,
    deps.resolves,
  );
  const owner = await readOwnerSetup({ install, adminUrl, job, provisioned }, deps);
  return { install, job, provisioned, adminUrl, dns, owner };
}

function jobLines(s: ProjectStatus): string[] {
  if (s.job) return installJobViewLines(s.job, s.install);
  return s.provisioned
    ? ["Install job: none. This install ran from a terminal, not through the job."]
    : [`Install job: not started. Start or resume it: ${installerCommand(s.install)}`];
}

function dnsLines(s: ProjectStatus): string[] {
  const { dns, install } = s;
  if (dns.total === 0) {
    return ["DNS:     not known yet; the install reports its records once its resources exist."];
  }
  const lines =
    dns.setNow.length + dns.atGoLive.length === 0
      ? [`DNS:     ${green(`all set (${dns.total} of ${dns.total}).`)}`]
      : [
          `DNS records still to set for ${bold(install.domain)}:`,
          ...formatDnsRecordGroups(dns, install.domain).map((l) => `  ${l}`),
        ];
  // The staging host's records reach the status document only through the
  // job; a terminal install or an older job recorded none there.
  if (!s.job?.status.dnsRecords) {
    lines.push(dim("  The staging host's records are under Settings → Updates in the admin."));
  }
  return lines;
}

function ownerLines(s: ProjectStatus): string[] {
  const { owner, install, adminUrl } = s;
  const newLink = selfCommand("setup-link", "--project", install.projectId);
  switch (owner.kind) {
    case "not-yet":
      return ["Owner setup: the link appears here when the install has finished."];
    case "done":
      return [`Owner setup: ${green("done.")} Sign in at ${cyan(adminUrl ?? "")}`];
    case "withheld":
      return [
        `Owner setup: ${yellow(`a link is stored, valid until ${owner.expiresAt}, but it is a secret and only goes to a terminal.`)} Run this command in your own terminal, without a pipe or redirect.`,
      ];
    case "stale":
      return [
        `Owner setup: ${yellow(owner.expiresAt ? `the stored link expired on ${owner.expiresAt}.` : "the stored link has no token the admin can use.")} Nobody can use it. Get a new one: ${newLink}`,
      ];
    case "no-link":
      return [
        `Owner setup: no link is stored in this project (${INSTALL_SETUP_LINK_SECRET}). If Owner setup is done, sign in at ${cyan(adminUrl ?? "")}`,
        `  If it is not, this stores a link and prints it: ${newLink}`,
      ];
    case "error":
      return [`Owner setup: ${red(owner.message)}`];
    case "link":
      return [
        `Owner setup: open this link in your browser, signed in as ${install.ownerEmail}. Do not share it. It works until ${owner.expiresAt}, then: ${newLink}`,
        `  ${bold(cyan(owner.link))}`,
        ...(owner.unverified === null
          ? []
          : [
              yellow(
                `  Could not check whether it was already used (${owner.unverified}). A used link just opens the sign-in page.`,
              ),
            ]),
      ];
  }
}

/** {@link ProjectStatus} as text. Holds the setup link only for {@link OwnerSetup} `link`. */
export function projectStatusLines(s: ProjectStatus): string[] {
  return [
    `Install: ${bold(s.install.installId)} ${dim(`(${s.install.provider})`)}`,
    `Domain:  ${bold(s.install.domain)}`,
    `Project: ${bold(s.install.projectId)}`,
    ...jobLines(s),
    `Admin:   ${s.adminUrl ? cyan(s.adminUrl) : "not known yet"}`,
    ...dnsLines(s),
    ...ownerLines(s),
  ];
}

/** What to tell the operator about a failure of the command. */
export function projectStatusFailure(e: unknown): string {
  if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return "gcloud is not installed on this machine. Install the Google Cloud CLI (https://cloud.google.com/sdk/docs/install) or use Cloud Shell, run `gcloud auth login`, then run this command again.";
  }
  return e instanceof Error ? e.message : String(e);
}

/** The real {@link ProjectStatusDeps}: the operator's gcloud, public DNS, this process. */
function realProjectStatusDeps(): ProjectStatusDeps {
  return {
    run: gcloud,
    syncRun: realSyncGcloud,
    resolves: checkRecord,
    ownerSetupState: (target) => readOwnerSetupState(target),
    isTerminal: process.stdout.isTTY === true,
    now: Date.now,
  };
}

/**
 * What `setup-link` does for an install in `status`: a line to print and stop
 * on, or null to go on and issue a link. There is nothing to issue before the
 * install finished or after an Owner exists, and a refused read must not
 * read as "no link".
 */
export function setupLinkRefusal(status: ProjectStatus): string | null {
  switch (status.owner.kind) {
    case "not-yet":
      return "The install has not finished. Its last step stores the Owner setup link.";
    case "done":
      return `Owner setup is done; no link is needed. Sign in at ${status.adminUrl ?? "the admin"}.`;
    case "error":
      return status.owner.message;
    default:
      return null;
  }
}

/**
 * Lines of `setup-link`'s result. Holds the link only on a terminal, like
 * {@link projectStatusLines}.
 */
export function setupLinkLines(issued: OwnerSetupIssued, isTerminal: boolean): string[] {
  const state = issued.minted ? "A new link is stored" : "The current link still works";
  return isTerminal
    ? [
        `${state}, until ${issued.expiresAt}. Open it in your browser. Do not share it.`,
        `  ${bold(cyan(issued.link))}`,
      ]
    : [`${state}, until ${issued.expiresAt}. It is a secret and only goes to a terminal.`];
}

/**
 * `setup-link --project <id>` (#1476): a working Owner setup link for an
 * install without an Owner, from any signed-in terminal. Exit 1 when none
 * could be given.
 */
export async function setupLinkCommand(argv: readonly string[]): Promise<void> {
  const projectId = argv[argv.indexOf("--project") + 1] ?? "";
  if (!argv.includes("--project") || !isGcpProjectId(projectId)) {
    console.error("Usage: cms-provision setup-link --project <gcp-project-id>");
    process.exit(2);
  }
  try {
    const auth = await checkGcloudAuth();
    if (!auth.ok) throw new Error(auth.error);
    const deps = realProjectStatusDeps();
    const status = await readProjectStatus(projectId, deps);
    const refusal = setupLinkRefusal(status);
    if (refusal !== null) {
      console.log(refusal);
      if (status.owner.kind !== "done") process.exitCode = 1;
      return;
    }
    const { region } = status.install;
    if (region === null || status.adminUrl === null) {
      throw new Error(`install.json of ${projectId} records no region or admin URL.`);
    }
    const issued = await issueOwnerSetup(deps.run, { projectId, region }, status.adminUrl);
    if (!issued.ok) throw new Error(issued.error);
    for (const line of setupLinkLines(issued, deps.isTerminal)) console.log(line);
  } catch (e) {
    log.error(red(projectStatusFailure(e)));
    process.exit(1);
  }
}

/** `status --project <id>`: print where the install stands; exit 1 when part of it can't be read. */
export async function projectStatusCommand(argv: readonly string[]): Promise<void> {
  const projectId = argv[argv.indexOf("--project") + 1] ?? "";
  if (!isGcpProjectId(projectId) || argv.includes("--install")) {
    console.error("Usage: cms-provision status --project <gcp-project-id>");
    process.exit(2);
  }
  try {
    const auth = await checkGcloudAuth();
    if (!auth.ok) throw new Error(auth.error);
    const status = await readProjectStatus(projectId, realProjectStatusDeps());
    for (const line of projectStatusLines(status)) console.log(line);
    if (status.owner.kind === "error") process.exitCode = 1;
  } catch (e) {
    log.error(red(projectStatusFailure(e)));
    process.exit(1);
  }
}
